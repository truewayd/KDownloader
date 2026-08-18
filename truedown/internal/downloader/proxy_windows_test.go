//go:build windows

package downloader

import (
	"net/http"
	"testing"
)

func TestWindowsSystemProxyRoutesDropboxHTTPS(t *testing.T) {
	config := parseWindowsProxyConfig(
		"http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892",
		"<local>;localhost;*.internal.test",
	)
	request, err := http.NewRequest(http.MethodGet, "https://www.dropbox.com/scl/fo/token/share?dl=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := config.proxyForRequest(request)
	if proxy == nil || proxy.String() != "http://127.0.0.1:7891" {
		t.Fatalf("Dropbox HTTPS proxy=%v, want http://127.0.0.1:7891", proxy)
	}
	for _, target := range []string{"https://localhost/test", "https://service.internal.test/test"} {
		request, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		if proxy := config.proxyForRequest(request); proxy != nil {
			t.Fatalf("bypassed target %q used proxy %v", target, proxy)
		}
	}
}

func TestWindowsSystemProxySupportsSingleAndSocksValues(t *testing.T) {
	for value, want := range map[string]string{
		"127.0.0.1:7890":       "http://127.0.0.1:7890",
		"socks=127.0.0.1:7891": "socks5://127.0.0.1:7891",
	} {
		config := parseWindowsProxyConfig(value, "")
		request, err := http.NewRequest(http.MethodGet, "https://www.dropbox.com/file", nil)
		if err != nil {
			t.Fatal(err)
		}
		proxy := config.proxyForRequest(request)
		if proxy == nil || proxy.String() != want {
			t.Fatalf("proxy config %q resolved to %v, want %s", value, proxy, want)
		}
	}
}
