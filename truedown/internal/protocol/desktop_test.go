package protocol

import "testing"

func TestDesktopRequestHeadersAndControlCharacters(t *testing.T) {
	for _, path := range []string{"/tasks?search=\x00", "/tasks?search=\x7f", "/tasks?search=\n"} {
		if AllowedDesktopRequest(DesktopRequest{ID: 1, Method: "GET", Path: path}) {
			t.Fatalf("accepted control character in path %q", path)
		}
	}
	request := DesktopRequest{ID: 1, Method: "GET", Path: "/tasks?search=%E4%B8%AD%E6%96%87"}
	if !AllowedDesktopRequest(request) {
		t.Fatal("rejected a valid encoded query")
	}
	request.Headers = map[string]string{"Content-Type": "application/json", "content-type": "text/plain"}
	if AllowedDesktopRequest(request) {
		t.Fatal("accepted ambiguous duplicate headers")
	}
	request.Headers = map[string]string{"Content-Type": "application/json", "If-None-Match": "etag"}
	if !AllowedDesktopRequest(request) {
		t.Fatal("rejected supported distinct headers")
	}
}
