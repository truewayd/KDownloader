package netproxy

import (
	"net/http"
	"strings"
	"testing"
)

func TestResolvedModuleRoutesUseSharedValidationAndLoopbackBypass(t *testing.T) {
	external, _ := http.NewRequest(http.MethodGet, "https://g.api.mega.co.nz/", nil)
	local, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:1234/", nil)
	for _, address := range []string{"", "http://127.0.0.1:7890", "https://127.0.0.1:7890", "socks5://127.0.0.1:7890", "socks5h://127.0.0.1:7890"} {
		selector, err := Resolved(address)
		if err != nil {
			t.Fatal(err)
		}
		selected, err := selector(external)
		if err != nil || (address == "" && selected != nil) || (address != "" && (selected == nil || selected.String() != address)) {
			t.Fatal("resolved route changed or fell back to system settings")
		}
		if selected, err := selector(local); err != nil || selected != nil {
			t.Fatal("module proxy captured loopback traffic")
		}
		if strings.HasPrefix(address, "socks") && Validate(Settings{Mode: "custom", Address: address}) == nil {
			t.Fatal("a resolved system SOCKS route expanded the custom HTTP(S) setting")
		}
	}
	for _, address := range []string{"ftp://private:secret@example.com", "http://private:secret@[", "http://example.com\nprivate-secret", strings.Repeat("x", 4097)} {
		_, err := Resolved(address)
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid module route was accepted or exposed credentials")
		}
	}
}
