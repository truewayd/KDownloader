//go:build windows

package downloader

import (
	"net/http"
	"net/url"
	"os"
	"path"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var (
	winHTTPDLL                        = syscall.NewLazyDLL("winhttp.dll")
	winHttpGetIEProxyConfigForCurrent = winHTTPDLL.NewProc("WinHttpGetIEProxyConfigForCurrentUser")
	proxyKernel32DLL                  = syscall.NewLazyDLL("kernel32.dll")
	globalFree                        = proxyKernel32DLL.NewProc("GlobalFree")
	lstrlenW                          = proxyKernel32DLL.NewProc("lstrlenW")
	proxyRtlMoveMemory                = proxyKernel32DLL.NewProc("RtlMoveMemory")
)

type winHTTPCurrentUserProxyConfig struct {
	autoDetect    int32
	autoConfigURL uintptr
	proxy         uintptr
	proxyBypass   uintptr
}

type windowsProxyConfig struct {
	proxies map[string]*url.URL
	bypass  []string
}

func systemProxyFunc() func(*http.Request) (*url.URL, error) {
	config := currentWindowsProxyConfig()
	return func(request *http.Request) (*url.URL, error) {
		if proxyEnvironmentConfigured(request) {
			return http.ProxyFromEnvironment(request)
		}
		return config.proxyForRequest(request), nil
	}
}

func proxyEnvironmentConfigured(request *http.Request) bool {
	names := []string{"HTTP_PROXY", "http_proxy"}
	if request != nil && request.URL != nil && strings.EqualFold(request.URL.Scheme, "https") {
		names = []string{"HTTPS_PROXY", "https_proxy"}
	}
	for _, name := range names {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return true
		}
	}
	return false
}

func currentWindowsProxyConfig() windowsProxyConfig {
	var raw winHTTPCurrentUserProxyConfig
	ok, _, _ := winHttpGetIEProxyConfigForCurrent.Call(uintptr(unsafe.Pointer(&raw)))
	if ok == 0 {
		return windowsProxyConfig{}
	}
	defer freeWindowsProxyString(raw.autoConfigURL)
	defer freeWindowsProxyString(raw.proxy)
	defer freeWindowsProxyString(raw.proxyBypass)
	return parseWindowsProxyConfig(windowsUTF16String(raw.proxy), windowsUTF16String(raw.proxyBypass))
}

func freeWindowsProxyString(pointer uintptr) {
	if pointer != 0 {
		globalFree.Call(pointer)
	}
}

func windowsUTF16String(pointer uintptr) string {
	if pointer == 0 {
		return ""
	}
	length, _, _ := lstrlenW.Call(pointer)
	const maxProxyStringLength = 32 * 1024
	if length == 0 || length > maxProxyStringLength {
		return ""
	}
	data := make([]uint16, int(length))
	proxyRtlMoveMemory.Call(uintptr(unsafe.Pointer(&data[0])), pointer, length*2)
	runtime.KeepAlive(data)
	return syscall.UTF16ToString(data)
}

func parseWindowsProxyConfig(proxyValue, bypassValue string) windowsProxyConfig {
	config := windowsProxyConfig{proxies: make(map[string]*url.URL)}
	for _, entry := range strings.Split(proxyValue, ";") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name := "default"
		address := entry
		if parts := strings.SplitN(entry, "=", 2); len(parts) == 2 {
			name = strings.ToLower(strings.TrimSpace(parts[0]))
			address = strings.TrimSpace(parts[1])
		}
		proxyURL := parseWindowsProxyURL(name, address)
		if proxyURL != nil {
			config.proxies[name] = proxyURL
		}
	}
	for _, entry := range strings.Split(bypassValue, ";") {
		if entry = strings.ToLower(strings.TrimSpace(entry)); entry != "" {
			config.bypass = append(config.bypass, entry)
		}
	}
	return config
}

func parseWindowsProxyURL(name, address string) *url.URL {
	if address == "" {
		return nil
	}
	if !strings.Contains(address, "://") {
		if name == "socks" || name == "socks5" {
			address = "socks5://" + address
		} else {
			address = "http://" + address
		}
	}
	parsed, err := url.Parse(address)
	if err != nil || parsed.Host == "" {
		return nil
	}
	return parsed
}

func (config windowsProxyConfig) proxyForRequest(request *http.Request) *url.URL {
	if request == nil || request.URL == nil || config.bypasses(request.URL.Hostname()) {
		return nil
	}
	if proxy := config.proxies[strings.ToLower(request.URL.Scheme)]; proxy != nil {
		return proxy
	}
	if proxy := config.proxies["default"]; proxy != nil {
		return proxy
	}
	return config.proxies["socks"]
}

func (config windowsProxyConfig) bypasses(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	for _, rule := range config.bypass {
		if rule == "<local>" && !strings.Contains(host, ".") {
			return true
		}
		if rule == host || (strings.HasPrefix(rule, ".") && strings.HasSuffix(host, rule)) {
			return true
		}
		if strings.ContainsAny(rule, "*?") {
			if matched, _ := path.Match(rule, host); matched {
				return true
			}
		}
	}
	return false
}
