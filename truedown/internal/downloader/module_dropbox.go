package downloader

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type dropboxResolverModule struct {
	version string
	profile dropboxComponentConfig
}

type dropboxComponentConfig struct {
	FolderEntriesPath string   `json:"folderEntriesPath"`
	CSRFCookieNames   []string `json:"csrfCookieNames"`
	UserAgent         string   `json:"userAgent"`
}

var dropboxBaselineProfile = dropboxComponentConfig{
	FolderEntriesPath: "/list_shared_link_folder_entries",
	CSRFCookieNames:   []string{"__Host-js_csrf", "t"},
	UserAgent:         "Mozilla/5.0",
}

type dropboxModuleOptions struct {
	Mode        string `json:"mode"`
	ApplyFilter bool   `json:"applyFilter"`
}

func newDropboxResolverModule(pkg componentPackage) (resolverModule, error) {
	decoder := json.NewDecoder(bytes.NewReader(pkg.Config))
	decoder.DisallowUnknownFields()
	var profile dropboxComponentConfig
	if err := decoder.Decode(&profile); err != nil {
		return nil, &ValidationError{Message: fmt.Sprintf("invalid Dropbox component config: %v", err)}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, &ValidationError{Message: "Dropbox component config must contain one JSON object"}
	}
	profile.FolderEntriesPath = strings.TrimSpace(profile.FolderEntriesPath)
	profile.UserAgent = strings.TrimSpace(profile.UserAgent)
	if !validComponentPath(profile.FolderEntriesPath) {
		return nil, &ValidationError{Message: "Dropbox component folderEntriesPath is invalid"}
	}
	if !validComponentHeaderValue(profile.UserAgent, 512) {
		return nil, &ValidationError{Message: "Dropbox component userAgent is invalid"}
	}
	if len(profile.CSRFCookieNames) == 0 || len(profile.CSRFCookieNames) > 8 {
		return nil, &ValidationError{Message: "Dropbox component requires 1 to 8 CSRF cookie names"}
	}
	seenCookies := make(map[string]struct{}, len(profile.CSRFCookieNames))
	for index, name := range profile.CSRFCookieNames {
		name = strings.TrimSpace(name)
		if !validComponentCookieName(name) {
			return nil, &ValidationError{Message: "Dropbox component contains an invalid CSRF cookie name"}
		}
		if _, exists := seenCookies[name]; exists {
			return nil, &ValidationError{Message: "Dropbox component contains duplicate CSRF cookie names"}
		}
		seenCookies[name] = struct{}{}
		profile.CSRFCookieNames[index] = name
	}
	return &dropboxResolverModule{version: pkg.Version, profile: profile}, nil
}

func (module *dropboxResolverModule) info() ModuleInfo {
	return ModuleInfo{
		ID: DropboxModuleID, Name: "Dropbox", Version: module.version, BuiltIn: true,
		Description:  "解析公开共享目录并刷新可续传的 Dropbox 下载地址。",
		Capabilities: []string{"file", "folder", "folder-filter", "resume"},
	}
}

func (*dropboxResolverModule) matches(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || !isDropboxHost(parsed.Hostname()) {
		return false
	}
	path := strings.ToLower(parsed.EscapedPath())
	return strings.HasPrefix(path, "/s/") || strings.HasPrefix(path, "/scl/fi/") || strings.HasPrefix(path, "/scl/fo/")
}

func (*dropboxResolverModule) validateOptions(raw json.RawMessage) error {
	_, err := parseDropboxModuleOptions(raw)
	return err
}

