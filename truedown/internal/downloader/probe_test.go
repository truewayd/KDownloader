package downloader

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeProbeRPC struct {
	*fakeAriaRPC
	entered chan map[string]any
	release chan struct{}
}

func (*fakeProbeRPC) capabilities() EngineCapabilities { return EngineCapabilities{Probe: true} }
func (rpc *fakeProbeRPC) probe(ctx context.Context, _ string, options map[string]any) (ariaProbeResult, error) {
	rpc.entered <- options
	select {
	case <-ctx.Done():
		return ariaProbeResult{}, ctx.Err()
	case <-rpc.release:
	}
	return ariaProbeResult{Status: "206", TotalLength: "1024", Resumable: "true"}, nil
}

func TestProbeCancellationKeepsNativeConcurrencyBound(t *testing.T) {
	m, base := transferTestManager(t)
	m.aria2Next, m.aria2NextVersion = true, "3.0.0"
	rpc := &fakeProbeRPC{fakeAriaRPC: base, entered: make(chan map[string]any, 4), release: make(chan struct{})}
	m.rpc = rpc
	defer close(rpc.release)
	for i := 0; i < 4; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		finished := make(chan error, 1)
		go func() {
			_, err := m.ProbeLink(ctx, "https://example.test/file", map[string]string{"Cookie": "private"}, "https://example.test/page", Aria2Opts{ProxyMode: "none", ExtraArgs: []string{"gid=ignored", "out=ignored", "load-cookies=ignored", "user-agent=ProbeFixture"}})
			finished <- err
		}()
		var options map[string]any
		select {
		case options = <-rpc.entered:
		case <-time.After(3 * time.Second):
			t.Fatal("probe did not start")
		}
		if options["gid"] != nil || options["out"] != nil || options["load-cookies"] != nil || options["media"] != nil || options["header"] == nil || options["user-agent"] != "ProbeFixture" || options["no-proxy"] != "*" {
			t.Fatal("probe options lost transport settings or gained task side effects", options)
		}
		cancel()
		if err := <-finished; !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	}
	if _, err := m.ProbeLink(context.Background(), "https://example.test/fifth", nil, "", Aria2Opts{}); !errors.Is(err, ErrProbeBusy) {
		t.Fatal("canceled clients bypassed native limit", err)
	}
	if m.probeReads.Load() != 4 || len(m.ListTasks()) != 0 || len(base.added) != 0 {
		t.Fatal("probe admitted tasks or lost outstanding jobs")
	}
}

func TestProbeValidationAndPublicResult(t *testing.T) {
	m, _ := transferTestManager(t)
	for _, link := range []string{"magnet:?xt=urn:btih:abc", "file:///tmp/file", "https://user:secret@example.test/file"} {
		if _, err := m.ProbeLink(context.Background(), link, nil, "", Aria2Opts{}); !IsValidationError(err) {
			t.Fatal(link, err)
		}
	}
	if _, err := m.ProbeLink(context.Background(), "https://example.test/file", nil, "", Aria2Opts{}); !errors.Is(err, ErrProbeUnavailable) {
		t.Fatal(err)
	}
	for _, raw := range []ariaProbeResult{
		{Status: "404", Error: "Cookie: private", TotalLength: "123", Resumable: "true"},
		{Status: "bad", Error: "token=private", FinalURL: "https://user:private@example.test"},
	} {
		result := publicProbeResult(raw)
		data, _ := json.Marshal(result)
		if strings.Contains(string(data), "private") || result.TotalLength != nil || result.Resumable || result.ErrorCode == "" {
			t.Fatal(string(data))
		}
	}
	zero := publicProbeResult(ariaProbeResult{Status: "200", TotalLength: "0"})
	unknown := publicProbeResult(ariaProbeResult{Status: "200", TotalLength: "-1"})
	if zero.TotalLength == nil || *zero.TotalLength != 0 || unknown.TotalLength != nil {
		t.Fatal("unknown length became an empty file")
	}
}

func TestProbeRPCUsesNativeMethodAndIndependentTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string
			Params []json.RawMessage
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request.Method != "aria2.probe" || len(request.Params) != 3 || string(request.Params[0]) != `"token:secret"` {
			t.Errorf("invalid native call: %+v", request)
		}
		time.Sleep(20 * time.Millisecond)
		_, _ = w.Write([]byte(`{"result":{"status":"206","finalUrl":"https://example.test/file","filename":"Native.bin","contentType":"application/octet-stream","totalLength":"42","resumable":"true"}}`))
	}))
	defer server.Close()
	client := newAriaClient(1, "secret")
	client.url, client.http.Timeout = server.URL, time.Millisecond
	result, err := client.probe(context.Background(), "https://example.test/file", nil)
	if err != nil || result.TotalLength != "42" || result.FinalURL != "https://example.test/file" || result.Filename != "Native.bin" || client.http.Timeout != time.Millisecond {
		t.Fatal(result, err)
	}
}
