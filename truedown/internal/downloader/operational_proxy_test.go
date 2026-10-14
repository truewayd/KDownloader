package downloader

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOperationalProxyChoicesFollowSavedSettings(t *testing.T) {
	// Go caches environment proxies; isolate the system-mode fixture from other tests.
	if os.Getenv("TRUEDOWN_TEST_OPERATIONAL_PROXY") == "" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestOperationalProxyChoicesFollowSavedSettings$")
		cmd.Env = append(os.Environ(), "TRUEDOWN_TEST_OPERATIONAL_PROXY=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("proxy fixture: %v\n%s", err, output)
		}
		return
	}
	handler := func(route string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" || r.Header.Get("User-Agent") == "private-agent" {
				t.Error("task credentials reached an operational request")
			}
			w.Header().Set("X-Route", route)
			w.WriteHeader(http.StatusNoContent)
		}
	}
	system := httptest.NewServer(handler("system"))
	defer system.Close()
	custom := httptest.NewServer(handler("custom-http"))
	defer custom.Close()
	secure := httptest.NewTLSServer(handler("custom-https"))
	defer secure.Close()
	direct := httptest.NewServer(handler("none"))
	defer direct.Close()
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		t.Setenv(name, system.URL)
	}
	for _, name := range []string{"NO_PROXY", "no_proxy"} {
		t.Setenv(name, "")
	}
	root := t.TempDir()
	m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	moduleClient := moduleUpdateHTTPClient(m.ProxyForRequest)
	defer moduleClient.CloseIdleConnections()
	clients := []struct {
		name   string
		client *http.Client
	}{
		{"module-update", moduleClient}, {"dropbox", m.dropboxClient},
		{"google-drive", m.googleDriveClient}, {"tracker", m.trackerResearch.client},
	}
	directURL, _ := url.Parse(direct.URL)
	for _, fixture := range clients {
		transport := fixture.client.Transport.(*http.Transport)
		roots := x509.NewCertPool()
		roots.AddCert(secure.Certificate())
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
		dial := transport.DialContext
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if address == "proxy-choice.invalid:80" {
				address = directURL.Host
			}
			return dial(ctx, network, address)
		}
		fixture.client.Timeout = 3 * time.Second
	}
	for _, choice := range []struct{ mode, proxy, route string }{
		{"system", "", "system"}, {"custom", custom.URL, "custom-http"},
		{"custom", secure.URL, "custom-https"}, {"none", custom.URL, "none"},
		{"system", custom.URL, "system"},
	} {
		current := m.TaskDefaults()
		values := current.Values
		values.ProxyMode, values.Proxy = choice.mode, choice.proxy
		values.UserAgent, values.Referer, values.Headers = "private-agent", "https://private.invalid", `{"Cookie":"private-cookie"}`
		values.Extra = "--all-proxy=http://ignored.invalid"
		if _, err := m.SetTaskDefaults(current.Revision, values); err != nil {
			t.Fatal(err)
		}
		for _, fixture := range clients {
			response, err := fixture.client.Get("http://proxy-choice.invalid/file")
			if err != nil {
				t.Fatalf("%s/%s: %v", fixture.name, choice.route, err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent || response.Header.Get("X-Route") != choice.route {
				t.Fatalf("%s/%s used %s", fixture.name, choice.route, response.Header.Get("X-Route"))
			}
		}
		for _, target := range []string{direct.URL, "http://localhost:1234/", "http://localhost.:1234/", "http://[::1]:1234/", "http://127.0.0.2:1234/"} {
			request, _ := http.NewRequest(http.MethodGet, target, nil)
			if proxy, err := m.ProxyForRequest(request); err != nil || proxy != nil {
				t.Fatalf("%s proxied loopback %s", choice.route, target)
			}
		}
	}
}

func TestUpdateAdmissionUsesCurrentProxyAndKeepsRelayDirect(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	fake := &fakeAriaRPC{}
	m.rpc = fake
	for index, choice := range []struct{ mode, proxy, link, want string }{
		{"custom", "http://private:secret@127.0.0.1:7890", "https://github.com/module.bin", "http://private:secret@127.0.0.1:7890"},
		{"none", "http://unused.invalid", "https://github.com/module.bin", ""},
		{"custom", "https://127.0.0.1:7891", "https://github.com/module.bin", "https://127.0.0.1:7891"},
		{"custom", "http://127.0.0.1:7890", "http://127.0.0.1:1234/update/fixture", ""},
	} {
		// The queued task predates the preference change and has old direct options.
		task, _, err := m.addUpdateTask(choice.link, fmt.Sprintf("module-%d.bin", index), root, Aria2Opts{ProxyMode: "none"})
		if err != nil {
			t.Fatal(err)
		}
		m.flushAdmissions(false)
		current := m.TaskDefaults()
		values := current.Values
		values.ProxyMode, values.Proxy = choice.mode, choice.proxy
		values.Headers = `{"Cookie":"private-cookie"}`
		values.Extra = "--user-agent=private-agent"
		if _, err := m.SetTaskDefaults(current.Revision, values); err != nil {
			t.Fatal(err)
		}
		if !m.submit(submission{id: task.ID}) {
			t.Fatal("update task was not admitted")
		}
		options := fake.addedOptions[len(fake.addedOptions)-1]
		for _, key := range []string{"http-proxy", "https-proxy", "all-proxy"} {
			if options[key] != choice.want {
				t.Fatalf("%s/%s ignored the current proxy choice", choice.mode, key)
			}
		}
		bypass := ""
		if choice.want == "" {
			bypass = "*"
		}
		if options["no-proxy"] != bypass || options["user-agent"] != nil || len(fake.added[len(fake.added)-1].Headers) != 0 {
			t.Fatal("update routing or credential isolation changed")
		}
		encoded, err := json.Marshal(m.snapshotTask(task))
		if err != nil || strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "private-cookie") {
			t.Fatal("proxy credentials leaked into the public task snapshot")
		}
	}
}

