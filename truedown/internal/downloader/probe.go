package downloader

import (
	"context"
	"errors"
	"strconv"
	"time"
)

var ErrProbeUnavailable = errors.New("link probing requires a compatible NEXT engine")
var ErrProbeBusy = errors.New("link probing is busy; try again shortly")
var ErrProbeFailed = errors.New("the engine could not probe this link")

// ProbeResult contains metadata only. Raw native errors may embed URLs or
// credentials and must never cross the public API boundary.
type ProbeResult struct {
	Status      int    `json:"status"`
	FinalURL    string `json:"finalUrl,omitempty"`
	Filename    string `json:"filename,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	TotalLength *int64 `json:"totalLength,omitempty"`
	Resumable   bool   `json:"resumable"`
	ErrorCode   string `json:"errorCode,omitempty"`
}

type ariaProbeResult struct {
	Status, FinalURL, Filename, ContentType, TotalLength, Resumable, Error string
}

type nativeProbeRPC interface {
	probe(context.Context, string, map[string]any) (ariaProbeResult, error)
}

func (c *ariaClient) probe(ctx context.Context, link string, options map[string]any) (ariaProbeResult, error) {
	// NEXT bounds the complete exchange, including redirects, at 20 seconds.
	// Keep ordinary RPC calls on their shorter timeout and their shared ID source.
	client := *c.http
	client.Timeout = 25 * time.Second
	var result ariaProbeResult
	err := c.callWithHTTP(ctx, &client, "aria2.probe", []any{link, options}, &result)
	return result, err
}

func (m *Manager) ProbeLink(ctx context.Context, link string, headers map[string]string, page string, opts Aria2Opts) (ProbeResult, error) {
	identity := normalizeRequest(link, "", "", m.defaultDir, headers, page, 0, opts)
	if err := validateRequest(identity); err != nil {
		return ProbeResult{}, err
	}
	if opts.Media != nil {
		return ProbeResult{}, &ValidationError{Message: "link probing does not accept media task options"}
	}
	if err := validateMediaExtraArgs(opts); err != nil {
		return ProbeResult{}, err
	}
	rpc, ok := m.rpc.(nativeProbeRPC)
	if !ok || !m.EngineCapabilities().Probe || m.lifecycleCtx.Err() != nil {
		return ProbeResult{}, ErrProbeUnavailable
	}
	if err := ctx.Err(); err != nil {
		return ProbeResult{}, err
	}
	options := ariaOptions(&Task{Headers: identity.Headers, DownloadPage: identity.DownloadPage, Opts: opts}, false)
	if err := m.applyTaskProxy(options, &Task{Link: identity.Link, Opts: opts}); err != nil {
		return ProbeResult{}, &ValidationError{Message: "invalid probe proxy configuration"}
	}
	// Only transport settings apply. A probe has no GID, output, queue position,
	// checkpoint, resolver, or publication side effects.
	for key := range options {
		switch key {
		case "header", "referer", "user-agent", "http-user", "http-passwd", "http-no-cache",
			"all-proxy", "http-proxy", "https-proxy", "no-proxy",
			"all-proxy-user", "all-proxy-passwd", "http-proxy-user", "http-proxy-passwd", "https-proxy-user", "https-proxy-passwd",
			"check-certificate", "min-tls-version", "connect-timeout", "timeout", "disable-ipv6", "interface":
		default:
			delete(options, key)
		}
	}
	options["no-netrc"] = "true"
	if m.probeReads.Add(1) > 4 {
		m.probeReads.Add(-1)
		return ProbeResult{}, ErrProbeBusy
	}
	type outcome struct {
		value ariaProbeResult
		err   error
	}
	finished := make(chan outcome, 1)
	go func() {
		defer m.probeReads.Add(-1)
		// Closing the UI/RPC connection does not cancel NEXT's native operation.
		// Keep its slot until the engine responds or its bounded lifetime expires.
		probeCtx, cancel := context.WithTimeout(m.lifecycleCtx, 22*time.Second)
		defer cancel()
		value, err := rpc.probe(probeCtx, identity.Link, options)
		finished <- outcome{value, err}
		if err != nil {
			<-probeCtx.Done()
		}
	}()
	select {
	case <-ctx.Done():
		return ProbeResult{}, ctx.Err()
	case result := <-finished:
		if result.err != nil {
			return ProbeResult{}, ErrProbeFailed
		}
		return publicProbeResult(result.value), nil
	}
}

func publicProbeResult(value ariaProbeResult) ProbeResult {
	status, _ := strconv.Atoi(value.Status)
	if status < 100 || status > 599 {
		status = 0
	}
	result := ProbeResult{Status: status, Filename: truncateText(value.Filename, 1024), ContentType: truncateText(value.ContentType, 256)}
	if validateDownloadURL(value.FinalURL) == nil {
		result.FinalURL = value.FinalURL
	}
	if status >= 200 && status < 300 && value.Error == "" {
		result.Resumable = value.Resumable == "true"
		if size, err := strconv.ParseInt(value.TotalLength, 10, 64); err == nil && size >= 0 {
			result.TotalLength = &size
		}
	} else if status >= 400 {
		result.ErrorCode = "http_error"
	} else {
		result.ErrorCode = "probe_failed"
	}
	return result
}
