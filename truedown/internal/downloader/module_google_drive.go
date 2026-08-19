package downloader

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var googleDriveIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{10,256}$`)

type googleDriveResolverModule struct {
	version string
	profile googleDriveComponentConfig
}

type googleDriveComponentConfig struct {
	StableDownloadPath string `json:"stableDownloadPath"`
	OpenPath           string `json:"openPath"`
	FolderViewPath     string `json:"folderViewPath"`
	NativeExportPath   string `json:"nativeExportPath"`
	UserAgent          string `json:"userAgent"`
}

var googleDriveBaselineProfile = googleDriveComponentConfig{
	StableDownloadPath: "/uc",
	OpenPath:           "/open",
	FolderViewPath:     "/embeddedfolderview",
	NativeExportPath:   "/{type}/d/{id}/export",
	UserAgent:          googleDriveUserAgent,
}

type googleDriveModuleOptions struct {
	DocumentFormat     string `json:"documentFormat"`
	SpreadsheetFormat  string `json:"spreadsheetFormat"`
	PresentationFormat string `json:"presentationFormat"`
}

type googleDriveReference struct {
	ID         string
	Folder     bool
	NativeType string
}

func newGoogleDriveResolverModule(pkg componentPackage) (resolverModule, error) {
	decoder := json.NewDecoder(bytes.NewReader(pkg.Config))
	decoder.DisallowUnknownFields()
	var profile googleDriveComponentConfig
	if err := decoder.Decode(&profile); err != nil {
		return nil, &ValidationError{Message: fmt.Sprintf("invalid Google Drive component config: %v", err)}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, &ValidationError{Message: "Google Drive component config must contain one JSON object"}
	}
	profile.StableDownloadPath = strings.TrimSpace(profile.StableDownloadPath)
	profile.OpenPath = strings.TrimSpace(profile.OpenPath)
	profile.FolderViewPath = strings.TrimSpace(profile.FolderViewPath)
	profile.NativeExportPath = strings.TrimSpace(profile.NativeExportPath)
	profile.UserAgent = strings.TrimSpace(profile.UserAgent)
	for name, value := range map[string]string{
		"stableDownloadPath": profile.StableDownloadPath,
		"openPath":           profile.OpenPath,
		"folderViewPath":     profile.FolderViewPath,
	} {
		if !validComponentPath(value) {
			return nil, &ValidationError{Message: fmt.Sprintf("Google Drive component %s is invalid", name)}
		}
	}
	if strings.Count(profile.NativeExportPath, "{type}") != 1 ||
		strings.Count(profile.NativeExportPath, "{id}") != 1 ||
		!validComponentPath(strings.ReplaceAll(strings.ReplaceAll(profile.NativeExportPath, "{type}", "document"), "{id}", "file")) {
		return nil, &ValidationError{Message: "Google Drive component nativeExportPath is invalid"}
	}
	if !validComponentHeaderValue(profile.UserAgent, 512) {
		return nil, &ValidationError{Message: "Google Drive component userAgent is invalid"}
	}
	return &googleDriveResolverModule{version: pkg.Version, profile: profile}, nil
}

func (module *googleDriveResolverModule) info() ModuleInfo {
	return ModuleInfo{
		ID: GoogleDriveModuleID, Name: "Google Drive", Version: module.version, BuiltIn: true,
		Description:  "解析公开文件、确认页、Google 文档导出和递归共享目录。",
		Capabilities: []string{"file", "folder", "native-export", "resume"},
	}
}

func (*googleDriveResolverModule) matches(value string) bool {
	_, ok := parseGoogleDriveReference(value)
	return ok
}

func (*googleDriveResolverModule) validateOptions(raw json.RawMessage) error {
	_, err := parseGoogleDriveModuleOptions(raw)
	return err
}

func (module *googleDriveResolverModule) resolve(
	ctx context.Context,
	m *Manager,
	request moduleResolveRequest,
) (ModuleAddResult, bool, error) {
	reference, ok := parseGoogleDriveReference(request.Link)
	if !ok {
		return ModuleAddResult{}, false, nil
	}
	options, err := parseGoogleDriveModuleOptions(request.Options)
	if err != nil {
		return ModuleAddResult{}, true, err
	}
	identity := normalizeRequest(
		request.Link, request.Name, request.Folder, m.defaultDir, request.Headers,
		request.DownloadPage, request.QueueID, request.Opts,
	)
	identity.ModuleID = GoogleDriveModuleID
	if err := validateRequest(identity); err != nil {
		return ModuleAddResult{}, true, err
	}
	if reference.Folder {
		return resolveGoogleDriveFolder(ctx, m, identity, reference, options, module.profile)
	}

	format := googleNativeFormat(reference.NativeType, options)
	stableLink := module.profile.stableLink(reference.ID, reference.NativeType, format)
	probeTask := &Task{Link: stableLink, Headers: identity.Headers, Name: identity.Name}
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	metadata, _, err := resolveGoogleDriveDownloadWithProfile(probeCtx, probeTask, m.googleDriveClient, module.profile)
	if err != nil {
		return ModuleAddResult{}, true, err
	}
	name := identity.Name
	if name == "" {
		name = sanitizeModulePathComponent(metadata.Name)
		if name == "" {
			return ModuleAddResult{}, true, fmt.Errorf("Google Drive did not provide a usable file name")
		}
	}
	task, duplicate, err := m.addTaskWithModule(
		stableLink, name, identity.Folder, identity.Headers, identity.DownloadPage,
		identity.QueueID, identity.Opts, GoogleDriveModuleID,
	)
	if err != nil {
		return ModuleAddResult{}, true, err
	}
	result := ModuleAddResult{ModuleID: GoogleDriveModuleID, Tasks: []*Task{task}}
	if duplicate {
		result.Duplicates = 1
	}
	return result, true, nil
}

func (module *googleDriveResolverModule) prepare(ctx context.Context, m *Manager, task *Task) (modulePreparation, error) {
	resolveCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	metadata, headers, err := resolveGoogleDriveDownloadWithProfile(resolveCtx, task, m.googleDriveClient, module.profile)
	if err != nil {
		return modulePreparation{}, err
	}
	prepared := modulePreparation{Link: metadata.URL, Headers: headers, Metadata: metadata}
	if m.googleDriveProxy != nil {
		proxyRequest, requestErr := http.NewRequest(http.MethodGet, task.Link, nil)
		if requestErr != nil {
			return modulePreparation{}, fmt.Errorf("prepare Google Drive proxy request: %w", requestErr)
		}
		proxyURL, proxyErr := m.googleDriveProxy(proxyRequest)
		if proxyErr != nil {
			return modulePreparation{}, fmt.Errorf("resolve Google Drive proxy: %w", proxyErr)
		}
		if proxyURL != nil {
			prepared.ProxyURL = proxyURL.String()
		}
	}
	return prepared, nil
}

func (*googleDriveResolverModule) supportsPartialResume(link string) bool {
	reference, ok := parseGoogleDriveReference(link)
	return ok && !reference.Folder
}

func parseGoogleDriveModuleOptions(raw json.RawMessage) (googleDriveModuleOptions, error) {
	options := googleDriveModuleOptions{
		DocumentFormat: "docx", SpreadsheetFormat: "xlsx", PresentationFormat: "pptx",
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return options, nil
	}
	if trimmed[0] != '{' {
		return googleDriveModuleOptions{}, &ValidationError{Message: "Google Drive module options must be a JSON object"}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&options); err != nil {
		return googleDriveModuleOptions{}, &ValidationError{Message: fmt.Sprintf("invalid Google Drive module options: %v", err)}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return googleDriveModuleOptions{}, &ValidationError{Message: "Google Drive module options must contain one JSON object"}
	}
	options.DocumentFormat = strings.ToLower(strings.TrimSpace(options.DocumentFormat))
	options.SpreadsheetFormat = strings.ToLower(strings.TrimSpace(options.SpreadsheetFormat))
	options.PresentationFormat = strings.ToLower(strings.TrimSpace(options.PresentationFormat))
	if options.DocumentFormat == "" {
		options.DocumentFormat = "docx"
	}
	if options.SpreadsheetFormat == "" {
		options.SpreadsheetFormat = "xlsx"
	}
	if options.PresentationFormat == "" {
		options.PresentationFormat = "pptx"
	}
	if !oneOf(options.DocumentFormat, "docx", "pdf", "odt", "rtf", "txt", "epub", "html") {
		return googleDriveModuleOptions{}, &ValidationError{Message: "unsupported Google Docs export format"}
	}
	if !oneOf(options.SpreadsheetFormat, "xlsx", "ods", "pdf", "csv", "tsv") {
		return googleDriveModuleOptions{}, &ValidationError{Message: "unsupported Google Sheets export format"}
	}
	if !oneOf(options.PresentationFormat, "pptx", "odp", "pdf", "txt") {
		return googleDriveModuleOptions{}, &ValidationError{Message: "unsupported Google Slides export format"}
	}
	return options, nil
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func parseGoogleDriveReference(value string) (googleDriveReference, bool) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || !isGoogleDrivePageHost(parsed.Hostname()) {
		return googleDriveReference{}, false
	}
	segments := splitURLPath(parsed.Path)
	queryID := strings.TrimSpace(parsed.Query().Get("id"))
	if queryID != "" && googleDriveIDPattern.MatchString(queryID) {
		return googleDriveReference{ID: queryID}, true
	}
	for index := 0; index+1 < len(segments); index++ {
		if segments[index] == "folders" && googleDriveIDPattern.MatchString(segments[index+1]) {
			return googleDriveReference{ID: segments[index+1], Folder: true}, true
		}
	}
	for index := 0; index+1 < len(segments); index++ {
		if segments[index] != "d" || !googleDriveIDPattern.MatchString(segments[index+1]) {
			continue
		}
		nativeType := ""
		for _, segment := range segments[:index] {
			switch segment {
			case "document", "spreadsheets", "presentation":
				nativeType = segment
			}
		}
		return googleDriveReference{ID: segments[index+1], NativeType: nativeType}, true
	}
	return googleDriveReference{}, false
}

func splitURLPath(value string) []string {
	raw := strings.Split(strings.Trim(value, "/"), "/")
	segments := make([]string, 0, len(raw))
	for _, segment := range raw {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	return segments
}

func googleDriveStableLink(id, nativeType, format string) string {
	return googleDriveBaselineProfile.stableLink(id, nativeType, format)
}

func (profile googleDriveComponentConfig) stableLink(id, nativeType, format string) string {
	query := url.Values{"id": []string{id}, "export": []string{"download"}}
	if nativeType != "" {
		query.Set("type", nativeType)
	}
	if format != "" {
		query.Set("format", format)
	}
	return "https://drive.google.com" + profile.StableDownloadPath + "?" + query.Encode()
}

func (profile googleDriveComponentConfig) openLink(id string) string {
	return "https://drive.google.com" + profile.OpenPath + "?id=" + url.QueryEscape(id)
}

func (profile googleDriveComponentConfig) folderViewLink(id string) string {
	return "https://drive.google.com" + profile.FolderViewPath + "?id=" + url.QueryEscape(id)
}

func (profile googleDriveComponentConfig) exportLink(nativeType, id, format string) string {
	path := strings.ReplaceAll(profile.NativeExportPath, "{type}", url.PathEscape(nativeType))
	path = strings.ReplaceAll(path, "{id}", url.PathEscape(id))
	return "https://docs.google.com" + path + "?format=" + url.QueryEscape(format)
}

func googleNativeFormat(nativeType string, options googleDriveModuleOptions) string {
	switch nativeType {
	case "document":
		return options.DocumentFormat
	case "spreadsheets":
		return options.SpreadsheetFormat
	case "presentation":
		return options.PresentationFormat
	default:
		return ""
	}
}

func googleNativeExtension(nativeType string, options googleDriveModuleOptions) string {
	format := googleNativeFormat(nativeType, options)
	if format == "" {
		return ""
	}
	return "." + format
}

func sanitizeModulePathComponent(value string) string {
	return sanitizeDropboxPathComponent(value)
}

func resolveGoogleDriveFolder(
	ctx context.Context,
	m *Manager,
	identity requestIdentity,
	reference googleDriveReference,
	options googleDriveModuleOptions,
	profile googleDriveComponentConfig,
) (ModuleAddResult, bool, error) {
	crawlCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	files, rootName, err := crawlGoogleDriveFolderWithProfile(crawlCtx, m.googleDriveClient, reference.ID, profile)
	if err != nil {
		return ModuleAddResult{}, true, err
	}
	rootName = sanitizeModulePathComponent(rootName)
	if rootName == "" {
		rootName = "Google Drive"
	}
	requests := make([]taskAddRequest, 0, len(files))
	for _, file := range files {
		name := sanitizeModulePathComponent(file.Name)
		if name == "" {
			name = "file"
		}
		extension := googleNativeExtension(file.NativeType, options)
		if extension != "" && !strings.HasSuffix(strings.ToLower(name), strings.ToLower(extension)) {
			name += extension
		}
		targetFolder := filepath.Join(identity.Folder, rootName)
		if len(file.Relative) > 0 {
			targetFolder = filepath.Join(append([]string{targetFolder}, file.Relative...)...)
		}
		requests = append(requests, taskAddRequest{
			Link: profile.stableLink(file.ID, file.NativeType, googleNativeFormat(file.NativeType, options)),
			Name: name, Folder: targetFolder, Headers: identity.Headers,
			DownloadPage: identity.DownloadPage, QueueID: identity.QueueID,
			Opts: identity.Opts, ModuleID: GoogleDriveModuleID,
		})
	}
	added, err := m.addTasksBatch(requests)
	if err != nil {
		return ModuleAddResult{}, true, fmt.Errorf("batch add Google Drive files: %w", err)
	}
	result := ModuleAddResult{
		ModuleID: GoogleDriveModuleID, Tasks: make([]*Task, 0, len(added)), Collection: true,
	}
	for _, item := range added {
		result.Tasks = append(result.Tasks, item.Task)
		if item.Duplicate {
			result.Duplicates++
		}
	}
	return result, true, nil
}
