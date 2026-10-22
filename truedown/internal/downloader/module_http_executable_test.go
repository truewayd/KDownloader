package downloader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"truedown/internal/modulehost"
)

func runHTTPModuleTestHelper() {
	_ = modulehost.Serve(os.Stdin, os.Stdout, func(context.Context) modulehost.Handler {
		return func(method string, body json.RawMessage) (any, string) {
			switch method {
			case "hello":
				capabilities := []string{"http-resolver-v1", "public-folder-v1"}
				if os.Getenv("TRUEDOWN_TEST_HTTP_BAD_CAPABILITY") != "" {
					capabilities = []string{"aria2-artifact-v1"}
				}
				return modulehost.Hello{Protocol: 1, ModuleID: MediaFireModuleID, Version: "0.1.1", Capabilities: capabilities}, ""
			case "resolve":
				var request struct {
					Source string `json:"source"`
				}
				_ = json.Unmarshal(body, &request)
				return modulehost.HTTPSource{Source: request.Source, Folder: strings.Contains(request.Source, "/folder/")}, ""
			case "list":
				entries := []modulehost.ArtifactEntry{
					{Source: "https://www.mediafire.com/file/aaaaaaaaaaaaaaa", Path: []string{"Sub", "a.txt"}, Size: 12, Data: json.RawMessage(`{}`)},
					{Source: "https://www.mediafire.com/file/bbbbbbbbbbbbbbb", Path: []string{"design.psd"}, Size: 12, Data: json.RawMessage(`{}`)},
				}
				mode := os.Getenv("TRUEDOWN_TEST_HTTP_FOLDER")
				if mode == "unsafe" {
					entries[1].Path = []string{"..", "escape"}
				}
				if mode == "source" {
					entries[1].Source = "https://example.test/x"
				}
				next := -1
				if mode == "cursor" {
					next = 0
				}
				return modulehost.CollectionPage{Name: "Public", Total: 2, Next: next, Entries: entries}, ""
			case "prepare":
				link := os.Getenv("TRUEDOWN_TEST_HTTP_URL")
				if link == "" {
					link = "https://download12.mediafire.com/temporary/test.txt"
				}
				return modulehost.PreparedHTTP{Name: "test.txt", Size: 12, URL: link, SHA256: strings.Repeat("a", 64)}, ""
			case "shutdown":
				return struct{}{}, ""
			}
			return nil, "unsupported"
		}
	})
}
func httpModuleFixture(t *testing.T) (*Manager, string) {
	t.Helper()
	root := artifactTempDir(t)
	directory := filepath.Join(root, "modules", MediaFireModuleID)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	self, _ := os.Executable()
	input, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	entry := "truedown-mediafire"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	executable := filepath.Join(directory, entry)
	output, err := os.OpenFile(executable, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(output, input)
	closeErr := output.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("copy helper: %v %v", err, closeErr)
	}
	t.Setenv("TRUEDOWN_TEST_HTTP_MODULE_HELPER", "1")
	config := integrationManagerConfig()
	config.ModuleDirectory = filepath.Dir(directory)
	m, err := NewManagerWithConfig("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Stop)
	return m, executable
}
func TestHTTPModuleFolderAdmissionIsAtomicAndFiltered(t *testing.T) {
	m, _ := httpModuleFixture(t)
	if _, err := m.SetDownloadRules(DownloadRules{FilterMode: DropboxFilterCustom, ExcludedExtensions: []string{".psd"}}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"unsafe", "source", "cursor"} {
		t.Setenv("TRUEDOWN_TEST_HTTP_FOLDER", invalid)
		if result, _, err := m.AddWithModules(context.Background(), "https://www.mediafire.com/folder/h2tkt00f7s2sh", "", "", nil, "", 0, Aria2Opts{}.WithStartPaused(true), nil); err == nil || len(result.Tasks) != 0 {
			t.Fatalf("accepted invalid folder %s: %+v %v", invalid, result, err)
		}
		if len(m.tasks) != 0 {
			t.Fatal("partial admission after invalid listing")
		}
	}
	t.Setenv("TRUEDOWN_TEST_HTTP_FOLDER", "")
	result, _, err := m.AddWithModules(context.Background(), "https://www.mediafire.com/folder/h2tkt00f7s2sh", "", "", map[string]string{"Cookie": "never-forward"}, "https://private.test/", 0, Aria2Opts{}.WithStartPaused(true), nil)
	if err != nil || len(result.Tasks) != 1 || result.Filtered != 1 || !result.Collection {
		t.Fatalf("folder admission: %+v %v", result, err)
	}
	task := result.Tasks[0]
	if task.Status != StatusPaused || !strings.Contains(filepath.ToSlash(task.Folder), "/Public/Sub") || len(task.Headers) != 0 {
		t.Fatalf("task: %+v", task)
	}
}
func TestHTTPModulePrepareAndActivationValidateBoundary(t *testing.T) {
	m, executable := httpModuleFixture(t)
	r := m.modules.module(MediaFireModuleID)
	task := &Task{Link: "https://www.mediafire.com/file/aaaaaaaaaaaaaaa", Name: "renamed.txt", ModuleID: MediaFireModuleID}
	prepared, err := r.prepare(context.Background(), m, task)
	if err != nil || prepared.Artifact != nil || prepared.Metadata.Name != "test.txt" || len(prepared.Headers) != 0 {
		t.Fatalf("HTTP preparation: %+v %v", prepared, err)
	}
	if err := validateRemoteMetadata(task, prepared.Metadata, "MediaFire"); err != nil {
		t.Fatal("caller filename incorrectly treated as remote identity", err)
	}
	task.RemoteDigest = strings.Repeat("b", 64)
	if err := validateRemoteMetadata(task, prepared.Metadata, "MediaFire"); err == nil {
		t.Fatal("changed remote digest allowed")
	}
	for _, invalid := range []string{"https://download1.mediafire.com.evil/x", "http://127.0.0.1/x", "https://user:secret@download1.mediafire.com/x"} {
		t.Setenv("TRUEDOWN_TEST_HTTP_URL", invalid)
		if _, err := r.prepare(context.Background(), m, task); err == nil {
			t.Fatalf("accepted transport %s", invalid)
		}
	}
	if _, err := m.InstallModulePackage(json.RawMessage(`{"id":"mediafire","schemaVersion":1,"engine":"executable-http-v1","version":"9.0.0","releasedAt":"2026-10-22","config":{}}`)); err == nil {
		t.Fatal("unsigned executable configuration accepted")
	}
	if err := m.activateExecutable(context.Background(), MediaFireModuleID, executable, "0.1.1"); err != nil {
		t.Fatal(err)
	}
	pointer := filepath.Join(m.executableRoot(MediaFireModuleID), "active.json")
	before, _ := os.ReadFile(pointer)
	t.Setenv("TRUEDOWN_TEST_HTTP_BAD_CAPABILITY", "1")
	if err := m.activateExecutable(context.Background(), MediaFireModuleID, executable, "0.1.1"); err == nil {
		t.Fatal("artifact capability substituted for HTTP capability")
	}
	after, _ := os.ReadFile(pointer)
	if string(before) != string(after) {
		t.Fatal("failed activation changed selection")
	}
}
func TestBundledMediaFireCanonicalPausedAdmission(t *testing.T) {
	root := artifactTempDir(t)
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if _, err := m.moduleExecutable(MediaFireModuleID); err != nil {
		t.Fatal("prepare-download-modules.mjs is required: ", err)
	}
	var first int64
	for index, link := range []string{"https://mediafire.com/?j2tq12gr15jhq2r", "https://www.mediafire.com/file/j2tq12gr15jhq2r/name/file"} {
		result, handled, err := m.AddWithModules(context.Background(), link, "local.docx", "", nil, "", 0, Aria2Opts{}.WithStartPaused(true), nil)
		if err != nil || !handled || len(result.Tasks) != 1 {
			t.Fatalf("paused admission: %+v %v", result, err)
		}
		task := result.Tasks[0]
		if task.Status != StatusPaused || task.Link != "https://www.mediafire.com/file/j2tq12gr15jhq2r" || task.Name != "local.docx" {
			t.Fatalf("identity: %+v", task)
		}
		if index == 0 {
			first = task.ID
		} else if task.ID != first || result.Duplicates != 1 {
			t.Fatal("canonical aliases were not deduplicated")
		}
	}
}
func TestMediaFirePublicDownload(t *testing.T) {
	if os.Getenv("TRUEDOWN_MEDIAFIRE_DOWNLOAD_SMOKE") == "" {
		t.Skip("opt-in public 233373-byte MediaFire press document")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := artifactTempDir(t)
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), integrationManagerConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	result, _, err := m.AddWithModules(context.Background(), "https://www.mediafire.com/file/j2tq12gr15jhq2r", "mediafire-smoke.docx", "", nil, "", 0, Aria2Opts{Connections: 1}, nil)
	if err != nil || len(result.Tasks) != 1 {
		t.Fatalf("public admission: %+v %v", result, err)
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		task, _ := m.GetTask(result.Tasks[0].ID)
		if task.Status == StatusError {
			t.Fatal(task.Error)
		}
		if task.Status == StatusDone {
			data, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName))
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(data)
			if len(data) != 233373 || hex.EncodeToString(digest[:]) != "6df2d9c9552308c8f5c95bd502aeaf67facc9a223491f6a570fa8128a7da7988" {
				t.Fatal("download differs from public API checksum")
			}
			t.Log("public file downloaded through aria2; SHA-256 verified")
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("public download timed out")
}

func TestHTTPModuleOptionsAreClosed(t *testing.T) {
	r := &httpExecutableResolver{}
	for _, raw := range []string{`null`, `[]`, `{"applyFilter":"false"}`, `{"applyFilter":true,"applyFilter":false}`, `{"command":"x"}`} {
		if r.validateOptions(json.RawMessage(raw)) == nil {
			t.Fatal("accepted unsupported options", raw)
		}
	}
}
