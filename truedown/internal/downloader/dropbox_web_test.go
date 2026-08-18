package downloader

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseDropboxWebShareUsesCurrentSecureHash(t *testing.T) {
	share, ok := parseDropboxWebShare("https://www.dropbox.com/scl/fo/link-key/secure-hash/a%20folder?rlkey=read-key&dl=1")
	if !ok {
		t.Fatal("current Dropbox folder link was not parsed")
	}
	if share.LinkKey != "link-key" || share.SecureHash != "secure-hash" || share.SubPath != "/a folder" || share.RLKey != "read-key" {
		t.Fatalf("unexpected Dropbox share: %+v", share)
	}
	root, ok := parseDropboxWebShare("https://www.dropbox.com/scl/fo/link-key/root-hash?dl=1")
	if !ok || root.SubPath != "" {
		t.Fatalf("unexpected root Dropbox share: %+v, ok=%v", root, ok)
	}
	for _, invalid := range []string{
		"http://www.dropbox.com/scl/fo/link-key/hash?dl=1",
		"https://notdropbox.com/scl/fo/link-key/hash?dl=1",
		"https://www.dropbox.com/scl/fi/link-key/hash?dl=1",
	} {
		if _, ok := parseDropboxWebShare(invalid); ok {
			t.Fatalf("invalid Dropbox folder link was accepted: %s", invalid)
		}
	}
}

func TestDropboxFilterApplicationIsChosenPerExpansion(t *testing.T) {
	rules := DownloadRules{Enabled: false, ExcludedExtensions: []string{".PSD"}}
	excluded, err := normalizeDropboxExcludedExtensions(rules, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := excluded[".psd"]; !ok {
		t.Fatalf("explicit filter choice did not use persisted suffixes: %v", excluded)
	}
	excluded, err = normalizeDropboxExcludedExtensions(DownloadRules{
		Enabled: true, ExcludedExtensions: []string{".psd"},
	}, false)
	if err != nil || len(excluded) != 0 {
		t.Fatalf("disabled per-expansion filter=%v err=%v", excluded, err)
	}
}

func TestDropboxFolderCrawlsSiblingDirectoriesConcurrently(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	jar, _ := cookiejar.New(nil)
	var active atomic.Int64
	var maximum atomic.Int64
	manager.dropboxClient = &http.Client{
		Jar: jar,
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method == http.MethodGet {
				return dropboxTestResponse(request, http.StatusOK, "page", http.Header{
					"Set-Cookie": []string{"__Host-js_csrf=test-csrf; Path=/; Secure"},
				}), nil
			}
			if err := request.ParseForm(); err != nil {
				return nil, err
			}
			form := request.PostForm
			if form.Get("secure_hash") == "root-hash" {
				return dropboxTestJSON(request, `{
					"folder":{"filename":"root","is_dir":true},
					"entries":[
						{"filename":"a","href":"https://www.dropbox.com/scl/fo/root-key/a-hash/a?dl=0","is_dir":true},
						{"filename":"b","href":"https://www.dropbox.com/scl/fo/root-key/b-hash/b?dl=0","is_dir":true}
					]
				}`), nil
			}
			current := active.Add(1)
			for {
				previous := maximum.Load()
				if current <= previous || maximum.CompareAndSwap(previous, current) {
					break
				}
			}
			time.Sleep(40 * time.Millisecond)
			active.Add(-1)
			name := strings.TrimPrefix(form.Get("sub_path"), "/")
			return dropboxTestJSON(request, fmt.Sprintf(`{
				"folder":{"filename":%q,"is_dir":true},
				"entries":[{"filename":%q,"href":"https://www.dropbox.com/scl/fo/root-key/%s-file-hash/%s/file.bin?dl=0","is_dir":false}]
			}`, name, name+".bin", name, name)), nil
		}),
	}
	result, handled, err := manager.AddDropboxFolder(
		context.Background(),
		"https://www.dropbox.com/scl/fo/root-key/root-hash?dl=0",
		"", nil, "", 0, Aria2Opts{}, false,
	)
	if err != nil || !handled || len(result.Tasks) != 2 || maximum.Load() < 2 {
		t.Fatalf("parallel crawl handled=%v tasks=%d max=%d err=%v", handled, len(result.Tasks), maximum.Load(), err)
	}
}

