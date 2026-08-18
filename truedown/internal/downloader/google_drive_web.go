package downloader

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const (
	googleDriveHTMLLimit       = 2 * 1024 * 1024
	googleDriveFolderHTMLLimit = 16 * 1024 * 1024
	googleDriveMaxFiles        = 5000
	googleDriveMaxDirectories  = 1000
	googleDriveMaxDepth        = 64
	googleDriveFolderWorkers   = 4
	googleDriveUserAgent       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

var (
	googleHTMLTitlePattern          = regexp.MustCompile(`(?is)<title\b[^>]*>(.*?)</title>`)
	googleHTMLAnchorPattern         = regexp.MustCompile(`(?is)<a\b([^>]*)>(.*?)</a>`)
	googleHTMLFormPattern           = regexp.MustCompile(`(?is)<form\b([^>]*)>(.*?)</form>`)
	googleHTMLInputPattern          = regexp.MustCompile(`(?is)<input\b([^>]*)>`)
	googleHTMLAttributePattern      = regexp.MustCompile(`(?is)([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	googleHTMLTagPattern            = regexp.MustCompile(`(?is)<[^>]+>`)
	googleDriveLegacyConfirmPattern = regexp.MustCompile(`(?is)href=["'](/uc\?export=download[^"']+)["']`)
	googleDriveJSONURLPattern       = regexp.MustCompile(`(?is)"downloadUrl"\s*:\s*("(?:\\.|[^"\\])*")`)
	googleDriveErrorPattern         = regexp.MustCompile(`(?is)<p\b[^>]*class=["'][^"']*uc-error-subcaption[^"']*["'][^>]*>(.*?)</p>`)
)

type googleDriveFolderFile struct {
	ID         string
	Name       string
	NativeType string
	Relative   []string
}

type googleDriveFolderEntry struct {
	Reference googleDriveReference
	Name      string
}

type googleDriveFolderWork struct {
	ID       string
	Relative []string
	Depth    int
}

type googleDriveFolderFetch struct {
	Name    string
	Entries []googleDriveFolderEntry
	Err     error
}

func isGoogleDrivePageHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "drive.google.com" || host == "docs.google.com"
}

func isGoogleDriveDownloadHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return isGoogleDrivePageHost(host) || host == "drive.usercontent.google.com" ||
		host == "googleusercontent.com" || strings.HasSuffix(host, ".googleusercontent.com")
}

func newGoogleDriveHTTPClient(proxy func(*http.Request) (*url.URL, error)) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = proxy
	transport.DisableCompression = true
	return &http.Client{Transport: transport, CheckRedirect: googleDriveRedirectPolicy}
}

func googleDriveRedirectPolicy(request *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return fmt.Errorf("too many Google Drive redirects")
	}
	if request.URL.Scheme != "https" || request.URL.User != nil || !isGoogleDriveDownloadHost(request.URL.Hostname()) {
		return fmt.Errorf("Google Drive redirected to an untrusted host")
	}
	if !isGoogleDrivePageHost(request.URL.Hostname()) {
		for _, name := range []string{"Authorization", "Cookie", "Origin", "Proxy-Authorization"} {
			request.Header.Del(name)
		}
	}
	return nil
}

func newGoogleDriveSessionClient(base *http.Client) *http.Client {
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, CheckRedirect: googleDriveRedirectPolicy}
	if base != nil {
		client.Transport = base.Transport
		client.Timeout = base.Timeout
	}
	return client
}

