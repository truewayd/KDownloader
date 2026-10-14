package downloader

import (
	"fmt"
	"net/http"
	"net/url"

	"truedown/internal/netproxy"
)

func validProxyMode(mode string) bool {
	return netproxy.ValidMode(mode)
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

func (s *taskDefaultsStore) proxySettings() netproxy.Settings {
	s.mu.Lock()
	values := normalizeProxyDefaults(s.state.Values)
	s.mu.Unlock()
	return netproxy.Settings{Mode: values.ProxyMode, Address: values.Proxy}
}

func (s *taskDefaultsStore) proxyForRequest(request *http.Request) (*url.URL, error) {
	return netproxy.ForRequest(request, s.proxySettings())
}

// Operational requests follow persisted proxy choices without task headers or extras.
func (m *Manager) ProxyForRequest(request *http.Request) (*url.URL, error) {
	return m.taskDefaults.proxyForRequest(request)
}

func hasTaskProxyExtras(opts Aria2Opts) bool {
	options := ariaOptions(&Task{Opts: opts}, false)
	for _, name := range []string{"all-proxy", "http-proxy", "https-proxy", "no-proxy"} {
		if _, exists := options[name]; exists {
			return true
		}
	}
	return false
}

func (m *Manager) proxyForTask(opts Aria2Opts) func(*http.Request) (*url.URL, error) {
	if opts.ProxyMode == "" && !hasTaskProxyExtras(opts) {
		return m.ProxyForRequest
	}
	return taskProxy(opts)
}

func (m *Manager) applyTaskProxy(options map[string]interface{}, task *Task) error {
	opts := task.Opts
	if task.UpdateDownload {
		return applyProxyForDownload(options, task.Link, m.ProxyForRequest)
	}
	if opts.ProxyMode == "" && hasTaskProxyExtras(opts) {
		return nil
	}
	return applyProxyForDownload(options, task.Link, m.proxyForTask(opts))
}

func (m *Manager) refreshUpdateProxy(task *Task) error {
	if !task.UpdateDownload {
		return nil
	}
	target, err := url.Parse(task.Link)
	if err != nil {
		return err
	}
	if netproxy.IsLoopback(target) {
		return nil
	}
	options := make(map[string]interface{})
	if err := m.applyTaskProxy(options, task); err != nil {
		return err
	}
	rpc, ok := m.rpc.(taskOptionsRPC)
	if !ok {
		return fmt.Errorf("engine does not support update proxy changes")
	}
	changes := make(map[string]string, len(options))
	for name, value := range options {
		changes[name] = value.(string)
	}
	return rpc.changeOptions(task.GID, changes)
}

func taskProxy(opts Aria2Opts) func(*http.Request) (*url.URL, error) {
	options := ariaOptions(&Task{Opts: opts}, false)
	return func(request *http.Request) (*url.URL, error) {
		if request == nil || request.URL == nil {
			return netproxy.ForRequest(request, netproxy.Settings{Mode: opts.ProxyMode})
		}
		value, _ := options[request.URL.Scheme+"-proxy"].(string)
		if value == "" {
			value, _ = options["all-proxy"].(string)
		}
		if opts.ProxyMode == "" {
			bypass, _ := options["no-proxy"].(string)
			if bypass == "*" {
				value = ""
			}
			if value != "" || bypass == "*" {
				selected, err := netproxy.Resolved(value)
				if err != nil {
					return nil, err
				}
				return selected(request)
			}
		}
		return netproxy.ForRequest(request, netproxy.Settings{Mode: opts.ProxyMode, Address: value})
	}
}

func applyDownloadProxy(options map[string]interface{}, link string, opts Aria2Opts) error {
	return applyProxyForDownload(options, link, taskProxy(opts))
}

func applyResolvedDownloadProxy(options map[string]interface{}, link, route string) error {
	proxy, err := netproxy.Resolved(route)
	if err != nil {
		return err
	}
	return applyProxyForDownload(options, link, proxy)
}

func applyProxyForDownload(options map[string]interface{}, link string, selectProxy func(*http.Request) (*url.URL, error)) error {
	request, err := http.NewRequest(http.MethodGet, link, nil)
	if err != nil || (request.URL.Scheme != "http" && request.URL.Scheme != "https") {
		return nil
	}
	proxy, err := selectProxy(request)
	if err != nil {
		return err
	}
	setDownloadProxy(options, proxy)
	return nil
}

func setDownloadProxy(options map[string]interface{}, proxy *url.URL) {
	value := ""
	if proxy != nil {
		value = proxy.String()
	}
	for _, name := range []string{"all-proxy", "http-proxy", "https-proxy"} {
		options[name] = value
	}
	// An explicit mode must override proxy variables inherited by aria2.
	if proxy == nil {
		options["no-proxy"] = "*"
	} else {
		options["no-proxy"] = ""
	}
}

func clientForTaskProxy(base *http.Client, opts Aria2Opts) (*http.Client, func()) {
	if (opts.ProxyMode == "" && !hasTaskProxyExtras(opts)) || base == nil {
		return base, func() {}
	}
	transport, ok := base.Transport.(*http.Transport)
	if !ok {
		return base, func() {}
	}
	copy := *base
	cloned := netproxy.WithProxy(transport, taskProxy(opts))
	copy.Transport = cloned
	return &copy, cloned.CloseIdleConnections
}

func validateProxyDefaults(v TaskDefaults) error {
	if err := netproxy.Validate(netproxy.Settings{Mode: v.ProxyMode, Address: v.Proxy}); err != nil {
		return &ValidationError{Message: err.Error()}
	}
	return nil
}
