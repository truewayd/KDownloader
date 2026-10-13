package downloader

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func mediaFixtureTool(t *testing.T, name string) string {
	t.Helper()
	path := os.Getenv("TRUEDOWN_FFMPEG_PATH")
	if path != "" {
		path = filepath.Join(filepath.Dir(path), name+filepath.Ext(path))
	} else {
		path, _ = exec.LookPath(name)
	}
	if path == "" {
		t.Fatal("NEXT media acceptance requires developer FFmpeg/ffprobe; set TRUEDOWN_FFMPEG_PATH")
	}
	return path
}

func runMediaTool(t *testing.T, tool string, args ...string) []byte {
	t.Helper()
	output, err := exec.Command(tool, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("media fixture/oracle failed: %v\n%s", err, output)
	}
	return output
}

func TestNext3MediaIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 0, 0) {
		t.Skip("requires NEXT 3")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	ffmpeg := mediaFixtureTool(t, "ffmpeg")
	fixtures := t.TempDir()
	source := filepath.Join(fixtures, "source.mp4")
	runMediaTool(t, ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-sc_threshold", "0", "-c:a", "aac", source)
	for _, protocol := range []string{"hls", "dash"} {
		dir := filepath.Join(fixtures, protocol)
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		args := []string{"-v", "error", "-i", source, "-c", "copy"}
		if protocol == "hls" {
			args = append(args, "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_filename", filepath.Join(dir, "segment%02d.ts"), filepath.Join(dir, "index.m3u8"))
		} else {
			args = append(args, "-f", "dash", "-seg_duration", "1", filepath.Join(dir, "index.mpd"))
		}
		// FFmpeg resolves DASH child names against its working directory on
		// Windows. Keep every generated segment inside the temporary fixture.
		args[len(args)-1] = filepath.Base(args[len(args)-1])
		command := exec.Command(ffmpeg, args...)
		command.Dir = dir
		if data, err := command.CombinedOutput(); err != nil {
			t.Fatalf("fixture: %v %s", err, data)
		}
	}
	videoHashes := func(path string) string {
		data := runMediaTool(t, ffmpeg, "-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-")
		var hashes []string
		for _, line := range strings.Split(string(data), "\n") {
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			fields := strings.Split(line, ",")
			hashes = append(hashes, strings.TrimSpace(fields[len(fields)-1]))
		}
		return strings.Join(hashes, "\n")
	}
	wantFrames := videoHashes(source)
	for _, scenario := range []string{"hls", "dash", "retry", "restart", "remove", "live", "cross-origin"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			var failure atomic.Bool
			failure.Store(scenario == "retry")
			var requestsMu sync.Mutex
			requests := map[string]int{}
			files := http.FileServer(http.Dir(fixtures))
			var leaked atomic.Bool
			child := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Cookie") != "" {
					leaked.Store(true)
					w.WriteHeader(401)
					return
				}
				files.ServeHTTP(w, r)
			}))
			defer child.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestsMu.Lock()
				requests[r.URL.Path]++
				requestsMu.Unlock()
				if r.Header.Get("Cookie") != "fixture=authorized" {
					w.WriteHeader(401)
					return
				}
				if strings.HasSuffix(r.URL.Path, ".m3u8") && (scenario == "live" || scenario == "cross-origin") {
					data, err := os.ReadFile(filepath.Join(fixtures, "hls", "index.m3u8"))
					if err != nil {
						t.Error(err)
						w.WriteHeader(500)
						return
					}
					manifest := string(data)
					if scenario == "live" {
						manifest = strings.ReplaceAll(manifest, "#EXT-X-ENDLIST\n", "")
					}
					if scenario == "cross-origin" {
						manifest = strings.ReplaceAll(manifest, "segment", child.URL+"/hls/segment")
					}
					w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
					fmt.Fprint(w, manifest)
					return
				}
				if strings.HasSuffix(r.URL.Path, ".ts") {
					if failure.Load() && strings.HasSuffix(r.URL.Path, "segment04.ts") {
						w.WriteHeader(401)
						return
					}
					if scenario == "restart" || scenario == "remove" || scenario == "live" {
						select {
						case <-r.Context().Done():
							return
						case <-time.After(500 * time.Millisecond):
						}
					}
				}
				files.ServeHTTP(w, r)
			}))
			defer server.Close()
			newManager := func() *Manager {
				m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
				if err != nil {
					t.Fatal(err)
				}
				if err := m.Start(); err != nil {
					m.Stop()
					t.Fatal(err)
				}
				return m
			}
			m := newManager()
			defer func() { m.Stop() }()
			t.Cleanup(func() {
				if t.Failed() {
					requestsMu.Lock()
					t.Logf("fixture requests: %+v", requests)
					requestsMu.Unlock()
					manifest, _ := os.ReadFile(filepath.Join(fixtures, "dash", "index.mpd"))
					t.Logf("DASH fixture: %s", manifest)
					for _, name := range []string{"aria2.log", "aria2-console.log"} {
						data, _ := os.ReadFile(filepath.Join(root, name))
						if len(data) > 12000 {
							data = data[len(data)-12000:]
						}
						t.Logf("%s: %s", name, data)
					}
				}
			})
			if !m.EngineCapabilities().Media {
				t.Fatal("native media discovery failed")
			}
			protocol, path := "hls", "/hls/index.m3u8"
			if scenario == "dash" {
				protocol, path = "dash", "/dash/index.mpd"
			}
			format := "mp4"
			if scenario == "dash" {
				format = "mkv"
			}
			task, _, err := m.AddTask(server.URL+path, "Episode.01", "", map[string]string{"Cookie": "fixture=authorized"}, "", 0, Aria2Opts{Connections: 1, MaxTries: 1, RetryWait: 1, Media: &MediaOptions{Protocol: protocol, Format: format}})
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "retry" {
				waitForStatus(t, m, task.ID, 20*time.Second, StatusError)
				requestsMu.Lock()
				cached := requests["/hls/segment00.ts"]
				requestsMu.Unlock()
				if cached == 0 {
					t.Fatal("fixture did not establish cached segments")
				}
				failure.Store(false)
				if err := m.RequeueTask(task.ID); err != nil {
					t.Fatal(err)
				}
				current, _ := m.GetTask(task.ID)
				if current.GID != task.GID {
					t.Fatal("retry changed native media identity")
				}
				waitForStatus(t, m, task.ID, 20*time.Second, StatusDone)
				requestsMu.Lock()
				after := requests["/hls/segment00.ts"]
				requestsMu.Unlock()
				if after != cached {
					t.Fatalf("retry fetched cached segment again: %d -> %d", cached, after)
				}
			} else if scenario == "restart" || scenario == "remove" || scenario == "live" {
				deadline := time.Now().Add(15 * time.Second)
				for {
					current, _ := m.GetTask(task.ID)
					if current.Media != nil && current.Media.DownloadedLength > 0 && current.Status == StatusDownloading {
						break
					}
					if current.Status == StatusError || current.Status == StatusDone || time.Now().After(deadline) {
						t.Fatalf("no interruptible media progress: %+v", current)
					}
					time.Sleep(30 * time.Millisecond)
				}
				if err := m.PauseTask(task.ID); err != nil {
					t.Fatal(err)
				}
				cache := filepath.Join(m.ariaStateDir, "media", "tasks", task.GID)
				if _, err := os.Stat(cache); err != nil {
					t.Fatal("fixture did not establish native media cache", err)
				}
				if scenario == "remove" {
					foreign := filepath.Join(task.Folder, "foreign.tmp")
					if err := os.WriteFile(foreign, []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
					result := m.RemoveTasks([]int64{task.ID})
					if len(result.Succeeded) != 1 {
						t.Fatalf("remove: %+v", result)
					}
					if _, err := os.Stat(cache); !os.IsNotExist(err) {
						t.Fatalf("native cache remains: %v", err)
					}
					if data, err := os.ReadFile(foreign); err != nil || !bytes.Equal(data, []byte("keep")) {
						t.Fatal("foreign temporary file changed", err)
					}
					return
				}
				if scenario == "live" {
					if result := m.FinishMediaTasks([]int64{task.ID}); len(result.Succeeded) != 1 {
						t.Fatal("finish recording", result)
					}
				} else {
					requestsMu.Lock()
					cached := requests["/hls/segment00.ts"]
					requestsMu.Unlock()
					m.Stop()
					m = newManager()
					current, _ := m.GetTask(task.ID)
					if current.GID != task.GID || current.Status != StatusPaused {
						t.Fatalf("restart lost native identity or pause: %+v", current)
					}
					if err := m.ResumeTask(task.ID); err != nil {
						t.Fatal(err)
					}
					waitForStatus(t, m, task.ID, 30*time.Second, StatusDone)
					requestsMu.Lock()
					after := requests["/hls/segment00.ts"]
					requestsMu.Unlock()
					if cached == 0 || cached != after {
						t.Fatal("restart redownloaded cached first segment", cached, after)
					}
				}
			}
			waitForStatus(t, m, task.ID, 30*time.Second, StatusDone)
			current, _ := m.GetTask(task.ID)
			if current.Media == nil || current.Media.State != "complete" {
				t.Fatalf("missing authoritative media completion: %+v", current)
			}
			if current.OutputName != "Episode.01."+format {
				t.Fatalf("engine filename not preserved: %q", current.OutputName)
			}
			output := filepath.Join(current.Folder, current.OutputName)
			gotFrames := videoHashes(output)
			if scenario == "live" && (gotFrames == "" || !strings.Contains(wantFrames, gotFrames)) {
				t.Fatal("live output does not match frames from the source window")
			}
			if scenario != "live" && gotFrames != wantFrames {
				t.Fatal("decoded video frames differ from source")
			}
			if leaked.Load() {
				t.Fatal("browser credentials crossed media origins")
			}
			streams := runMediaTool(t, mediaFixtureTool(t, "ffprobe"), "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", output)
			if !strings.Contains(string(streams), "audio") || !strings.Contains(string(streams), "video") {
				t.Fatal("missing muxed tracks", string(streams))
			}
			if got, duplicate, err := m.AddTask(task.Link, "Episode.01", "", task.Headers, "", 0, task.Opts); err != nil || !duplicate || got.GID != task.GID || got.Status != StatusDone {
				t.Fatal("duplicate media redownloaded completed output", err)
			}
			if result := m.RemoveTasks([]int64{task.ID}); len(result.Succeeded) != 1 {
				t.Fatal(fmt.Sprint(result))
			}
			if _, err := os.Stat(output); err != nil {
				t.Fatal("removing completed task deleted published media", err)
			}
		})
	}
}