// resolveGoogleDriveDownload follows the same public-link flow used by gdown:
// normalize to /uc, switch Google-native files to export endpoints, then parse
// the large-file confirmation form. The implementation is original Go code;
// protocol behavior was studied from wkentaro/gdown (MIT), main@7132dabe.
func resolveGoogleDriveDownload(ctx context.Context, task *Task, base *http.Client) (remoteMetadata, map[string]string, error) {
	if task == nil {
		return remoteMetadata{}, nil, fmt.Errorf("Google Drive task is missing")
	}
	reference, ok := parseGoogleDriveReference(task.Link)
	if !ok || reference.Folder {
		return remoteMetadata{}, nil, fmt.Errorf("task does not contain a supported Google Drive file link")
	}
	if base == nil {
		return remoteMetadata{}, nil, fmt.Errorf("Google Drive resolver is unavailable")
	}
	client := newGoogleDriveSessionClient(base)
	seedGoogleDriveCookies(client.Jar, task.Headers)
	format := strings.ToLower(strings.TrimSpace(mustParseURLQuery(task.Link).Get("format")))
	nativeType := strings.ToLower(strings.TrimSpace(mustParseURLQuery(task.Link).Get("type")))
	current := googleDriveStableLink(reference.ID, nativeType, format)
	seen := make(map[string]struct{})
	usedOpenFallback := false
	for attempt := 0; attempt < 10; attempt++ {
		if _, exists := seen[current]; exists {
			return remoteMetadata{}, nil, fmt.Errorf("Google Drive resolver entered a redirect loop")
		}
		seen[current] = struct{}{}
		response, err := requestGoogleDrivePage(ctx, client, current, task.Headers)
		if err != nil {
			return remoteMetadata{}, nil, fmt.Errorf("request Google Drive file: %w", err)
		}
		resolvedURL := current
		if response.Request != nil && response.Request.URL != nil {
			resolvedURL = response.Request.URL.String()
		}
		if response.StatusCode == http.StatusInternalServerError && !usedOpenFallback {
			response.Body.Close()
			usedOpenFallback = true
			current = "https://drive.google.com/open?id=" + url.QueryEscape(reference.ID)
			continue
		}
		if name := contentDispositionName(response.Header.Get("Content-Disposition")); name != "" && response.StatusCode >= 200 && response.StatusCode < 300 {
			if nativeType != "" && format != "" && !strings.Contains(strings.ToLower(mustParseURLPath(resolvedURL)), "/export") &&
				!strings.EqualFold(filepath.Ext(name), "."+format) {
				response.Body.Close()
				current = googleDriveExportURL(nativeType, reference.ID, format)
				continue
			}
			metadata := remoteMetadata{URL: resolvedURL, Name: sanitizeModulePathComponent(name)}
			metadata.Length, metadata.LengthKnown = responseTotalLength(response, responseRequestMethod(response))
			metadata.Digest = strings.TrimSpace(response.Header.Get("X-Goog-Hash"))
			headers := googleDriveDownloadHeaders(task.Headers, client.Jar, responseRequestURL(response))
			response.Body.Close()
			return metadata, headers, nil
		}
		contentType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			response.Body.Close()
			return remoteMetadata{}, nil, fmt.Errorf("Google Drive returned HTTP %d", response.StatusCode)
		}
		if !strings.EqualFold(contentType, "text/html") {
			response.Body.Close()
			return remoteMetadata{}, nil, fmt.Errorf("Google Drive response did not identify a downloadable file")
		}
		body, readErr := readLimitedBody(response.Body, googleDriveHTMLLimit)
		response.Body.Close()
		if readErr != nil {
			return remoteMetadata{}, nil, fmt.Errorf("read Google Drive confirmation page: %w", readErr)
		}
		resolvedNativeType := googleNativeTypeFromURL(resolvedURL)
		if resolvedNativeType == "" {
			resolvedNativeType = nativeType
		}
		if resolvedNativeType != "" && !strings.Contains(strings.ToLower(mustParseURLPath(resolvedURL)), "/export") {
			current = googleDriveExportURL(resolvedNativeType, reference.ID, format)
			continue
		}
		next, confirmErr := googleDriveConfirmationURL(string(body), resolvedURL)
		if confirmErr != nil {
			return remoteMetadata{}, nil, confirmErr
		}
		current = next
	}
	return remoteMetadata{}, nil, fmt.Errorf("Google Drive confirmation flow exceeded its redirect limit")
}

