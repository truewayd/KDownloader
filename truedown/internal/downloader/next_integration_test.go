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

func TestNextBTIdentityIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 2, 6, 7) {
		t.Skip("requires NEXT 2.6.7+ integration engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	database := filepath.Join(root, "records.db")
	folder := filepath.Join(root, "downloads")
	m, err := NewManagerWithConfig(engine, folder, database, config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	ua, prefix := "TrueDown-test/1.0", "-TD1000-"
	if _, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &ua, BTPeerIDPrefix: &prefix}); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, m, "bt-user-agent", ua)
	requireAriaGlobalOption(t, m, "bt-peer-id-prefix", prefix)
	ua, prefix = "TrueDown-test/2.0", "-TD2000-"
	if _, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &ua, BTPeerIDPrefix: &prefix}); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, m, "bt-user-agent", ua)
	requireAriaGlobalOption(t, m, "bt-peer-id-prefix", prefix)
	m.Stop()
	restored, err := NewManagerWithConfig(engine, folder, database, config)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Stop()
	if err := restored.Start(); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, restored, "bt-user-agent", ua)
	requireAriaGlobalOption(t, restored, "bt-peer-id-prefix", prefix)
	blank := ""
	if _, err := restored.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &blank, BTPeerIDPrefix: &blank}); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, restored, "bt-user-agent", defaultBTUserAgent)
	requireAriaGlobalOption(t, restored, "bt-peer-id-prefix", defaultBTPeerIDPrefix)
}
