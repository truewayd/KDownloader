package downloader

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBTIdentitySettingsPersistenceAndCompatibility(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "records.db")
	m, err := NewManager("unused", filepath.Join(root, "downloads"), database)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	fake := &fakeAriaRPC{}
	m.rpc = fake
	ua, prefix := "TrueDown-test/1.0", "-TD1000-"
	for _, version := range []string{"", "2.6.6", "2.6.7", "2.8.3"} {
		m.aria2Next, m.aria2NextVersion = version != "", version
		saved, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &ua, BTPeerIDPrefix: &prefix})
		if err != nil {
			t.Fatal(err)
		}
		options := fake.globalOptions[len(fake.globalOptions)-1]
		supported := version == "2.6.7" || version == "2.8.3"
		if _, ok := options["bt-user-agent"]; ok != supported {
			t.Fatalf("version=%s options=%v", version, options)
		}
		if supported && (options["bt-user-agent"] != ua || options["bt-peer-id-prefix"] != prefix) {
			t.Fatal(options)
		}
		args := strings.Join(m.aria2StartArgs(6800, "test", saved), "\n")
		if strings.Contains(args, "--bt-user-agent="+ua) != supported || strings.Contains(args, "--bt-peer-id-prefix="+prefix) != supported {
			t.Fatal(args)
		}
	}
	// An older UI changing only concurrency must retain the BT identity.
	concurrency := 8
	saved, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{ConcurrentDownloads: &concurrency})
	if err != nil || saved.BTUserAgent != ua || saved.BTPeerIDPrefix != prefix {
		t.Fatalf("%+v %v", saved, err)
	}
	reloaded, err := newRuntimeSettingsStoreAt(m.runtimeSettings.path)
	if err != nil || reloaded.snapshot() != saved {
		t.Fatalf("reload: %v", err)
	}
	blank := ""
	reset, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &blank, BTPeerIDPrefix: &blank})
	if err != nil || reset.ConcurrentDownloads != 8 || reset.BTUserAgent != defaultBTUserAgent || reset.BTPeerIDPrefix != defaultBTPeerIDPrefix {
		t.Fatalf("reset: %+v %v", reset, err)
	}
	for _, invalid := range []string{"line\r\ninjection", "nul\x00", strings.Repeat("a", 513), "non-ascii\u00e9"} {
		if _, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &invalid}); !IsValidationError(err) {
			t.Fatalf("accepted UA %q: %v", invalid, err)
		}
	}
	longPrefix := strings.Repeat("x", 21)
	if _, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTPeerIDPrefix: &longPrefix}); !IsValidationError(err) {
		t.Fatalf("accepted oversized prefix: %v", err)
	}
	if m.RuntimeSettings() != reset {
		t.Fatal("invalid update changed persisted settings")
	}
	for _, option := range []string{"bt-user-agent", "bt-peer-id-prefix"} {
		if !isProtectedAriaOption(option) {
			t.Fatalf("global option allowed on task: %s", option)
		}
	}
}

func TestBTIdentityLegacySettingsMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"concurrentDownloads":7,"globalDownloadLimitBps":1234}`), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := newRuntimeSettingsStoreAt(path)
	if err != nil {
		t.Fatal(err)
	}
	settings := store.snapshot()
	if settings.ConcurrentDownloads != 7 || settings.GlobalDownloadLimitBps != 1234 || settings.BTUserAgent != defaultBTUserAgent || settings.BTPeerIDPrefix != defaultBTPeerIDPrefix {
		t.Fatal(settings)
	}
}
