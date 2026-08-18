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

const googleDriveModuleVersion = "1.0.0"

var googleDriveIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{10,256}$`)

type googleDriveResolverModule struct{}

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

func (*googleDriveResolverModule) info() ModuleInfo {
	return ModuleInfo{
		ID: GoogleDriveModuleID, Name: "Google Drive", Version: googleDriveModuleVersion, BuiltIn: true,
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

func (*googleDriveResolverModule) resolve(
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
		return resolveGoogleDriveFolder(ctx, m, identity, reference, options)
	}

	format := googleNativeFormat(reference.NativeType, options)
	stableLink := googleDriveStableLink(reference.ID, reference.NativeType, format)
	probeTask := &Task{Link: stableLink, Headers: identity.Headers, Name: identity.Name}
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	metadata, _, err := resolveGoogleDriveDownload(probeCtx, probeTask, m.googleDriveClient)
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

func (*googleDriveResolverModule) prepare(ctx context.Context, m *Manager, task *Task) (modulePreparation, error) {
	resolveCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	metadata, headers, err := resolveGoogleDriveDownload(resolveCtx, task, m.googleDriveClient)
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
	query := url.Values{"id": []string{id}, "export": []string{"download"}}
	if nativeType != "" {
		query.Set("type", nativeType)
	}
	if format != "" {
		query.Set("format", format)
	}
	return "https://drive.google.com/uc?" + query.Encode()
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
) (ModuleAddResult, bool, error) {
	crawlCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	files, rootName, err := crawlGoogleDriveFolder(crawlCtx, m.googleDriveClient, reference.ID)
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
			Link: googleDriveStableLink(file.ID, file.NativeType, googleNativeFormat(file.NativeType, options)),
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
