package protocol

import "testing"

func TestApplicationLogDesktopControls(t *testing.T) {
	for _, body := range []string{`{"enabled":true}`, `{"enabled":false}`, `{"clear":true}`} {
		if !AllowedDesktopRequest(DesktopRequest{ID: 1, Method: "POST", Path: "/system/logs", Body: body}) {
			t.Fatalf("rejected application log control %s", body)
		}
	}
	if AllowedDesktopRequest(DesktopRequest{ID: 1, Method: "DELETE", Path: "/system/logs"}) {
		t.Fatal("accepted unsupported application log method")
	}
}

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
