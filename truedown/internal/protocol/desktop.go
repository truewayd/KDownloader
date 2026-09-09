package protocol

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"strings"
)

//go:embed routes.json
var routesJSON []byte
var desktopRoutes = func() map[string][]string {
	var routes map[string][]string
	if err := json.Unmarshal(routesJSON, &routes); err != nil {
		panic(err)
	}
	return routes
}()

const MaxDesktopRequest = 8 * 1024 * 1024
const MaxDesktopResponse = 8 * 1024 * 1024

type DesktopRequest struct {
	ID      uint64            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Body    string            `json:"body,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}
type DesktopResponse struct {
	ID              uint64            `json:"id,omitempty"`
	Event           string            `json:"event,omitempty"`
	ProtocolVersion int               `json:"protocolVersion,omitempty"`
	Owned           bool              `json:"owned"`
	Status          int               `json:"status,omitempty"`
	Body            string            `json:"body,omitempty"`
	Headers         map[string]string `json:"headers,omitempty"`
	Error           string            `json:"error,omitempty"`
}

func AllowedDesktopRequest(request DesktopRequest) bool {
	u, err := url.ParseRequestURI(request.Path)
	if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || u.Path != u.EscapedPath() || len(request.Path) > 8192 || request.ID == 0 {
		return false
	}
	allowed := false
	for _, method := range desktopRoutes[u.Path] {
		if method == request.Method {
			allowed = true
			break
		}
	}
	if !allowed || len(request.Body) > 6*1024*1024 || len(request.Headers) > 2 {
		return false
	}
	names := make(map[string]bool, len(request.Headers))
	for key, value := range request.Headers {
		key = strings.ToLower(key)
		if (key != "if-none-match" && key != "content-type") || names[key] || len(value) > 1024 || strings.ContainsAny(value, "\r\n\x00") {
			return false
		}
		names[key] = true
	}
	return true
}