func requestGoogleDrivePage(ctx context.Context, client *http.Client, value string, headers map[string]string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, value, nil)
	if err != nil {
		return nil, err
	}
	for name, headerValue := range headers {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "host", "content-length", "accept-encoding", "cookie", "proxy-authorization":
			continue
		}
		request.Header.Set(name, headerValue)
	}
	if request.Header.Get("User-Agent") == "" {
		request.Header.Set("User-Agent", googleDriveUserAgent)
	}
	request.Header.Set("Accept-Encoding", "identity")
	return client.Do(request)
}

func seedGoogleDriveCookies(jar http.CookieJar, headers map[string]string) {
	if jar == nil {
		return
	}
	raw := ""
	for name, value := range headers {
		if strings.EqualFold(strings.TrimSpace(name), "Cookie") {
			raw = value
			break
		}
	}
	if raw == "" {
		return
	}
	dummy := &http.Request{Header: http.Header{"Cookie": []string{raw}}}
	cookies := dummy.Cookies()
	for _, value := range []string{"https://drive.google.com/", "https://docs.google.com/"} {
		parsed, _ := url.Parse(value)
		jar.SetCookies(parsed, cookies)
	}
}

func googleDriveDownloadHeaders(input map[string]string, jar http.CookieJar, target *url.URL) map[string]string {
	headers := make(map[string]string, len(input)+2)
	for name, value := range input {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "authorization", "cookie", "host", "origin", "proxy-authorization", "content-length", "accept-encoding":
			continue
		}
		headers[name] = value
	}
	if !hasCaseInsensitiveHeader(headers, "User-Agent") {
		headers["User-Agent"] = googleDriveUserAgent
	}
	if jar != nil && target != nil {
		parts := make([]string, 0)
		for _, cookie := range jar.Cookies(target) {
			parts = append(parts, cookie.Name+"="+cookie.Value)
		}
		if len(parts) > 0 {
			headers["Cookie"] = strings.Join(parts, "; ")
		}
	}
	return headers
}

func hasCaseInsensitiveHeader(headers map[string]string, target string) bool {
	for name := range headers {
		if strings.EqualFold(name, target) {
			return true
		}
	}
	return false
}

func googleDriveConfirmationURL(contents, pageURL string) (string, error) {
	if match := googleDriveLegacyConfirmPattern.FindStringSubmatch(contents); len(match) == 2 {
		return resolveGoogleDriveCandidate("https://docs.google.com"+html.UnescapeString(match[1]), pageURL)
	}
	for _, match := range googleHTMLFormPattern.FindAllStringSubmatch(contents, -1) {
		attributes := parseHTMLAttributes(match[1])
		if attributes["id"] != "download-form" || attributes["action"] == "" {
			continue
		}
		action, err := url.Parse(html.UnescapeString(attributes["action"]))
		if err != nil {
			return "", fmt.Errorf("Google Drive returned an invalid confirmation form")
		}
		base, _ := url.Parse(pageURL)
		action = base.ResolveReference(action)
		query := action.Query()
		for _, input := range googleHTMLInputPattern.FindAllStringSubmatch(match[2], -1) {
			inputAttributes := parseHTMLAttributes(input[1])
			if name := inputAttributes["name"]; name != "" {
				query.Set(name, inputAttributes["value"])
			}
		}
		action.RawQuery = query.Encode()
		return resolveGoogleDriveCandidate(action.String(), pageURL)
	}
	if match := googleDriveJSONURLPattern.FindStringSubmatch(contents); len(match) == 2 {
		var candidate string
		if err := json.Unmarshal([]byte(match[1]), &candidate); err == nil {
			return resolveGoogleDriveCandidate(candidate, pageURL)
		}
	}
	if match := googleDriveErrorPattern.FindStringSubmatch(contents); len(match) == 2 {
		message := strings.TrimSpace(stripHTMLText(match[1]))
		if message != "" {
			return "", fmt.Errorf("Google Drive refused the public download: %s", message)
		}
	}
	return "", fmt.Errorf("cannot retrieve the public Google Drive download; check link sharing permissions or access limits")
}

