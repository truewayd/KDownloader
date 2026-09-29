package downloader

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestNextFilenameResolutionIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 2, 8, 3) {
		t.Skip("requires NEXT 2.8.3+ integration engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	client := m.rpc.(*ariaClient)
	if !client.filenameResolution.Load() {
		t.Fatal("release lacks filename-resolution capability")
	}
	for _, test := range []struct{ url, header, want string }{
		{"https://example.invalid/a%20b.zip", "", "a b.zip"},
		{"https://example.invalid/fallback.bin", "attachment; filename*=UTF-8''caf%C3%A9.zip", "caf\u00e9.zip"},
		{"https://example.invalid/a%2520b.zip", "", "a%20b.zip"},
	} {
		got, err := client.resolveFilename(context.Background(), test.url, test.header)
		if err != nil || got != test.want {
			t.Fatalf("resolve filename=%q want=%q err=%v", got, test.want, err)
		}
	}
	if states, err := client.statuses(); err != nil || len(states) != 0 {
		t.Fatalf("filename preview created tasks: %v %v", states, err)
	}
}