func (module *dropboxResolverModule) resolve(
	ctx context.Context,
	m *Manager,
	request moduleResolveRequest,
) (ModuleAddResult, bool, error) {
	options, err := parseDropboxModuleOptions(request.Options)
	if err != nil {
		return ModuleAddResult{}, true, err
	}
	if len(bytes.TrimSpace(request.Options)) == 0 {
		defaults := m.DownloadRules()
		options.Mode = defaults.DropboxMode
		options.ApplyFilter = defaults.Enabled && options.Mode == DropboxModeExpand
	}
	if options.Mode == "expand" {
		expanded, handled, expandErr := m.addDropboxFolderWithProfile(
			ctx, request.Link, request.Folder, request.Headers, request.DownloadPage,
			request.QueueID, request.Opts, options.ApplyFilter, module.profile,
		)
		if expandErr != nil || handled {
			return ModuleAddResult{
				ModuleID: DropboxModuleID, Tasks: expanded.Tasks,
				Duplicates: expanded.Duplicates, Filtered: expanded.Filtered, Collection: true,
			}, handled, expandErr
		}
		return ModuleAddResult{}, true, &ValidationError{Message: "Dropbox expand mode requires a public /scl/fo/ folder link"}
	}
	link, ok := dropboxDirectLink(request.Link)
	if !ok {
		return ModuleAddResult{}, false, nil
	}
	task, duplicate, err := m.addTaskWithModule(
		link, request.Name, request.Folder, request.Headers, request.DownloadPage,
		request.QueueID, request.Opts, DropboxModuleID,
	)
	if err != nil {
		return ModuleAddResult{}, true, err
	}
	result := ModuleAddResult{ModuleID: DropboxModuleID, Tasks: []*Task{task}}
	if duplicate {
		result.Duplicates = 1
	}
	return result, true, nil
}

func (*dropboxResolverModule) prepare(_ context.Context, m *Manager, task *Task) (modulePreparation, error) {
	metadata, err := resolveDropboxDirectURL(task, m.dropboxClient)
	if err != nil {
		return modulePreparation{}, err
	}
	prepared := modulePreparation{
		Link:    task.Link,
		Headers: dropboxContentHeaders(task.Headers),
		Metadata: remoteMetadata{
			URL: metadata.URL, Name: metadata.Name, Digest: metadata.Digest,
			Length: metadata.Length, LengthKnown: metadata.LengthKnown,
		},
	}
	if m.dropboxProxy != nil {
		proxyRequest, requestErr := http.NewRequest(http.MethodGet, task.Link, nil)
		if requestErr != nil {
			return modulePreparation{}, fmt.Errorf("prepare Dropbox proxy request: %w", requestErr)
		}
		proxyURL, proxyErr := m.dropboxProxy(proxyRequest)
		if proxyErr != nil {
			return modulePreparation{}, fmt.Errorf("resolve Dropbox proxy: %w", proxyErr)
		}
		if proxyURL != nil {
			prepared.ProxyURL = proxyURL.String()
		}
	}
	return prepared, nil
}

func (*dropboxResolverModule) supportsPartialResume(link string) bool {
	return isDropboxDirectDownload(link)
}

func parseDropboxModuleOptions(raw json.RawMessage) (dropboxModuleOptions, error) {
	options := dropboxModuleOptions{Mode: "direct"}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return options, nil
	}
	if trimmed[0] != '{' {
		return dropboxModuleOptions{}, &ValidationError{Message: "Dropbox module options must be a JSON object"}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&options); err != nil {
		return dropboxModuleOptions{}, &ValidationError{Message: fmt.Sprintf("invalid Dropbox module options: %v", err)}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return dropboxModuleOptions{}, &ValidationError{Message: "Dropbox module options must contain one JSON object"}
	}
	options.Mode = strings.TrimSpace(options.Mode)
	if options.Mode == "" {
		options.Mode = "direct"
	}
	if options.Mode != "direct" && options.Mode != "expand" {
		return dropboxModuleOptions{}, &ValidationError{Message: "Dropbox mode must be direct or expand"}
	}
	if options.Mode == "direct" && options.ApplyFilter {
		return dropboxModuleOptions{}, &ValidationError{Message: "Dropbox filtering requires expand mode"}
	}
	return options, nil
}

func dropboxDirectLink(value string) (string, bool) {
	if direct, ok := DropboxFolderDownloadLink(value); ok {
		return direct, true
	}
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || !isDropboxHost(parsed.Hostname()) {
		return "", false
	}
	path := strings.ToLower(parsed.EscapedPath())
	if !strings.HasPrefix(path, "/s/") && !strings.HasPrefix(path, "/scl/fi/") {
		return "", false
	}
	query := parsed.Query()
	query.Set("dl", "1")
	parsed.RawQuery = query.Encode()
	return parsed.String(), true
}