func resolveGoogleDriveCandidate(candidate, pageURL string) (string, error) {
	parsed, err := url.Parse(html.UnescapeString(strings.TrimSpace(candidate)))
	if err != nil {
		return "", fmt.Errorf("Google Drive returned an invalid confirmation URL")
	}
	if !parsed.IsAbs() {
		base, _ := url.Parse(pageURL)
		parsed = base.ResolveReference(parsed)
	}
	if parsed.Scheme != "https" || parsed.User != nil || !isGoogleDriveDownloadHost(parsed.Hostname()) {
		return "", fmt.Errorf("Google Drive confirmation URL used an untrusted host")
	}
	return parsed.String(), nil
}

func parseHTMLAttributes(value string) map[string]string {
	attributes := make(map[string]string)
	for _, match := range googleHTMLAttributePattern.FindAllStringSubmatch(value, -1) {
		attributeValue := match[2]
		if attributeValue == "" {
			attributeValue = match[3]
		}
		if attributeValue == "" {
			attributeValue = match[4]
		}
		attributes[strings.ToLower(match[1])] = html.UnescapeString(attributeValue)
	}
	return attributes
}

func googleNativeTypeFromURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || !isGoogleDriveDownloadHost(parsed.Hostname()) {
		return ""
	}
	segments := splitURLPath(parsed.Path)
	for _, segment := range segments {
		switch segment {
		case "document", "spreadsheets", "presentation":
			return segment
		}
	}
	return ""
}

func googleDriveExportURL(nativeType, id, format string) string {
	if format == "" {
		switch nativeType {
		case "document":
			format = "docx"
		case "spreadsheets":
			format = "xlsx"
		case "presentation":
			format = "pptx"
		}
	}
	return fmt.Sprintf("https://docs.google.com/%s/d/%s/export?format=%s", nativeType, url.PathEscape(id), url.QueryEscape(format))
}

func mustParseURLQuery(value string) url.Values {
	parsed, err := url.Parse(value)
	if err != nil {
		return url.Values{}
	}
	return parsed.Query()
}

func mustParseURLPath(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	return parsed.Path
}

