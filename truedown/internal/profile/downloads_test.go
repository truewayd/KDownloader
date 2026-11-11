package profile

import (
	"path/filepath"
	"testing"
)

func TestDownloadDirectoryXDG(t *testing.T) {
	home := t.TempDir()
	redirected := filepath.Join(home, "下载 文件")
	for _, tc := range []struct{ name, data, want string }{
		{"localized", `XDG_DOWNLOAD_DIR="$HOME/下载 文件"`, redirected},
		{"absolute", `XDG_DOWNLOAD_DIR="` + filepath.ToSlash(redirected) + `"`, redirected},
		{"disabled", `XDG_DOWNLOAD_DIR="$HOME/"`, home},
		{"missing", `XDG_DESKTOP_DIR="$HOME/Desktop"`, filepath.Join(home, "Downloads")},
		{"relative", `XDG_DOWNLOAD_DIR="relative"`, filepath.Join(home, "Downloads")},
		{"command", "XDG_DOWNLOAD_DIR=\"$(touch unsafe)\"", filepath.Join(home, "Downloads")},
		{"comment", `# XDG_DOWNLOAD_DIR="$HOME/wrong"`, filepath.Join(home, "Downloads")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseDownloadDirectory(tc.data, home); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
