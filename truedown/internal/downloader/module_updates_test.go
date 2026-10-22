package downloader

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"truedown/internal/modulehost"
	"truedown/internal/safefile"
)

func TestBundledMEGAVersionWinsOverOlderActivePointer(t *testing.T) {
	root := artifactTempDir(t)
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	pointer := filepath.Join(m.executableRoot("mega"), "active.json")
	if err := modulehost.MakeDirectory(filepath.Dir(pointer)); err != nil {
		t.Fatal(err)
	}
	before := []byte(`{"version":"0.1.1"}`)
	if err := safefile.WriteFile(pointer, before, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.activeExecutable("mega"); !os.IsNotExist(err) {
		t.Fatalf("older module remained selectable: %v", err)
	}
	executable, err := m.moduleExecutable("mega")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := modulehost.Connect(ctx, exec.Command(executable), "mega")
	if err != nil {
		t.Fatal(err)
	}
	defer retireModule(client)
	if client.Info.Version != m.modules.baseline["mega"].packageInfo.Version || !moduleCapability(client.Info, "public-folder-v1") {
		t.Fatal("bundled executable version or folder capability differs from its registry")
	}
	after, _ := os.ReadFile(pointer)
	if !bytes.Equal(before, after) {
		t.Fatal("baseline fallback destroyed the recoverable activation pointer")
	}
}

func TestModuleUpdateProgressSnapshotDoesNotExposeMutableState(t *testing.T) {
	m := &Manager{moduleUpdateState: ModuleUpdateState{ID: "mega", Phase: "downloading", Running: true, Download: &ModuleUpdateProgress{TaskID: 42, Status: StatusDownloading, CompletedLength: 1024, TotalLength: 4096}}}
	state := m.ModuleUpdateStatus()
	state.Download.CompletedLength = 4096
	current := m.ModuleUpdateStatus()
	if current.ID != "mega" || current.Phase != "downloading" || current.Download.CompletedLength != 1024 {
		t.Fatal("public module progress changed the running updater")
	}
}

func TestModuleActivationHealthFailurePreservesCurrentVersion(t *testing.T) {
	modules, _ := artifactHelper(t)
	root := artifactTempDir(t)
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	entry := "truedown-mega"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	executable := filepath.Join(modules, "mega", entry)
	pointer := filepath.Join(m.executableRoot("mega"), "active.json")
	if err := modulehost.MakeDirectory(filepath.Dir(pointer)); err != nil {
		t.Fatal(err)
	}
	before := []byte(`{"version":"0.1.1"}`)
	if err := safefile.WriteFile(pointer, before, 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.activateExecutable(context.Background(), "mega", executable, "0.2.0"); err == nil {
		t.Fatal("wrong-version process activated")
	}
	after, _ := os.ReadFile(pointer)
	if string(after) != string(before) {
		t.Fatal("failed update changed current version")
	}
	t.Setenv("TRUEDOWN_TEST_MODULE_VERSION", "0.2.0")
	if err := m.activateExecutable(context.Background(), "mega", executable, "0.2.0"); err != nil {
		t.Fatal(err)
	}
	after, _ = os.ReadFile(pointer)
	var active moduleActive
	if json.Unmarshal(after, &active) != nil || active.Version != "0.2.0" {
		t.Fatal("healthy version was not activated")
	}
}

func TestSignedExecutableRoundTrip(t *testing.T) {
	directory := os.Getenv("TRUEDOWN_SIGNED_MODULE_TEST_PACKAGE")
	if directory == "" {
		t.Skip("explicit signed release fixture required")
	}
	id := os.Getenv("TRUEDOWN_SIGNED_MODULE_TEST_ID")
	if id == "" {
		id = "mega"
	}
	if !executableModule(id) {
		t.Fatal("unknown executable module fixture")
	}
	raw, err := os.ReadFile(filepath.Join(directory, "executable.json"))
	if err != nil {
		t.Fatal(err)
	}
	signature, err := os.ReadFile(filepath.Join(directory, "executable.sig"))
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(filepath.Join(directory, "provider.bin"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := modulehost.DecodeManifest(raw, id)
	if err != nil {
		t.Fatal(err)
	}
	root := artifactTempDir(t)
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	installed, err := modulehost.InstallSigned(m.executableRoot(id), id, m.modules.baseline[id].packageInfo.Version, raw, signature, modulePublicKey(), bytes.NewReader(binary))
	if err != nil {
		t.Fatal(err)
	}
	if err := m.activateExecutable(context.Background(), id, installed, manifest.Version); err != nil {
		t.Fatal(err)
	}
	active, version, err := m.activeExecutable(id)
	if err != nil || version != manifest.Version || active != installed {
		t.Fatalf("activation: %v", err)
	}
	if _, err := m.ResetModulePackage(id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.activeExecutable(id); !os.IsNotExist(err) {
		t.Fatal("baseline reset retained activation pointer")
	}
	baseline, err := m.moduleExecutable(id)
	if err != nil || baseline == installed {
		t.Fatalf("baseline fallback: %v", err)
	}
}

// This opt-in check exercises anonymous discovery, real aria2 transfer, the
// production trust root, selection across restart and bundled rollback.
func TestPublishedMediaFireUpdate(t *testing.T) {
	want := os.Getenv("TRUEDOWN_TEST_PUBLISHED_MEDIAFIRE_VERSION")
	if want == "" {
		t.Skip("explicit published MediaFire version required")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := artifactTempDir(t)
	newManager := func() *Manager {
		m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), integrationManagerConfig())
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := newManager()
	defer func() { m.Stop() }()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	version, err := m.updateExecutable(ctx, MediaFireModuleID)
	if err != nil || version != want {
		t.Fatalf("published update: version=%s error=%v", version, err)
	}
	selected, active, err := m.activeExecutable(MediaFireModuleID)
	if err != nil || active != want {
		t.Fatalf("selected update: %s %v", active, err)
	}
	client, err := modulehost.Connect(ctx, exec.Command(selected), MediaFireModuleID)
	if err != nil {
		t.Fatal(err)
	}
	if client.Info.Version != want || !executableCapability(MediaFireModuleID, client.Info) {
		retireModule(client)
		t.Fatal("published executable handshake mismatch")
	}
	retireModule(client)
	m.Stop()
	m = newManager()
	if path, version, err := m.activeExecutable(MediaFireModuleID); err != nil || version != want || path != selected {
		t.Fatalf("selection did not survive restart: %s %v", version, err)
	}
	if _, err := m.ResetModulePackage(MediaFireModuleID); err != nil {
		t.Fatal(err)
	}
	baseline, err := m.moduleExecutable(MediaFireModuleID)
	if err != nil || baseline == selected {
		t.Fatalf("baseline restore: %v", err)
	}
	client, err = modulehost.Connect(ctx, exec.Command(baseline), MediaFireModuleID)
	if err != nil {
		t.Fatal(err)
	}
	defer retireModule(client)
	if client.Info.Version != m.modules.baseline[MediaFireModuleID].packageInfo.Version {
		t.Fatal("wrong restored baseline")
	}
	t.Log("Anonymous discovery, real aria2 update, publisher signature, restart selection and baseline restore passed")
}
