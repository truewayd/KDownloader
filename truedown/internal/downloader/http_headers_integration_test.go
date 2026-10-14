package downloader

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNativeHTTPUserAgentOverride(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") != "1" {
		t.Skip("requires a native aria2 integration engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	configured := "ConfiguredDownloader/1.0"
	cases := []string{"", "KDownloader/3.3.0 (+https://github.com/truewayd/KDownloader)", "MyDownloader/2.0"}
	payload := bytes.Repeat([]byte("native header fixture"), 100)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var index int
		if _, err := fmt.Sscanf(r.URL.Path, "/file-%d.bin", &index); err != nil || index < 0 || index >= len(cases) {
			http.Error(w, "unexpected fixture", http.StatusNotFound)
			return
		}
		want := cases[index]
		if want == "" {
			want = configured
		}
		if r.UserAgent() != want {
			t.Errorf("native UA=%q, want caller value %q", r.UserAgent(), want)
			http.Error(w, "incorrect UA", http.StatusForbidden)
			return
		}
		wantCookie := ""
		if index == 1 {
			wantCookie = "cf_clearance=synthetic-fixture"
		}
		if r.Header.Get("Cookie") != wantCookie {
			t.Error("native transfer changed the caller Cookie header")
			http.Error(w, "incorrect cookie", http.StatusForbidden)
			return
		}
		http.ServeContent(w, r, "fixture.bin", time.Unix(1000, 0), bytes.NewReader(payload))
	}))
	defer source.Close()
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), integrationManagerConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	for i, ua := range cases {
		headers := map[string]string{}
		if ua != "" {
			headers["uSeR-aGeNt"] = ua
		}
		if i == 1 {
			headers["Cookie"] = "cf_clearance=synthetic-fixture"
		}
		opts := Aria2Opts{ExtraArgs: []string{"user-agent=" + configured}}
		task, _, err := m.AddTask(fmt.Sprintf("%s/file-%d.bin", source.URL, i), fmt.Sprintf("fixture-%d.bin", i), "", headers, "", 0, opts)
		if err != nil {
			t.Fatal(err)
		}
		waitForStatus(t, m, task.ID, 15*time.Second, StatusDone)
		task, _ = m.GetTask(task.ID)
		content, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName))
		if err != nil || !bytes.Equal(content, payload) {
			t.Fatal("native output differs from local fixture", err)
		}
	}
}