func readLimitedBody(body io.Reader, limit int64) ([]byte, error) {
	limited := io.LimitReader(body, limit+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return data, nil
}

func crawlGoogleDriveFolder(ctx context.Context, client *http.Client, rootID string) ([]googleDriveFolderFile, string, error) {
	if client == nil {
		return nil, "", fmt.Errorf("Google Drive resolver is unavailable")
	}
	pending := []googleDriveFolderWork{{ID: rootID}}
	seenFolders := map[string]struct{}{rootID: {}}
	seenFiles := make(map[string]struct{})
	files := make([]googleDriveFolderFile, 0)
	rootName := ""
	for len(pending) > 0 {
		batchSize := min(len(pending), googleDriveFolderWorkers)
		batch := append([]googleDriveFolderWork(nil), pending[:batchSize]...)
		pending = pending[batchSize:]
		results := make([]googleDriveFolderFetch, len(batch))
		var workers sync.WaitGroup
		for index, work := range batch {
			workers.Add(1)
			go func(index int, work googleDriveFolderWork) {
				defer workers.Done()
				name, entries, err := fetchGoogleDriveFolder(ctx, client, work.ID)
				results[index] = googleDriveFolderFetch{Name: name, Entries: entries, Err: err}
			}(index, work)
		}
		workers.Wait()
		for index, result := range results {
			work := batch[index]
			if result.Err != nil {
				return nil, "", result.Err
			}
			if work.Depth == 0 {
				rootName = result.Name
			}
			for _, entry := range result.Entries {
				name := sanitizeModulePathComponent(entry.Name)
				if name == "" {
					name = "item"
				}
				if entry.Reference.Folder {
					if _, exists := seenFolders[entry.Reference.ID]; exists {
						continue
					}
					if work.Depth+1 > googleDriveMaxDepth {
						return nil, "", fmt.Errorf("Google Drive folder exceeds maximum depth %d", googleDriveMaxDepth)
					}
					if len(seenFolders) >= googleDriveMaxDirectories {
						return nil, "", fmt.Errorf("Google Drive folder exceeds %d directories", googleDriveMaxDirectories)
					}
					seenFolders[entry.Reference.ID] = struct{}{}
					pending = append(pending, googleDriveFolderWork{
						ID: entry.Reference.ID, Relative: appendGoogleDriveRelative(work.Relative, name), Depth: work.Depth + 1,
					})
					continue
				}
				if _, exists := seenFiles[entry.Reference.ID]; exists {
					continue
				}
				if len(files) >= googleDriveMaxFiles {
					return nil, "", fmt.Errorf("Google Drive folder exceeds %d files", googleDriveMaxFiles)
				}
				seenFiles[entry.Reference.ID] = struct{}{}
				files = append(files, googleDriveFolderFile{
					ID: entry.Reference.ID, Name: name, NativeType: entry.Reference.NativeType,
					Relative: append([]string(nil), work.Relative...),
				})
			}
		}
	}
	return files, rootName, nil
}

func fetchGoogleDriveFolder(ctx context.Context, client *http.Client, id string) (string, []googleDriveFolderEntry, error) {
	endpoint := "https://drive.google.com/embeddedfolderview?id=" + url.QueryEscape(id)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", nil, err
	}
	request.Header.Set("User-Agent", googleDriveUserAgent)
	request.Header.Set("Accept-Encoding", "identity")
	response, err := client.Do(request)
	if err != nil {
		return "", nil, fmt.Errorf("retrieve Google Drive folder %s: %w", id, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("Google Drive folder %s returned HTTP %d; check public sharing or access limits", id, response.StatusCode)
	}
	body, err := readLimitedBody(response.Body, googleDriveFolderHTMLLimit)
	if err != nil {
		return "", nil, fmt.Errorf("read Google Drive folder %s: %w", id, err)
	}
	titleMatch := googleHTMLTitlePattern.FindStringSubmatch(string(body))
	if len(titleMatch) != 2 {
		return "", nil, fmt.Errorf("Google Drive folder %s page structure has changed", id)
	}
	name := strings.TrimSpace(stripHTMLText(titleMatch[1]))
	if name == "" {
		return "", nil, fmt.Errorf("Google Drive folder %s has no public name", id)
	}
	entries := make([]googleDriveFolderEntry, 0)
	seen := make(map[string]struct{})
	for _, match := range googleHTMLAnchorPattern.FindAllStringSubmatch(string(body), -1) {
		attributes := parseHTMLAttributes(match[1])
		href := strings.TrimSpace(attributes["href"])
		if href == "" {
			continue
		}
		parsedHref, parseErr := url.Parse(href)
		if parseErr != nil {
			continue
		}
		if !parsedHref.IsAbs() {
			base, _ := url.Parse(endpoint)
			parsedHref = base.ResolveReference(parsedHref)
		}
		reference, ok := parseGoogleDriveReference(parsedHref.String())
		if !ok {
			continue
		}
		key := strconv.FormatBool(reference.Folder) + ":" + reference.ID
		if _, exists := seen[key]; exists {
			continue
		}
		entryName := strings.TrimSpace(stripHTMLText(match[2]))
		if entryName == "" {
			continue
		}
		seen[key] = struct{}{}
		entries = append(entries, googleDriveFolderEntry{Reference: reference, Name: entryName})
	}
	return name, entries, nil
}

func stripHTMLText(value string) string {
	plain := html.UnescapeString(googleHTMLTagPattern.ReplaceAllString(value, " "))
	return strings.Join(strings.Fields(plain), " ")
}

func appendGoogleDriveRelative(parent []string, value string) []string {
	component := sanitizeModulePathComponent(value)
	if component == "" {
		return append([]string(nil), parent...)
	}
	result := make([]string, 0, len(parent)+1)
	result = append(result, parent...)
	return append(result, component)
}

func responseRequestURL(response *http.Response) *url.URL {
	if response != nil && response.Request != nil {
		return response.Request.URL
	}
	return nil
}

func responseRequestMethod(response *http.Response) string {
	if response != nil && response.Request != nil && response.Request.Method != "" {
		return response.Request.Method
	}
	return http.MethodGet
}
