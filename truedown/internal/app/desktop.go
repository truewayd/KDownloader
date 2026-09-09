package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"truedown/internal/client"
	"truedown/internal/desktopbridge"
	"truedown/internal/profile"
	"truedown/internal/protocol"
	"truedown/internal/safefile"
)

type desktopCallbacks struct {
	ready  func(http.Handler)
	attach func(string, profile.Location) error
}

// RunDesktop supplies a private pipe to an owned core or a bridge to an existing
// same-profile service. EOF cancels only the process created for this session.
func RunDesktop(ctx context.Context, options Options, input io.ReadCloser, output io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	serveDone := make(chan error, 1)
	started := false
	options.desktop = &desktopCallbacks{
		ready: func(handler http.Handler) {
			started = true
			bridge := desktopbridge.New(output, true)
			go func() {
				err := bridge.Send(protocol.DesktopResponse{Event: "ready", ProtocolVersion: protocol.Version, Owned: true})
				if err == nil {
					err = bridge.Serve(ctx, input, handler)
				}
				serveDone <- err
				cancel()
			}()
		},
		attach: func(endpoint string, location profile.Location) error {
			handler, err := existingDesktopHandler(ctx, endpoint, location)
			if err != nil {
				return err
			}
			bridge := desktopbridge.New(output, false)
			if err := bridge.Send(protocol.DesktopResponse{Event: "ready", ProtocolVersion: protocol.Version, Owned: false}); err != nil {
				return err
			}
			return bridge.Serve(ctx, input, handler)
		},
	}
	err := Run(ctx, options)
	cancel()
	if started {
		if bridgeErr := <-serveDone; err == nil && bridgeErr != nil && !errors.Is(bridgeErr, context.Canceled) {
			err = bridgeErr
		}
	}
	return err
}

func existingDesktopHandler(ctx context.Context, endpoint string, location profile.Location) (http.Handler, error) {
	u, err := url.Parse(endpoint)
	if err != nil || !loopbackListener([]string{u.Host}) {
		return nil, fmt.Errorf("desktop attachment requires a loopback service")
	}
	token, err := desktopToken(location.DataDirectory)
	if err != nil {
		return nil, err
	}
	probe, err := client.New(endpoint, token)
	if err != nil {
		return nil, err
	}
	defer probe.Close()
	if _, err := probe.Handshake(ctx); err != nil {
		return nil, err
	}
	data, err := probe.Request(ctx, http.MethodGet, "/system/storage", nil)
	if err != nil {
		return nil, err
	}
	var active profile.Location
	if json.Unmarshal(data, &active) != nil {
		return nil, fmt.Errorf("invalid core storage identity")
	}
	left, err := filepath.Abs(active.DataDirectory)
	if err != nil {
		return nil, err
	}
	same := left == location.DataDirectory
	if runtime.GOOS == "windows" {
		same = strings.EqualFold(left, location.DataDirectory)
	}
	if !same {
		return nil, fmt.Errorf("listener belongs to a different TrueDown data directory")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	httpClient := &http.Client{Transport: transport, Timeout: 6 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	go func() { <-ctx.Done(); httpClient.CloseIdleConnections() }()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, err := desktopToken(location.DataDirectory)
		if err != nil {
			http.Error(w, "cannot read core credentials", http.StatusServiceUnavailable)
			return
		}
		request, err := http.NewRequestWithContext(r.Context(), r.Method, endpoint+r.URL.RequestURI(), r.Body)
		if err != nil {
			http.Error(w, "invalid core request", 400)
			return
		}
		request.Header = r.Header.Clone()
		if token != "" {
			request.Header.Set("X-Api-Key", token)
		}
		response, err := httpClient.Do(request)
		if err != nil {
			http.Error(w, "existing core disconnected", http.StatusServiceUnavailable)
			return
		}
		defer response.Body.Close()
		body, err := io.ReadAll(io.LimitReader(response.Body, protocol.MaxDesktopResponse+1))
		if err != nil {
			http.Error(w, "cannot read complete core response", http.StatusBadGateway)
			return
		}
		if len(body) > protocol.MaxDesktopResponse {
			http.Error(w, "core response exceeded its limit", http.StatusBadGateway)
			return
		}
		for _, key := range []string{"Content-Type", "ETag", "Retry-After", "X-TrueDown-Duplicate"} {
			if value := response.Header.Get(key); value != "" {
				w.Header().Set(key, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(body)
	}), nil
}

func desktopToken(root string) (string, error) {
	if token := os.Getenv("TRUEDOWN_API_TOKEN"); token != "" {
		return token, validateAPIToken(token)
	}
	location, err := profile.Resolve(root, "")
	if err != nil {
		return "", err
	}
	data, err := safefile.ReadFile(location.Paths.File(profile.Token), maxAPITokenFileBytes)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	token := storedAPIToken(data)
	return token, validateAPIToken(token)
}
