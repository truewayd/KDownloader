// Package netproxy is the shared outbound proxy policy for TrueDown.
package netproxy

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type Settings struct {
	Mode    string
	Address string
}

func ValidMode(mode string) bool {
	return mode == "" || mode == "system" || mode == "custom" || mode == "none"
}

func Validate(settings Settings) error {
	_, err := validateSettings(settings, false)
	return err
}

func validateSettings(settings Settings, resolved bool) (*url.URL, error) {
	if !ValidMode(settings.Mode) {
		return nil, fmt.Errorf("invalid proxy mode")
	}
	if strings.ContainsAny(settings.Address, "\r\n\x00") {
		return nil, fmt.Errorf("invalid proxy address")
	}
	if settings.Mode == "custom" {
		return customProxy(settings.Address, resolved)
	}
	return nil, nil
}

func customProxy(address string, resolved bool) (*url.URL, error) {
	if address == "" {
		return nil, fmt.Errorf("custom proxy address is required")
	}
	proxy, err := url.Parse(address)
	if err != nil || proxy.Hostname() == "" || (proxy.Scheme != "http" && proxy.Scheme != "https" && !(resolved && (proxy.Scheme == "socks5" || proxy.Scheme == "socks5h"))) {
		return nil, fmt.Errorf("invalid HTTP(S) proxy address")
	}
	return proxy, nil
}

func IsLoopback(target *url.URL) bool {
	if target == nil {
		return false
	}
	host := target.Hostname()
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

// ForRequest is the only proxy decision path. Callers supply current settings;
// loopback stays direct and system mode reads the current OS configuration.
func ForRequest(request *http.Request, settings Settings) (*url.URL, error) {
	return forRequest(request, settings, false)
}

func forRequest(request *http.Request, settings Settings, resolved bool) (*url.URL, error) {
	if request == nil || request.URL == nil {
		return nil, fmt.Errorf("invalid proxy request")
	}
	proxy, err := validateSettings(settings, resolved)
	if err != nil {
		return nil, err
	}
	if settings.Mode == "none" || IsLoopback(request.URL) || (request.URL.Scheme != "http" && request.URL.Scheme != "https") {
		return nil, nil
	}
	if settings.Mode == "custom" {
		return proxy, nil
	}
	return systemProxyFunc()(request)
}

func System(request *http.Request) (*url.URL, error) {
	return ForRequest(request, Settings{Mode: "system"})
}

// Resolved adapts a parent-selected route for a module process; an empty route
// stays direct even when that process inherits proxy environment variables.
func Resolved(address string) (func(*http.Request) (*url.URL, error), error) {
	settings := Settings{Mode: "custom", Address: address}
	if address == "" {
		settings.Mode = "none"
	}
	if len(address) > 4096 {
		return nil, fmt.Errorf("invalid proxy address")
	}
	if _, err := validateSettings(settings, true); err != nil {
		return nil, err
	}
	return func(request *http.Request) (*url.URL, error) {
		return forRequest(request, settings, true)
	}, nil
}

// NewTransport always sets a policy explicitly; nil is reserved for local IPC.
func NewTransport(proxy func(*http.Request) (*url.URL, error)) *http.Transport {
	return WithProxy(http.DefaultTransport.(*http.Transport), proxy)
}

func WithProxy(base *http.Transport, proxy func(*http.Request) (*url.URL, error)) *http.Transport {
	transport := base.Clone()
	transport.Proxy = proxy
	return transport
}
