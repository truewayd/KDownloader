package systemupdate

import (
	"os"
	"testing"
)

func TestNextVersionOutputFormats(t *testing.T) {
	for _, output := range []string{"Aria2 Next version 2.8.3\r\n", "aria2-next version 3.0.0\n"} {
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
	kind, actual, err := inspectEngineBinary(path)
	if err != nil || kind != EngineNext || actual != version {
		t.Fatalf("kind=%q version=%q expected=%q err=%v", kind, actual, version, err)
	}
}
