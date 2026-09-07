package systemupdate

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNativeReleaseBindsEveryComponentToTheArchiveAndPlatform(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	files := []nativeFile{}
	for _, name := range nativeNames {
		data := nativePayload(name, 2)
		files = append(files, nativeMetadata(name, data))
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"valid", "legacy-schema", "wrong-platform", "wrong-protocol", "archive-hash", "missing-cli"} {
		t.Run(mutation, func(t *testing.T) {
			root := t.TempDir()
			manifest := updateManifest{SchemaVersion: 2, Product: "TrueDown", Repository: "truewayd/KDownloader", Version: "truedown-build-2", Build: 2,
				ProtocolVersion: 1, Platform: "windows-" + runtime.GOARCH, Files: append([]nativeFile(nil), files...)}
			manifest.Asset.Name = "TrueDown-build-2.zip"
			manifest.Asset.Size = int64(archive.Len())
			manifest.Asset.SHA256 = fmt.Sprintf("%x", sha256.Sum256(archive.Bytes()))
			switch mutation {
			case "legacy-schema":
				manifest.SchemaVersion = 1
			case "wrong-platform":
				manifest.Platform = "macos-arm64"
			case "wrong-protocol":
				manifest.ProtocolVersion = 2
			case "archive-hash":
				manifest.Asset.SHA256 = strings.Repeat("0", 64)
			case "missing-cli":
				manifest.Files = append(manifest.Files[:1], manifest.Files[2:]...)
			}
			data, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/manifest" {
					_, _ = w.Write(data)
				} else {
					_, _ = w.Write(archive.Bytes())
				}
			}))
			defer server.Close()
			manager := &Manager{client: server.Client(), nativeExecutable: filepath.Join(root, "TrueDown.exe"), updatesDir: filepath.Join(root, "updates"), statePath: filepath.Join(root, "truedown.updates.json"),
				allowInsecureLoopback: true, trueDownReleasesURL: server.URL, currentBuild: 1, state: persistedState{SchemaVersion: 1, EnginePreference: EngineStable}}
			available := &availableAppUpdate{Version: manifest.Version, Build: 2, ManifestURL: server.URL + "/manifest", ManifestSize: int64(len(data)), ArchiveURL: server.URL + "/archive", ArchiveSize: int64(archive.Len()), ArchiveName: manifest.Asset.Name}
			err = manager.stageTrueDown(context.Background(), available)
			if mutation == "valid" {
				if err != nil {
					t.Fatal(err)
				}
				if manager.state.PendingUpdate == nil || len(manager.state.PendingUpdate.NativeFiles) != len(nativeNames) {
					t.Fatal("complete native stage was not persisted")
				}
			} else if err == nil || manager.state.PendingUpdate != nil {
				t.Fatalf("invalid release was staged: %v", err)
			}
		})
	}
}

