package downloader

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNextRetryPreservesCheckpointOwnerAndIgnoresRetiredResult(t *testing.T) {
	for _, duplicate := range []bool{false, true} {
		m, rpc := transferTestManager(t)
		m.aria2Next, m.aria2NextVersion = true, "2.8.3"
		task := transferTestTask(t, m, "native.bin")
		path := filepath.Join(task.Folder, task.OutputName)
		if err := os.WriteFile(path, []byte("checkpoint"), 0600); err != nil {
			t.Fatal(err)
		}
		failed := ariaStatus{GID: task.GID, Status: "error", ErrorMessage: "connection reset"}
		m.applyStatuses([]ariaStatus{failed})
		if duplicate {
			if _, _, err := m.AddTask(task.Link, task.Name, "", nil, "", 0, task.Opts); err != nil {
				t.Fatal(err)
			}
		} else if err := m.RequeueTask(task.ID); err != nil {
			t.Fatal(err)
		}
		m.applyStatuses([]ariaStatus{failed})
		queued, _ := m.GetTask(task.ID)
		if queued.GID != task.GID || queued.PreviousGID != task.GID || queued.Status != StatusQueued {
			t.Fatalf("lost retry identity or accepted stale result: %+v", queued)
		}
		if !m.submit(submission{id: task.ID}) {
			t.Fatal("retry failed")
		}
		if rpc.addedOptions[len(rpc.addedOptions)-1]["gid"] != task.GID {
			t.Fatal("RPC changed native checkpoint identity")
		}
		if data, err := os.ReadFile(path); err != nil || string(data) != "checkpoint" {
			t.Fatal("retry deleted native payload", err)
		}
	}
}

func TestNextMissingCheckpointRequiresExplicitCleanRetry(t *testing.T) {
	m, rpc := transferTestManager(t)
	m.aria2Next, m.aria2NextVersion = true, "2.8.3"
	task := transferTestTask(t, m, "missing.bin")
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, []byte("unverified"), 0600); err != nil {
		t.Fatal(err)
	}
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorCode: "13"}})
	failed, _ := m.GetTask(task.ID)
	if failed.TransferState != transferRestart || !strings.Contains(failed.Error, "from zero") {
		t.Fatalf("no clean retry offered: %+v", failed)
	}
	if err := m.RequeueTask(task.ID); err != nil || !m.submit(submission{id: task.ID}) {
		t.Fatal("clean retry failed", err)
	}
	if pathExists(path) || rpc.addedOptions[len(rpc.addedOptions)-1]["gid"] == task.GID {
		t.Fatal("clean restart reused invalid native state")
	}
}

func TestNextIgnoresLegacyControlOnGenericFailure(t *testing.T) {
	m, _ := transferTestManager(t)
	m.aria2Next, m.aria2NextVersion = true, "2.8.3"
	task := transferTestTask(t, m, "legacy.bin")
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, make([]byte, 1024), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".aria2", []byte{0xfe, 0xff}, 0600); err != nil {
		t.Fatal(err)
	}
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorCode: "1", TotalLength: "1024"}})
	failed, _ := m.GetTask(task.ID)
	if failed.TransferState == transferRestart {
		t.Fatal("legacy control file invalidated native checkpoint")
	}
}

func TestNextRenewedModuleURLRestartsWithoutLegacyControlFile(t *testing.T) {
	m, _ := transferTestManager(t)
	m.aria2Next, m.aria2NextVersion = true, "2.8.3"
	oldURL := "https://www.dropbox.com/scl/fi/token/archive.zip?rlkey=key&st=old&dl=1"
	task, _, err := m.AddTask(oldURL, "archive.zip", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := os.MkdirAll(task.Folder, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, []byte("native partial"), 0600); err != nil {
		t.Fatal(err)
	}
	m.failTask(task.ID, errors.New("expired link"))
	newURL := strings.Replace(oldURL, "st=old", "st=new", 1)
	renewed, duplicate, err := m.AddTask(newURL, "archive.zip", "", nil, "", 0, Aria2Opts{})
	if err != nil || !duplicate || renewed.ID != task.ID || renewed.GID == task.GID || renewed.TransferState != transferRestart {
		t.Fatalf("renewed native identity=%+v duplicate=%v error=%v", renewed, duplicate, err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "native partial" {
		t.Fatal("payload changed before remote metadata validation", err)
	}
	database := filepath.Join(filepath.Dir(m.defaultDir), "records.db")
	m.Stop()
	reopened, err := NewManagerWithConfig("unused", m.defaultDir, database, ManagerConfig{Aria2Next: true, Aria2NextVersion: "2.8.3"})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Stop()
	persisted, _ := reopened.GetTask(task.ID)
	if persisted.TransferState != transferRestart || persisted.PreviousGID != task.GID || persisted.Link != newURL {
		t.Fatalf("renewed identity was not durable: %+v", persisted)
	}
}

func TestFilenameResolutionCapabilityAndRawBytes(t *testing.T) {
	for _, supported := range []bool{false, true} {
		calls := 0
		disposition := "attachment; filename=\"caf\xc3\xa9-\xff.bin\""
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var request struct {
				Method string
				Params []json.RawMessage
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
				return
			}
			var result any
			switch request.Method {
			case "aria2.getVersion":
				features := []string{}
				if supported {
					features = append(features, "filename-resolution")
				}
				result = map[string]any{"version": "2.8.3", "downloadFeatures": features}
			case "aria2.resolveFilename":
				calls++
				var data []int
				if len(request.Params) != 3 || json.Unmarshal(request.Params[2], &data) != nil {
					t.Error("not an integer array")
					return
				}
				want := make([]int, len(disposition))
				for i := 0; i < len(disposition); i++ {
					want[i] = int(disposition[i])
				}
				if !reflect.DeepEqual(data, want) {
					t.Errorf("raw bytes changed: %v", data)
				}
				result = "resolved.bin"
			default:
				t.Errorf("unexpected method: %s", request.Method)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"result": result})
		}))
		client := newAriaClient(0, "secret")
		client.url = server.URL
		if err := client.ready(); err != nil {
			t.Fatal(err)
		}
		name, err := client.resolveFilename(context.Background(), "https://example.test/file", disposition)
		if err != nil || (supported && (name != "resolved.bin" || calls != 1)) || (!supported && (name != "" || calls != 0)) {
			t.Fatalf("capability=%v name=%q calls=%d error=%v", supported, name, calls, err)
		}
		if supported {
			if _, err := client.resolveFilename(context.Background(), strings.Repeat("x", 16385), ""); err == nil {
				t.Fatal("unbounded URL")
			}
			if _, err := client.resolveFilename(context.Background(), "https://example.test", strings.Repeat("x", 8193)); err == nil {
				t.Fatal("unbounded header")
			}
		}
		server.Close()
	}
}

type filenameTestRPC struct {
	*fakeAriaRPC
	name string
	err  error
}

func (r filenameTestRPC) resolveFilename(context.Context, string, string) (string, error) {
	return r.name, r.err
}

func TestMetadataFilenameFallback(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{"native.bin", nil, "native.bin"}, {"", nil, "local.bin"},
		{"", errors.New("unavailable"), "local.bin"},
	} {
		m := &Manager{rpc: filenameTestRPC{&fakeAriaRPC{}, test.name, test.err}}
		metadata := remoteMetadata{Name: "local.bin", URL: "https://example.test/file", ContentDisposition: "attachment"}
		m.resolveMetadataFilename(context.Background(), &metadata)
		if metadata.Name != test.want {
			t.Fatalf("name=%q want=%q", metadata.Name, test.want)
		}
	}
}
