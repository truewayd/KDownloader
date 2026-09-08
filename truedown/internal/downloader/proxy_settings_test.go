package downloader

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProxyModesReachTransportAndOverrideInheritedOptions(t *testing.T) {
	proxyHits := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxyHits++; w.WriteHeader(204) }))
	defer proxy.Close()
	opts := Aria2Opts{ProxyMode: "custom", ExtraArgs: []string{"--all-proxy=" + proxy.URL}}
	client, closeIdle := clientForTaskProxy(newDropboxHTTPClient(nil), opts)
	defer closeIdle()
	response, err := client.Get("http://unresolvable.invalid/file")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if proxyHits != 1 || response.StatusCode != 204 {
		t.Fatal("custom proxy was bypassed")
	}
	options := map[string]any{"http-proxy": "http://inherited.invalid", "https-proxy": "http://inherited.invalid"}
	if err := applyDownloadProxy(options, "https://example.com/file", opts); err != nil {
		t.Fatal(err)
	}
	if options["https-proxy"] != proxy.URL {
		t.Fatal(options)
	}
	opts.ProxyMode = "none"
	if err := applyDownloadProxy(options, "https://example.com/file", opts); err != nil {
		t.Fatal(err)
	}
	if options["all-proxy"] != "" || options["https-proxy"] != "" || options["http-proxy"] != "" || options["no-proxy"] != "*" {
		t.Fatal(options)
	}
	request, _ := http.NewRequest("GET", "https://example.com/file", nil)
	if selected, err := taskProxy(opts)(request); err != nil || selected != nil {
		t.Fatal(selected, err)
	}
}

func TestProxyDefaultsMigrateAndRejectInvalidChoices(t *testing.T) {
	if defaultTaskDefaults().ProxyMode != "system" {
		t.Fatal("fresh profiles must use system proxy")
	}
	legacy := defaultTaskDefaults()
	legacy.ProxyMode = ""
	legacy.Proxy = "http://127.0.0.1:7890"
	if normalizeProxyDefaults(legacy).ProxyMode != "custom" {
		t.Fatal("legacy custom proxy lost")
	}
	for _, mode := range []string{"invalid", "custom"} {
		value := defaultTaskDefaults()
		value.ProxyMode = mode
		if validateTaskDefaults(value) == nil {
			t.Fatal("invalid proxy accepted", mode)
		}
	}
}