func TestUpdateResumeRefreshesProxyBeforeIndividualAndQueueResume(t *testing.T) {
	for _, queue := range []bool{false, true} {
		t.Run(fmt.Sprintf("queue=%t", queue), func(t *testing.T) {
			root := t.TempDir()
			m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer m.Stop()
			rpc := &detailRPC{}
			m.rpc = rpc
			task, _, err := m.addUpdateTask("https://github.com/module.bin", "module.bin", root, Aria2Opts{})
			if err != nil {
				t.Fatal(err)
			}
			m.flushAdmissions(false)
			if !m.submit(submission{id: task.ID}) {
				t.Fatal("initial update admission failed")
			}
			for _, mode := range []string{"custom", "none", "custom"} {
				if result := m.PauseTasks([]int64{task.ID}); len(result.Failed) != 0 {
					t.Fatal(result)
				}
				current := m.TaskDefaults()
				values := current.Values
				values.ProxyMode, values.Proxy = mode, "https://127.0.0.1:7891"
				if _, err := m.SetTaskDefaults(current.Revision, values); err != nil {
					t.Fatal(err)
				}
				resume := func() TaskOperationResult {
					if queue {
						return m.ResumeQueue()
					}
					return m.ResumeTasks([]int64{task.ID})
				}
				rpc.fail = true
				beforeIndividual, beforeQueue := len(rpc.resumed), rpc.unpauseAllCalls
				if result := resume(); len(result.Failed) != 1 || len(rpc.resumed) != beforeIndividual || rpc.unpauseAllCalls != beforeQueue {
					t.Fatal("proxy refresh failure resumed an update using stale settings", result)
				}
				currentTask, _ := m.GetTask(task.ID)
				if currentTask.Status != StatusPaused {
					t.Fatal("failed proxy refresh changed pause intent")
				}
				rpc.fail = false
				if result := resume(); len(result.Failed) != 0 {
					t.Fatal(result)
				}
				changes := rpc.changes[len(rpc.changes)-1]
				want, bypass := values.Proxy, ""
				if mode == "none" {
					want, bypass = "", "*"
				}
				if changes["http-proxy"] != want || changes["https-proxy"] != want || changes["all-proxy"] != want || changes["no-proxy"] != bypass {
					t.Fatal("resumed update ignored the new proxy choice")
				}
			}
		})
	}
}

func TestUnspecifiedDownloadsAndMEGAUseSavedProxyWithoutChangingExplicitOptions(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	fake := &fakeAriaRPC{}
	m.rpc = fake
	for index, mode := range []string{"none", "custom", "none"} {
		current := m.TaskDefaults()
		values := current.Values
		values.ProxyMode, values.Proxy = mode, "http://127.0.0.1:7890"
		values.Headers = `{"Cookie":"default-cookie"}`
		if _, err := m.SetTaskDefaults(current.Revision, values); err != nil {
			t.Fatal(err)
		}
		task, _, err := m.AddTask("https://example.com/file", fmt.Sprintf("file-%d", index), root, map[string]string{"Cookie": "explicit-cookie"}, "", 0, Aria2Opts{Connections: 2})
		if err != nil {
			t.Fatal(err)
		}
		m.flushAdmissions(false)
		if !m.submit(submission{id: task.ID}) {
			t.Fatal("ordinary task was not admitted")
		}
		options := fake.addedOptions[len(fake.addedOptions)-1]
		want, bypass := values.Proxy, ""
		if mode == "none" {
			want, bypass = "", "*"
		}
		if options["https-proxy"] != want || options["no-proxy"] != bypass || options["split"] != "2" || fake.added[len(fake.added)-1].Headers["Cookie"] != "explicit-cookie" {
			t.Fatal("profile proxy selection replaced task parameters or credentials")
		}
		if route, err := m.megaTaskProxy(Aria2Opts{}); err != nil || route != want {
			t.Fatal("MEGA metadata did not use the same saved proxy choice")
		}
		for _, explicit := range []Aria2Opts{
			{ProxyMode: "none"},
			{ProxyMode: "custom", ExtraArgs: []string{"--all-proxy=https://127.0.0.1:7891"}},
			{ExtraArgs: []string{"--all-proxy=https://127.0.0.1:7891"}},
		} {
			options := ariaOptions(&Task{Opts: explicit}, false)
			if err := m.applyTaskProxy(options, &Task{Link: task.Link, Opts: explicit}); err != nil {
				t.Fatal(err)
			}
			want := "https://127.0.0.1:7891"
			if explicit.ProxyMode == "none" {
				want = ""
			}
			if options["all-proxy"] != want {
				t.Fatal("saved preferences replaced an explicit task proxy")
			}
			if route, err := m.megaTaskProxy(explicit); err != nil || route != want {
				t.Fatal("MEGA replaced an explicit task proxy")
			}
		}
	}
}
