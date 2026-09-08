package downloader

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

func validProxyMode(mode string) bool {
	return mode == "" || mode == "system" || mode == "custom" || mode == "none"
}

func normalizeProxyDefaults(v TaskDefaults) TaskDefaults {
	if v.ProxyMode == "" {
		if v.Proxy != "" {
			v.ProxyMode = "custom"
		} else {
			v.ProxyMode = "system"
		}
	}
	return v
}

func taskProxy(opts Aria2Opts) func(*http.Request) (*url.URL, error) {
	if opts.ProxyMode == "none" {
		return func(*http.Request) (*url.URL, error) { return nil, nil }
	}
	if opts.ProxyMode != "custom" {
		return systemProxyFunc()
	}
	options := ariaOptions(&Task{Opts: opts}, false)
	return func(request *http.Request) (*url.URL, error) {
		value, _ := options[request.URL.Scheme+"-proxy"].(string)
		if value == "" {
			value, _ = options["all-proxy"].(string)
		}
		if value == "" {
			return nil, fmt.Errorf("custom proxy address is required")
		}
		proxy, err := url.Parse(value)
		if err != nil || proxy.Hostname() == "" || (proxy.Scheme != "http" && proxy.Scheme != "https") {
			return nil, fmt.Errorf("invalid HTTP(S) proxy address")
		}
		return proxy, nil
	}
}

func applyDownloadProxy(options map[string]interface{}, link string, opts Aria2Opts) error {
	request, err := http.NewRequest(http.MethodGet, link, nil)
	if err != nil || (request.URL.Scheme != "http" && request.URL.Scheme != "https") {
		return nil
	}
	proxy, err := taskProxy(opts)(request)
	if err != nil {
		return err
	}
	value := ""
	if proxy != nil {
		value = proxy.String()
	}
	for _, name := range []string{"all-proxy", "http-proxy", "https-proxy"} {
		options[name] = value
	}
	// An explicit mode must override proxy variables inherited by aria2.
	if opts.ProxyMode == "none" {
		options["no-proxy"] = "*"
	} else {
		options["no-proxy"] = ""
	}
	return nil
}

func clientForTaskProxy(base *http.Client, opts Aria2Opts) (*http.Client, func()) {
	if opts.ProxyMode == "" || base == nil {
		return base, func() {}
	}
	transport, ok := base.Transport.(*http.Transport)
	if !ok {
		return base, func() {}
	}
	copy := *base
	cloned := transport.Clone()
	cloned.Proxy = taskProxy(opts)
	copy.Transport = cloned
	return &copy, cloned.CloseIdleConnections
}

func validateProxyDefaults(v TaskDefaults) error {
	if !validProxyMode(v.ProxyMode) {
		return &ValidationError{Message: "invalid proxy mode"}
	}
	if strings.ContainsAny(v.Proxy, "\r\n\x00") {
		return &ValidationError{Message: "invalid proxy address"}
	}
	if v.ProxyMode == "custom" {
		request, _ := http.NewRequest(http.MethodGet, "https://example.com", nil)
		if _, err := taskProxy(v.options())(request); err != nil {
			return &ValidationError{Message: err.Error()}
		}
	}
	return nil
}
