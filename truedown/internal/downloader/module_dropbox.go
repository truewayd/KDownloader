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

type dropboxResolverModule struct{}

type dropboxModuleOptions struct {
	Mode        string `json:"mode"`
	ApplyFilter bool   `json:"applyFilter"`
}

func (*dropboxResolverModule) info() ModuleInfo {
	return ModuleInfo{
		ID: DropboxModuleID, Name: "Dropbox", Version: "1.0.0", BuiltIn: true,
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

func (*dropboxResolverModule) resolve(
	ctx context.Context,
	m *Manager,
	request moduleResolveRequest,
) (ModuleAddResult, bool, error) {
	options, err := parseDropboxModuleOptions(request.Options)
	if err != nil {
		return ModuleAddResult{}, true, err
	}
	if options.Mode == "expand" {
		expanded, handled, expandErr := m.AddDropboxFolder(
			ctx, request.Link, request.Folder, request.Headers, request.DownloadPage,
			request.QueueID, request.Opts, options.ApplyFilter,
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