func nativeFixture(t *testing.T) (nativeTransaction, string) {
	t.Helper()
	root := t.TempDir()
	application := filepath.Join(root, "Application with spaces")
	profile := filepath.Join(root, "Profile with spaces")
	updates := filepath.Join(profile, "state", "updates")
	stage := filepath.Join(updates, "native-build-2-fixture")
	for _, directory := range []string{application, stage} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	token := strings.Repeat("ab", 24)
	transaction := nativeTransaction{SchemaVersion: 1, Build: 2, Directory: application, Stage: stage,
		StatePath: filepath.Join(profile, "state", "truedown.updates.json"), HealthPath: filepath.Join(updates, "native-health-"+token), Token: token,
		Arguments: []string{"--background", "--data-dir", profile}}
	for _, name := range nativeNames {
		old := nativePayload(name, 1)
		next := nativePayload(name, 2)
		if err := os.WriteFile(filepath.Join(application, name), old, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(stage, name), next, 0700); err != nil {
			t.Fatal(err)
		}
		transaction.Files = append(transaction.Files, nativeReplacement{Old: nativeMetadata(name, old), New: nativeMetadata(name, next)})
	}
	for _, name := range []string{"aria2c.exe", "task.partial", "truedown.db"} {
		if err := os.WriteFile(filepath.Join(application, name), []byte("preserve me"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(updates, "native-apply-"+token+".json")
	if err := validateNativeTransaction(path, transaction); err != nil {
		t.Fatal(err)
	}
	return transaction, path
}

func nativePayload(name string, value byte) []byte {
	data := []byte(strings.Repeat(string([]byte{value}), 128))
	if strings.HasSuffix(name, ".exe") {
		copy(data, "MZ")
		binary.LittleEndian.PutUint32(data[60:], 64)
		copy(data[64:], "PE\x00\x00")
		machine := uint16(0x8664)
		if runtime.GOARCH == "arm64" {
			machine = 0xaa64
		}
		binary.LittleEndian.PutUint16(data[68:], machine)
	}
	return data
}

func nativeMetadata(name string, data []byte) nativeFile {
	return nativeFile{Name: name, Size: int64(len(data)), SHA256: fmt.Sprintf("%x", sha256.Sum256(data))}
}

func TestNativeRollbackRestoresEveryPartialActivation(t *testing.T) {
	for prefix := 0; prefix <= len(nativeNames); prefix++ {
		t.Run(fmt.Sprint(prefix), func(t *testing.T) {
			transaction, _ := nativeFixture(t)
			if err := prepareNativeFiles(transaction); err != nil {
				t.Fatal(err)
			}
			for _, file := range transaction.Files[:prefix] {
				if err := os.Rename(nativeCandidate(transaction, file.New.Name), filepath.Join(transaction.Directory, file.New.Name)); err != nil {
					t.Fatal(err)
				}
			}
			// Repeated recovery is safe, including after rollback interruption.
			for attempt := 0; attempt < 2; attempt++ {
				if err := restoreNativeFiles(transaction); err != nil {
					t.Fatal(err)
				}
			}
			for _, file := range transaction.Files {
				if err := verifyNativeFile(transaction.Directory, file.Old); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{"aria2c.exe", "task.partial", "truedown.db"} {
				data, err := os.ReadFile(filepath.Join(transaction.Directory, name))
				if err != nil || string(data) != "preserve me" {
					t.Fatal("program rollback touched engine or task data")
				}
			}
		})
	}
}

func TestNativePreparationRejectsTamperingBeforeReplacement(t *testing.T) {
	transaction, _ := nativeFixture(t)
	if err := os.WriteFile(filepath.Join(transaction.Stage, "TrueDown.exe"), []byte("tampered"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := prepareNativeFiles(transaction); err == nil {
		t.Fatal("tampered stage accepted")
	}
	for _, file := range transaction.Files {
		if err := verifyNativeFile(transaction.Directory, file.Old); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNativeArchiveRequiresMatchingCompleteRegularFiles(t *testing.T) {
	for _, mutation := range []string{"valid", "missing-core", "duplicate", "traversal", "hash", "architecture"} {
		t.Run(mutation, func(t *testing.T) {
			root := t.TempDir()
			file, err := os.Create(filepath.Join(root, "release.zip"))
			if err != nil {
				t.Fatal(err)
			}
			writer := zip.NewWriter(file)
			expected := []nativeFile{}
			for _, name := range nativeNames {
				data := nativePayload(name, 2)
				if mutation == "architecture" && name == "TrueDown.exe" {
					binary.LittleEndian.PutUint16(data[68:], 0x14c)
				}
				metadata := nativeMetadata(name, data)
				if mutation == "hash" && name == "TrueDown.exe" {
					metadata.SHA256 = strings.Repeat("0", 64)
				}
				expected = append(expected, metadata)
				if mutation == "missing-core" && name == "truedown-core.exe" {
					continue
				}
				entry, err := writer.Create(name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := entry.Write(data); err != nil {
					t.Fatal(err)
				}
			}
			if mutation == "duplicate" {
				entry, _ := writer.Create("TrueDown.exe")
				_, _ = entry.Write([]byte("duplicate"))
			}
			if mutation == "traversal" {
				entry, _ := writer.Create("../unowned.txt")
				_, _ = entry.Write([]byte("escape"))
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(root, "stage")
			if err := os.Mkdir(output, 0700); err != nil {
				t.Fatal(err)
			}
			err = extractNativeArchive(filepath.Join(root, "release.zip"), output, expected)
			if (err == nil) != (mutation == "valid") {
				t.Fatalf("mutation=%s error=%v", mutation, err)
			}
		})
	}
}

func TestNativeTransactionRejectsPathsAndProcessArguments(t *testing.T) {
	for _, mutation := range []string{"state", "stage", "arguments", "engine", "order"} {
		t.Run(mutation, func(t *testing.T) {
			transaction, path := nativeFixture(t)
			switch mutation {
			case "state":
				transaction.StatePath += ".unrelated"
			case "stage":
				transaction.Stage = transaction.Directory
			case "arguments":
				transaction.Arguments = append(transaction.Arguments, "--execute-anything")
			case "engine":
				transaction.Files[0].New.Name = "aria2c.exe"
			case "order":
				transaction.Files[0], transaction.Files[4] = transaction.Files[4], transaction.Files[0]
			}
			if err := validateNativeTransaction(path, transaction); err == nil {
				t.Fatal("invalid native transaction accepted")
			}
		})
	}
}

func TestNativeUpdateStartupPrunesStateBeforeConcurrentWritersStart(t *testing.T) {
	transaction, _ := nativeFixture(t)
	files := []nativeFile{}
	for _, file := range transaction.Files {
		files = append(files, file.New)
	}
	state := persistedState{SchemaVersion: 1, EnginePreference: EngineStable, AutoUpdateTrueDown: false,
		PendingUpdate: &pendingAppUpdate{Version: "truedown-build-2", Build: 2, File: filepath.Base(transaction.Stage), SHA256: strings.Repeat("a", 64), NativeFiles: files}}
	if err := writeNativeJSON(transaction.StatePath, state); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{statePath: transaction.StatePath, currentBuild: 2, nativeExecutable: filepath.Join(transaction.Directory, "TrueDown.exe")}
	if err := manager.loadState(); err != nil {
		t.Fatal(err)
	}
	if !manager.prunedNativeState {
		t.Fatal("native startup did not request finalization")
	}
	if err := manager.persistLocked(); err != nil {
		t.Fatal(err)
	}
	var saved persistedState
	if err := readNativeJSON(transaction.StatePath, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.PendingUpdate != nil || saved.AutoUpdateTrueDown {
		t.Fatal("startup failed to prune only the committed native stage")
	}
}
