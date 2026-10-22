package mediafire

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"truedown/internal/netproxy"
)

const fileKey = "j2tq12gr15jhq2r"
const folderKey = "h2tkt00f7s2sh"

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(r *http.Request, body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}
}
func fixtureClient(t *testing.T, handler func(*http.Request) *http.Response) *Client {
	t.Helper()
	c := NewClient()
	c.http.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.URL.Host != "www.mediafire.com" {
			t.Fatalf("unexpected identity or transport: %s", r.URL.Host)
		}
		return handler(r), nil
	})
	return c
}
func TestSources(t *testing.T) {
	for _, raw := range []string{"https://mediafire.com/?" + fileKey, "https://www.mediafire.com/file/" + fileKey + "/example.txt/file?dkey=x", "https://www.mediafire.com/download/" + fileKey} {
		source, err := ParseSource(raw)
		if err != nil || source.Folder || source.Source != "https://www.mediafire.com/file/"+fileKey {
			t.Fatalf("canonical source: %+v %v", source, err)
		}
	}
	for _, raw := range []string{"http://www.mediafire.com/file/" + fileKey, "https://mediafire.com.evil/file/" + fileKey, "https://user:secret@mediafire.com/file/" + fileKey, "https://mediafire.com:443/file/" + fileKey, "https://mediafire.com/file/../../x", "https://mediafire.com/file/" + fileKey + "#key", "https://mediafire.com/"} {
		if _, err := ParseSource(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
func TestDownloadButtonsAndNoScriptEvaluation(t *testing.T) {
	direct := "https://download123.mediafire.com/a/b/test.txt?x=1&y=2"
	for _, page := range []string{
		`<a class="button" title="a > b" href="` + strings.ReplaceAll(direct, "&", "&amp;") + `" id="downloadButton">`,
		`<A HREF='` + direct + `' aria-label='Download file'>`,
		`<a data-scrambled-url="` + base64.StdEncoding.EncodeToString([]byte(direct)) + `" href="javascript:void(0)" id="downloadButton">`,
	} {
		if actual, err := downloadURL(page); err != nil || actual != direct {
			t.Fatalf("button: %q %v", actual, err)
		}
	}
	for _, page := range []string{
		`<form id="form_captcha">`, `<form id="form_password">`, `<script>location.href='` + direct + `'</script>`,
		`<a id="downloadButton" href="https://download123.mediafire.com.evil/a">`,
		`<a id="downloadButton" href="http://127.0.0.1/a">`,
		`<a id="downloadButton" href="` + direct + `" href="https://example.com/a">`,
	} {
		if _, err := downloadURL(page); err == nil {
			t.Fatalf("accepted unsafe/missing button: %s", page)
		}
	}
}
func TestPrepareRefreshesURLWithoutDownloadingPayload(t *testing.T) {
	pageRequests := 0
	c := fixtureClient(t, func(r *http.Request) *http.Response {
		if r.URL.Path == "/api/1.5/file/get_info.php" {
			if r.URL.Query().Get("quick_key") != fileKey {
				t.Fatal("wrong API identity")
			}
			return response(r, `{"response":{"result":"Success","file_info":{"quickkey":"`+fileKey+`","filename":"test.txt","size":"12","privacy":"public","password_protected":"no","hash":"`+strings.Repeat("a", 64)+`"}}}`)
		}
		pageRequests++
		return response(r, fmt.Sprintf(`<a id="downloadButton" href="https://download123.mediafire.com/session%d/test.txt">`, pageRequests))
	})
	first, err := c.Prepare(context.Background(), "https://mediafire.com/?"+fileKey)
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Prepare(context.Background(), "https://mediafire.com/file/"+fileKey)
	if err != nil || first.URL == second.URL || first.Name != "test.txt" || first.Size != 12 || first.SHA256 != second.SHA256 {
		t.Fatalf("refresh: %+v %+v %v", first, second, err)
	}
}
func TestRedirectPolicyStopsBeforeCDNAndBlocksOtherHosts(t *testing.T) {
	for _, target := range []string{"https://download1.mediafire.com/a", "https://evil.test/a", "http://www.mediafire.com/a", "https://user@mediafire.com/a"} {
		calls := 0
		c := fixtureClient(t, func(r *http.Request) *http.Response {
			calls++
			out := response(r, "")
			out.StatusCode = 302
			out.Header.Set("Location", target)
			return out
		})
		_, direct, err := c.get(context.Background(), "https://www.mediafire.com/file/"+fileKey)
		if calls != 1 || (validCDN(target) && (err != nil || direct != target)) || (!validCDN(target) && err == nil) {
			t.Fatalf("redirect %s: calls=%d direct=%s error=%v", target, calls, direct, err)
		}
	}
}
func TestResponseBoundsAndPrivateFiles(t *testing.T) {
	for _, body := range []string{
		strings.Repeat("x", 2*1024*1024+1),
		`{"response":{"result":"Success","file_info":{"quickkey":"` + fileKey + `","filename":"test.txt","size":"12","password_protected":"yes"}}}`,
		`{"response":{"result":"Success","file_info":{"quickkey":"` + fileKey + `","filename":"../test.txt","size":"12"}}}`,
		`{"response":{"result":"Success","file_info":{"quickkey":"another12345","filename":"test.txt","size":"12"}}}`,
		`{"response":{"result":"Error","message":"private"}}`,
	} {
		c := fixtureClient(t, func(r *http.Request) *http.Response { return response(r, body) })
		if _, err := c.Prepare(context.Background(), "https://mediafire.com/file/"+fileKey); err == nil {
			t.Fatal("invalid/private file accepted")
		}
	}
}
func folderFixture(t *testing.T, corrupt string) (*Client, *[]string) {
	calls := []string{}
	c := fixtureClient(t, func(r *http.Request) *http.Response {
		q := r.URL.Query()
		key, kind, chunk := q.Get("folder_key"), q.Get("content_type"), q.Get("chunk")
		if r.URL.Path == "/api/1.5/folder/get_info.php" {
			return response(r, `{"response":{"result":"Success","folder_info":{"folderkey":"`+folderKey+`","name":"Root"}}}`)
		}
		calls = append(calls, key+":"+kind+":"+chunk)
		content := `"more_chunks":"no","files":[],"folders":[]`
		if key == folderKey && kind == "files" {
			name, id, more := "a.txt", "aaaaaaaaaaaaaaa", "yes"
			if chunk == "2" {
				name, id, more = "b.txt", "bbbbbbbbbbbbbbb", "no"
			}
			if corrupt == "duplicate" {
				id = "aaaaaaaaaaaaaaa"
			}
			if corrupt == "collision" {
				name = "a.txt"
			}
			if corrupt == "path" {
				name = "../escape.txt"
			}
			if corrupt == "cursor" {
				more = ""
			}
			content = fmt.Sprintf(`"more_chunks":%q,"files":[{"quickkey":%q,"filename":%q,"size":"1"}]`, more, id, name)
		} else if key == folderKey && kind == "folders" {
			child := "ccccccccccccc"
			if corrupt == "cycle" {
				child = folderKey
			}
			content = `"more_chunks":"no","folders":[{"folderkey":"` + child + `","name":"Sub"}]`
		} else if kind == "files" {
			content = `"more_chunks":"no","files":[{"quickkey":"ddddddddddddddd","filename":"child.bin","size":"2"}]`
		}
		return response(r, `{"response":{"result":"Success","folder_content":{`+content+`}}}`)
	})
	return c, &calls
}
func TestFolderPaginationAndHierarchy(t *testing.T) {
	c, calls := folderFixture(t, "")
	listed, err := c.List(context.Background(), "https://mediafire.com/folder/"+folderKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Entries) != 4 || len(*calls) != 5 || (*calls)[1] != folderKey+":files:2" || strings.Join(listed.Entries[3].Path, "/") != "Sub/child.bin" {
		t.Fatalf("folder: %+v calls=%v", listed, *calls)
	}
	for _, kind := range []string{"duplicate", "collision", "cycle", "path", "cursor"} {
		c, _ := folderFixture(t, kind)
		if _, err := c.List(context.Background(), "https://mediafire.com/folder/"+folderKey); err == nil {
			t.Fatalf("accepted malformed folder: %s", kind)
		}
	}
}
func TestPublicMetadataSmoke(t *testing.T) {
	file, folder := os.Getenv("TRUEDOWN_TEST_MEDIAFIRE_FILE"), os.Getenv("TRUEDOWN_TEST_MEDIAFIRE_FOLDER")
	if file == "" && folder == "" {
		t.Skip("opt-in public metadata smoke; never downloads payloads")
	}
	c := NewClient()
	probe, _ := http.NewRequest(http.MethodGet, "https://www.mediafire.com/", nil)
	proxy, err := netproxy.System(probe)
	if err != nil {
		t.Fatal(err)
	}
	if proxy != nil {
		if err := c.SetProxy(proxy.String()); err != nil {
			t.Fatal(err)
		}
	}

	if file != "" {
		prepared, err := c.Prepare(context.Background(), file)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("file metadata: %s, %d bytes, SHA256 available=%t", prepared.Name, prepared.Size, prepared.SHA256 != "")
	}
	if folder != "" {
		listed, err := c.List(context.Background(), folder)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("folder metadata: %s, %d entries", listed.Name, len(listed.Entries))
	}
}
