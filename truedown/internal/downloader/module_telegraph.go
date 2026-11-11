package downloader

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strings"
	"time"

	"truedown/internal/netproxy"
)

const TelegraphModuleID = "telegraph"

type telegraphResolver struct{ version string }
type telegraphNode struct {
	Tag      string            `json:"tag"`
	Attrs    map[string]string `json:"attrs"`
	Children []json.RawMessage `json:"children"`
}

func newTelegraphResolver(pkg componentPackage) (resolverModule, error) {
	if string(bytes.TrimSpace(pkg.Config)) != "{}" {
		return nil, &ValidationError{Message: "Telegraph configuration is fixed"}
	}
	return &telegraphResolver{version: pkg.Version}, nil
}
func (r *telegraphResolver) info() ModuleInfo {
	return ModuleInfo{ID: TelegraphModuleID, Name: "Telegraph", Version: r.version, BuiltIn: true, Description: "Extract images and native video/audio from a public Telegraph article. External players remain external links.", Capabilities: []string{"collection", "media", "resume"}}
}
func telegraphURL(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	return u, err == nil && len(raw) <= 8192 && u.Scheme == "https" && u.User == nil && u.Port() == "" && (u.Host == "telegra.ph" || u.Host == "graph.org")
}
func telegraphMediaURL(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	base, _ := url.Parse("https://telegra.ph/")
	u = base.ResolveReference(u)
	_, ok := telegraphURL(u.String())
	if !ok || !strings.HasPrefix(u.Path, "/file/") || path.Clean(u.Path) != u.Path || strings.ContainsAny(u.Path, "\\\x00") || len(u.Path) <= len("/file/") {
		return "", false
	}
	u.Host = "telegra.ph"
	u.Fragment = ""
	return u.String(), true
}
func (*telegraphResolver) matches(raw string) bool {
	u, ok := telegraphURL(raw)
	return ok && len(u.Path) > 1 && u.Path != "/api" && !strings.HasPrefix(u.Path, "/file/") && !strings.Contains(strings.Trim(u.Path, "/"), "/")
}
func (*telegraphResolver) validateOptions(raw json.RawMessage) error {
	if len(bytes.TrimSpace(raw)) != 0 && string(bytes.TrimSpace(raw)) != "{}" {
		return &ValidationError{Message: "unsupported Telegraph options"}
	}
	return nil
}
func (*telegraphResolver) supportsPartialResume(string) bool { return true }

func extractTelegraphMedia(body []byte) (string, []string, error) {
	var response struct {
		OK     bool `json:"ok"`
		Result struct {
			Title   string            `json:"title"`
			Content []json.RawMessage `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return "", nil, fmt.Errorf("invalid Telegraph page response")
	}
	if !response.OK || response.Result.Content == nil {
		return "", nil, fmt.Errorf("Telegraph page is unavailable")
	}
	seen := map[string]bool{}
	var media []string
	nodes := 0
	var walk func([]json.RawMessage, int) error
	walk = func(children []json.RawMessage, depth int) error {
		if depth > 64 {
			return fmt.Errorf("Telegraph content exceeds nesting limit")
		}
		for _, raw := range children {
			nodes++
			if nodes > 20000 {
				return fmt.Errorf("Telegraph content exceeds node limit")
			}
			if len(raw) > 0 && raw[0] == '"' {
				continue
			}
			var node telegraphNode
			if err := json.Unmarshal(raw, &node); err != nil {
				return fmt.Errorf("invalid Telegraph content node")
			}
			switch node.Tag {
			case "img", "video", "audio":
				if link, ok := telegraphMediaURL(node.Attrs["src"]); ok && !seen[link] {
					seen[link] = true
					media = append(media, link)
					if len(media) > 5000 {
						return fmt.Errorf("Telegraph article exceeds media limit")
					}
				}
			}
			if err := walk(node.Children, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(response.Result.Content, 0); err != nil {
		return "", nil, err
	}
	if len(media) == 0 {
		return "", nil, fmt.Errorf("Telegraph article contains no supported native media; external players are not extracted")
	}
	return response.Result.Title, media, nil
}

func (r *telegraphResolver) resolve(ctx context.Context, m *Manager, request moduleResolveRequest) (ModuleAddResult, bool, error) {
	result := ModuleAddResult{ModuleID: TelegraphModuleID, Collection: true}
	if !r.matches(request.Link) {
		return result, false, nil
	}
	if err := r.validateOptions(request.Options); err != nil {
		return result, true, err
	}
	identity := normalizeRequest(request.Link, request.Name, request.Folder, m.defaultDir, nil, "", request.QueueID, request.Opts)
	if err := validateRequest(identity); err != nil {
		return result, true, err
	}
	u, _ := telegraphURL(request.Link)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// Reuse the host proxy transport, with this provider's own redirect policy.
	transport := netproxy.NewTransport(m.proxyForTask(request.Opts))
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || req.URL.Scheme != "https" || req.URL.Host != "api.telegra.ph" || req.URL.User != nil {
			return fmt.Errorf("untrusted Telegraph API redirect")
		}
		return nil
	}}
	apiRequest, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.telegra.ph/getPage/"+url.PathEscape(strings.Trim(u.Path, "/"))+"?return_content=true", nil)
	response, err := client.Do(apiRequest)
	if err != nil {
		return result, true, fmt.Errorf("request Telegraph page: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return result, true, fmt.Errorf("Telegraph returned HTTP %d", response.StatusCode)
	}
	body, err := readLimitedBody(response.Body, 2<<20)
	if err != nil {
		return result, true, err
	}
	title, links, err := extractTelegraphMedia(body)
	if err != nil {
		return result, true, err
	}
	if request.Name != "" {
		title = request.Name
	}
	title = sanitizeModulePathComponent(title)
	if title == "" {
		title = "Telegraph"
	}
	requests := make([]taskAddRequest, 0, len(links))
	for index, link := range links {
		mediaURL, _ := url.Parse(link)
		name := fmt.Sprintf("%04d-%s", index+1, sanitizeModulePathComponent(path.Base(mediaURL.Path)))
		requests = append(requests, taskAddRequest{Link: link, Name: name, Folder: filepath.Join(identity.Folder, title), QueueID: request.QueueID, Opts: identity.Opts, ModuleID: TelegraphModuleID})
	}
	added, err := m.addTasksBatch(requests)
	if err != nil {
		return result, true, err
	}
	for _, item := range added {
		result.Tasks = append(result.Tasks, item.Task)
		if item.Duplicate {
			result.Duplicates++
		}
	}
	return result, true, nil
}
func (*telegraphResolver) prepare(_ context.Context, _ *Manager, task *Task) (modulePreparation, error) {
	link, ok := telegraphMediaURL(task.Link)
	if !ok {
		return modulePreparation{}, fmt.Errorf("invalid Telegraph media source")
	}
	return modulePreparation{Link: link, Headers: map[string]string{}, Metadata: remoteMetadata{NameSource: responseFilenameIdentity}}, nil
}
