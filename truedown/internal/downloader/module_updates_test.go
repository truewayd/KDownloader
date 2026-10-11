package downloader

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"truedown/internal/modulehost"
	"truedown/internal/safefile"
)

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
	manifest, err := modulehost.DecodeManifest(raw, "mega")
	if err != nil {
		t.Fatal(err)
	}
	root := artifactTempDir(t)
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	installed, err := modulehost.InstallSigned(m.executableRoot("mega"), "mega", "0.1.0", raw, signature, modulePublicKey(), bytes.NewReader(binary))
	if err != nil {
		t.Fatal(err)
	}
	if err := m.activateExecutable(context.Background(), "mega", installed, manifest.Version); err != nil {
		t.Fatal(err)
	}
	active, version, err := m.activeExecutable("mega")
	if err != nil || version != manifest.Version || active != installed {
		t.Fatalf("activation: %v", err)
	}
	if _, err := m.ResetModulePackage("mega"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.activeExecutable("mega"); !os.IsNotExist(err) {
		t.Fatal("baseline reset retained activation pointer")
	}
	baseline, err := m.moduleExecutable("mega")
	if err != nil || baseline == installed {
		t.Fatalf("baseline fallback: %v", err)
	}
}