func TestAddDropboxFolderRecursesPaginatesFiltersAndCreatesResumableFiles(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	var requests []url.Values
	manager.dropboxClient = &http.Client{
		Jar: jar,
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method == http.MethodGet {
				return dropboxTestResponse(request, http.StatusOK, `<html></html>`, http.Header{
					"Set-Cookie": []string{"__Host-js_csrf=test-csrf; Path=/; Secure"},
				}), nil
			}
			if request.URL.String() != dropboxFolderEntriesEndpoint || request.Method != http.MethodPost {
				return nil, fmt.Errorf("unexpected request: %s %s", request.Method, request.URL)
			}
			if err := request.ParseForm(); err != nil {
				return nil, err
			}
			form := request.PostForm
			requests = append(requests, form)
			if form.Get("t") != "test-csrf" || form.Get("link_key") != "root-key" || form.Get("link_type") != "c" {
				return nil, fmt.Errorf("missing Dropbox web request fields: %v", form)
			}
			switch {
			case form.Get("secure_hash") == "root-hash" && form.Get("voucher") == "":
				return dropboxTestJSON(request, `{
					"folder":{"filename":"Shared Root","href":"https://www.dropbox.com/scl/fo/root-key/root-hash?rlkey=read-key&dl=0","is_dir":true},
					"entries":[
						{"filename":"nested","href":"https://www.dropbox.com/scl/fo/root-key/child-hash/nested?rlkey=read-key&dl=0","is_dir":true},
						{"filename":"readme.txt","href":"https://www.dropbox.com/scl/fo/root-key/text-hash/readme.txt?rlkey=read-key&dl=0","is_dir":false,"bytes":12}
					],
					"has_more_entries":true,"next_request_voucher":"next-page"
				}`), nil
			case form.Get("secure_hash") == "root-hash" && form.Get("voucher") == "next-page":
				return dropboxTestJSON(request, `{
					"folder":{"filename":"Shared Root","is_dir":true},
					"entries":[{"filename":"source.PSD","href":"https://www.dropbox.com/scl/fo/root-key/psd-hash/source.PSD?rlkey=read-key&dl=0","is_dir":false,"bytes":100}],
					"has_more_entries":false
				}`), nil
			case form.Get("secure_hash") == "child-hash" && form.Get("sub_path") == "/nested":
				return dropboxTestJSON(request, `{
					"folder":{"filename":"nested","is_dir":true},
					"entries":[{"filename":"image.png","href":"https://www.dropbox.com/scl/fo/root-key/image-hash/nested/image.png?rlkey=read-key&dl=0","is_dir":false,"bytes":2048}],
					"has_more_entries":false
				}`), nil
			default:
				return nil, fmt.Errorf("unexpected Dropbox form: %v", form)
			}
		}),
	}
	if _, err := manager.SetDownloadRules(DownloadRules{
		Enabled: true, ExcludedExtensions: []string{".psd"},
	}); err != nil {
		t.Fatal(err)
	}

	result, handled, err := manager.AddDropboxFolder(
		context.Background(),
		"https://www.dropbox.com/scl/fo/root-key/root-hash?rlkey=read-key&dl=1",
		filepath.Join(root, "target"),
		nil,
		"",
		0,
		Aria2Opts{},
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !handled || len(result.Tasks) != 2 || result.Filtered != 1 || len(requests) != 3 {
		t.Fatalf("unexpected expansion: handled=%v result=%+v requests=%d", handled, result, len(requests))
	}

	byName := make(map[string]*Task)
	for _, task := range result.Tasks {
		byName[task.Name] = task
		if !task.DropboxDirect || isDropboxFolderDownload(task.Link) || !strings.Contains(task.Link, "dl=1") {
			t.Fatalf("expanded file is not a stable resumable Dropbox task: %+v", task)
		}
	}
	if got := byName["readme.txt"].Folder; got != filepath.Join(root, "target", "Shared Root") {
		t.Fatalf("root file folder=%q", got)
	}
	image := byName["image.png"]
	if image == nil || image.Folder != filepath.Join(root, "target", "Shared Root", "nested") {
		t.Fatalf("nested file task=%+v", image)
	}

	partial := filepath.Join(image.Folder, image.OutputName)
	if err := os.MkdirAll(image.Folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial+".aria2", []byte("control"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager.failTask(image.ID, fmt.Errorf("temporary Dropbox URL expired"))
	renewedLink := image.Link + "&st=renewed"
	renewed, duplicate, err := manager.AddTask(renewedLink, image.Name, image.Folder, nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate || renewed.ID != image.ID || renewed.Link != renewedLink {
		t.Fatalf("expanded file did not resume in place: original=%+v renewed=%+v", image, renewed)
	}
	options := ariaOptions(renewed, false)
	if options["continue"] != "true" || options["check-integrity"] != "true" {
		t.Fatalf("expanded file resume options=%v", options)
	}
}

func TestAddDropboxFolderFallsBackForIndividualFolderViewFile(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	jar, _ := cookiejar.New(nil)
	manager.dropboxClient = &http.Client{
		Jar: jar,
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method == http.MethodGet {
				return dropboxTestResponse(request, http.StatusOK, "page", http.Header{
					"Set-Cookie": []string{"__Host-js_csrf=test-csrf; Path=/; Secure"},
				}), nil
			}
			return dropboxTestJSON(request, `{}`), nil
		}),
	}
	result, handled, err := manager.AddDropboxFolder(
		context.Background(),
		"https://www.dropbox.com/scl/fo/root-key/file-hash/file.png?dl=1",
		"", nil, "", 0, Aria2Opts{}, false,
	)
	if err != nil || handled || len(result.Tasks) != 0 {
		t.Fatalf("individual file fallback: handled=%v result=%+v err=%v", handled, result, err)
	}
}

func TestDropboxFolderLive(t *testing.T) {
	link := strings.TrimSpace(os.Getenv("TRUEDOWN_DROPBOX_TEST_URL"))
	if link == "" {
		t.Skip("set TRUEDOWN_DROPBOX_TEST_URL to exercise the current Dropbox web protocol")
	}
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	if _, err := manager.SetDownloadRules(DownloadRules{
		Enabled: true, ExcludedExtensions: []string{".psd"},
	}); err != nil {
		t.Fatal(err)
	}
	result, handled, err := manager.AddDropboxFolder(
		context.Background(), link, "", nil, "", 0, Aria2Opts{}, true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !handled || len(result.Tasks) == 0 {
		t.Fatalf("live Dropbox folder was not expanded: handled=%v result=%+v", handled, result)
	}
	for _, task := range result.Tasks {
		if strings.HasSuffix(strings.ToLower(task.Name), ".psd") || !task.DropboxDirect {
			t.Fatalf("live expansion returned an invalid task: %+v", task)
		}
	}
	metadata, err := resolveDropboxDirectURL(result.Tasks[0], manager.dropboxClient)
	if err != nil {
		t.Fatalf("resolve expanded Dropbox file: %v", err)
	}
	if !metadata.LengthKnown || metadata.Length <= 0 || metadata.Name == "" {
		t.Fatalf("expanded Dropbox file has incomplete resume identity: %+v", metadata)
	}
	rangeRequest, err := http.NewRequest(http.MethodGet, result.Tasks[0].Link, nil)
	if err != nil {
		t.Fatal(err)
	}
	rangeRequest.Header.Set("Range", "bytes=0-0")
	rangeRequest.Header.Set("Accept", "*/*")
	rangeRequest.Header.Set("Accept-Encoding", "identity")
	rangeResponse, err := manager.dropboxClient.Do(rangeRequest)
	if err != nil {
		t.Fatalf("request expanded Dropbox file range: %v", err)
	}
	rangeResponse.Body.Close()
	if rangeResponse.StatusCode != http.StatusPartialContent || rangeResponse.Header.Get("Content-Range") == "" {
		t.Fatalf("expanded Dropbox file does not support resume: status=%d headers=%v", rangeResponse.StatusCode, rangeResponse.Header)
	}
	t.Logf("expanded %d Dropbox files and filtered %d", len(result.Tasks), result.Filtered)
}

func dropboxTestJSON(request *http.Request, body string) *http.Response {
	return dropboxTestResponse(request, http.StatusOK, body, http.Header{"Content-Type": []string{"application/json"}})
}

func dropboxTestResponse(request *http.Request, status int, body string, header http.Header) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    request,
	}
}
