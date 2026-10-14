package systemupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNextVersionOutputFormats(t *testing.T) {
	for _, output := range []string{"Aria2 Next version 2.8.3\r\n", "aria2-next version 3.0.0\n", "aria2-next version 3.0.2\n"} {
		if match := nextVersionPattern.FindStringSubmatch(output); len(match) != 2 {
			t.Fatalf("unrecognized NEXT version: %q", output)
		}
	}
	for _, output := range []string{"aria2-next version 3.0.0-beta", "fake aria2-next version 3.0.0", "aria2 version 1.37.0"} {
		if nextVersionPattern.MatchString(output) {
			t.Fatalf("accepted version: %q", output)
		}
	}
}

func TestNextReleaseBinaryIdentityIntegration(t *testing.T) {
	path, version := os.Getenv("TRUEDOWN_ARIA2_PATH"), os.Getenv("TRUEDOWN_ARIA2_NEXT_VERSION")
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || path == "" || version == "" {
		t.Skip("requires the checksum-verified NEXT acceptance engine")
	}
	root := t.TempDir()
	for _, name := range []string{"HOME", "USERPROFILE", "XDG_CONFIG_HOME"} {
		t.Setenv(name, root)
	}
	for _, directory := range []string{"aria2", ".aria2", "AppData/Local/aria2", "AppData/Local/aria2-next", "AppData/Roaming/aria2"} {
		config := filepath.Join(root, directory)
		if err := os.MkdirAll(config, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(config, "aria2.conf"), []byte("invalid-ambient-option=true\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	kind, actual, err := inspectEngineBinary(path)
	if err != nil || kind != EngineNext || actual != version {
		t.Fatalf("kind=%q version=%q expected=%q err=%v", kind, actual, version, err)
	}
}
