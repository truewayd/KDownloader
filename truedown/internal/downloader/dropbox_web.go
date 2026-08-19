package downloader

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	dropboxFolderEntriesEndpoint = "https://www.dropbox.com/list_shared_link_folder_entries"
	dropboxFolderResponseLimit   = 16 * 1024 * 1024
	dropboxFolderMaxFiles        = 5000
	dropboxFolderMaxDirectories  = 1000
	dropboxFolderMaxEntries      = dropboxFolderMaxFiles + dropboxFolderMaxDirectories
	dropboxFolderMaxPages        = 2000
	dropboxFolderMaxDepth        = 64
	dropboxFolderWorkers         = 4
)

type DropboxExpansionResult struct {
	Tasks      []*Task
	Duplicates int
	Filtered   int
}

type dropboxWebShare struct {
	LinkKey    string
	SecureHash string
	SubPath    string
	RLKey      string
	PageURL    string
}

type dropboxWebEntry struct {
	Filename string `json:"filename"`
	Href     string `json:"href"`
	IsDir    bool   `json:"is_dir"`
	Bytes    int64  `json:"bytes"`
}

type dropboxFolderPage struct {
	Entries            []dropboxWebEntry `json:"entries"`
	Folder             *dropboxWebEntry  `json:"folder"`
	HasMoreEntries     bool              `json:"has_more_entries"`
	NextRequestVoucher string            `json:"next_request_voucher"`
}

type dropboxFolderWork struct {
	Share    dropboxWebShare
	Relative []string
}

type dropboxFileWork struct {
	Name     string
	Link     string
	Relative []string
}

// AddDropboxFolder expands a public /scl/fo/ link with Dropbox's web endpoint.
// It returns handled=false when the URL is not a folder (including an
// individual file viewed through /scl/fo/) so the caller can add it normally.
func (m *Manager) AddDropboxFolder(
	ctx context.Context,
	link, folder string,
	headers map[string]string,
	downloadPage string,
	queueID int,
	opts Aria2Opts,
	applyFilter bool,
) (DropboxExpansionResult, bool, error) {
	return m.addDropboxFolderWithProfile(
		ctx, link, folder, headers, downloadPage, queueID, opts, applyFilter, dropboxBaselineProfile,
	)
}

func (m *Manager) addDropboxFolderWithProfile(
	ctx context.Context,
	link, folder string,
	headers map[string]string,
	downloadPage string,
	queueID int,
	opts Aria2Opts,
	applyFilter bool,
	profile dropboxComponentConfig,
) (DropboxExpansionResult, bool, error) {
	share, ok := parseDropboxWebShare(link)
	if !ok {
		return DropboxExpansionResult{}, false, nil
	}
	identity := normalizeRequest(link, "", folder, m.defaultDir, headers, downloadPage, queueID, opts)
	if err := validateRequest(identity); err != nil {
		return DropboxExpansionResult{}, true, err
	}
	excluded, err := normalizeDropboxExcludedExtensions(m.DownloadRules(), applyFilter)
	if err != nil {
		return DropboxExpansionResult{}, true, err
	}
	if m.dropboxClient == nil {
		return DropboxExpansionResult{}, true, fmt.Errorf("Dropbox web client is unavailable")
	}
	webClient := newDropboxWebSessionClient(m.dropboxClient)

	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	csrf, err := primeDropboxWebSession(ctx, webClient, share.PageURL, profile)
	if err != nil {
		return DropboxExpansionResult{}, true, fmt.Errorf("open Dropbox shared folder: %w", err)
	}

	files, rootName, handled, filtered, err := crawlDropboxFolder(ctx, webClient, csrf, share, excluded, profile)
	if err != nil || !handled {
		return DropboxExpansionResult{Filtered: filtered}, handled, err
	}

	baseFolder := identity.Folder
	rootName = sanitizeDropboxPathComponent(rootName)
	if rootName == "" {
		rootName = "Dropbox"
	}

	requests := make([]taskAddRequest, 0, len(files))
	for _, file := range files {
		targetFolder := filepath.Join(baseFolder, rootName)
		if len(file.Relative) > 0 {
			targetFolder = filepath.Join(append([]string{targetFolder}, file.Relative...)...)
		}
		fileName := sanitizeDropboxPathComponent(file.Name)
		if fileName == "" {
			fileName = "file"
		}
		requests = append(requests, taskAddRequest{
			Link: file.Link, Name: fileName, Folder: targetFolder,
			Headers: identity.Headers, DownloadPage: identity.DownloadPage,
			QueueID: identity.QueueID, Opts: identity.Opts, ModuleID: DropboxModuleID,
		})
	}
	added, err := m.addTasksBatch(requests)
	if err != nil {
		return DropboxExpansionResult{Filtered: filtered}, true, fmt.Errorf("batch add Dropbox files: %w", err)
	}
	result := DropboxExpansionResult{
		Tasks:    make([]*Task, 0, len(added)),
		Filtered: filtered,
	}
	for _, item := range added {
		result.Tasks = append(result.Tasks, item.Task)
		if item.Duplicate {
			result.Duplicates++
		}
	}
	return result, true, nil
}

func newDropboxWebSessionClient(base *http.Client) *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{
		Transport:     base.Transport,
		CheckRedirect: base.CheckRedirect,
		Jar:           jar,
		Timeout:       base.Timeout,
	}
}

func crawlDropboxFolder(
	ctx context.Context,
	client *http.Client,
	csrf string,
	root dropboxWebShare,
	excluded map[string]struct{},
	profile dropboxComponentConfig,
) ([]dropboxFileWork, string, bool, int, error) {
	pending := []dropboxFolderWork{{Share: root}}
	seenFolders := map[string]struct{}{dropboxShareKey(root): {}}
	seenFiles := make(map[string]struct{})
	files := make([]dropboxFileWork, 0)
	rootName := ""
	filtered := 0
	directoryCount := 1
	var pageCount atomic.Int64

	for len(pending) > 0 {
		batchSize := min(len(pending), dropboxFolderWorkers)
		batch := append([]dropboxFolderWork(nil), pending[:batchSize]...)
		pending = pending[batchSize:]
		results := make([]dropboxFolderFetchResult, len(batch))
		batchCtx, cancel := context.WithCancel(ctx)
		var workers sync.WaitGroup
		for index, work := range batch {
			workers.Add(1)
			go func(index int, work dropboxFolderWork) {
				defer workers.Done()
				results[index] = fetchDropboxFolderPages(batchCtx, client, csrf, work, &pageCount, profile)
				if results[index].Err != nil {
					cancel()
				}
			}(index, work)
		}
		workers.Wait()
		cancel()

		for index, fetched := range results {
			work := batch[index]
			if fetched.Err != nil {
				return nil, "", true, filtered, fetched.Err
			}
			if !fetched.Handled {
				if len(work.Relative) == 0 {
					return nil, "", false, 0, nil
				}
				return nil, "", true, filtered, fmt.Errorf("Dropbox returned no folder metadata for %q", work.Share.SubPath)
			}
			if len(work.Relative) == 0 && fetched.Folder != nil {
				rootName = fetched.Folder.Filename
			}

			for _, entry := range fetched.Entries {
				if entry.IsDir {
					child, ok := parseDropboxWebShare(entry.Href)
					if !ok || child.LinkKey != root.LinkKey {
						return nil, "", true, filtered, fmt.Errorf("Dropbox returned an invalid child folder link")
					}
					relative := appendDropboxRelative(work.Relative, entry.Filename)
					if len(relative) > dropboxFolderMaxDepth {
						return nil, "", true, filtered, fmt.Errorf("Dropbox folder exceeds the %d-level depth limit", dropboxFolderMaxDepth)
					}
					key := dropboxShareKey(child)
					if _, exists := seenFolders[key]; exists {
						continue
					}
					directoryCount++
					if directoryCount > dropboxFolderMaxDirectories {
						return nil, "", true, filtered, fmt.Errorf("Dropbox folder exceeds the %d-directory safety limit", dropboxFolderMaxDirectories)
					}
					seenFolders[key] = struct{}{}
					pending = append(pending, dropboxFolderWork{Share: child, Relative: relative})
					continue
				}

				if len(files)+filtered >= dropboxFolderMaxFiles {
					return nil, "", true, filtered, fmt.Errorf("Dropbox folder exceeds the %d-file safety limit", dropboxFolderMaxFiles)
				}
				if dropboxFileExcluded(entry.Filename, entry.Href, excluded) {
					filtered++
					continue
				}
				fileLink, ok := dropboxFileDownloadLink(entry.Href, root.LinkKey)
				if !ok {
					return nil, "", true, filtered, fmt.Errorf("Dropbox returned an invalid file link")
				}
				if _, exists := seenFiles[fileLink]; exists {
					continue
				}
				seenFiles[fileLink] = struct{}{}
				files = append(files, dropboxFileWork{
					Name:     entry.Filename,
					Link:     fileLink,
					Relative: append([]string(nil), work.Relative...),
				})
			}
		}
	}
	return files, rootName, true, filtered, nil
}

type dropboxFolderFetchResult struct {
	Entries []dropboxWebEntry
	Folder  *dropboxWebEntry
	Handled bool
	Err     error
}

func fetchDropboxFolderPages(
	ctx context.Context,
	client *http.Client,
	csrf string,
	work dropboxFolderWork,
	pageCount *atomic.Int64,
	profile dropboxComponentConfig,
) dropboxFolderFetchResult {
	result := dropboxFolderFetchResult{Handled: true}
	voucher := ""
	firstPage := true
	for {
		if pageCount.Add(1) > dropboxFolderMaxPages {
			result.Err = fmt.Errorf("Dropbox folder exceeds the %d-page safety limit", dropboxFolderMaxPages)
			return result
		}
		page, err := requestDropboxFolderPage(ctx, client, csrf, work.Share, voucher, profile)
		if err != nil {
			result.Err = err
			return result
		}
		if firstPage {
			if page.Folder == nil || !page.Folder.IsDir {
				result.Handled = false
				return result
			}
			folder := *page.Folder
			result.Folder = &folder
		}
		if len(page.Entries) > dropboxFolderMaxEntries-len(result.Entries) {
			result.Err = fmt.Errorf("Dropbox folder exceeds the %d-entry safety limit", dropboxFolderMaxEntries)
			return result
		}
		result.Entries = append(result.Entries, page.Entries...)
		firstPage = false
		if !page.HasMoreEntries {
			return result
		}
		voucher = strings.TrimSpace(page.NextRequestVoucher)
		if voucher == "" || len(voucher) > 64*1024 {
			result.Err = fmt.Errorf("Dropbox returned an invalid continuation voucher")
			return result
		}
	}
}

func requestDropboxFolderPage(
	ctx context.Context,
	client *http.Client,
	csrf string,
	share dropboxWebShare,
	voucher string,
	profile dropboxComponentConfig,
) (dropboxFolderPage, error) {
	form := url.Values{
		"is_xhr":      {"true"},
		"t":           {csrf},
		"link_key":    {share.LinkKey},
		"link_type":   {"c"},
		"secure_hash": {share.SecureHash},
		"sub_path":    {share.SubPath},
	}
	if share.RLKey != "" {
		form.Set("rlkey", share.RLKey)
	}
	if voucher != "" {
		form.Set("voucher", voucher)
	}
	endpoint := dropboxFolderEntriesURL(profile)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return dropboxFolderPage{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Language", "en-US,en;q=0.9")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	request.Header.Set("Origin", "https://www.dropbox.com")
	request.Header.Set("Referer", share.PageURL)
	request.Header.Set("User-Agent", profile.UserAgent)
	request.Header.Set("X-Requested-With", "XMLHttpRequest")
	response, err := client.Do(request)
	if err != nil {
		return dropboxFolderPage{}, fmt.Errorf("list Dropbox folder %q: %w", share.SubPath, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return dropboxFolderPage{}, fmt.Errorf("list Dropbox folder %q returned HTTP %d", share.SubPath, response.StatusCode)
	}
	limited := &io.LimitedReader{R: response.Body, N: dropboxFolderResponseLimit + 1}
	decoder := json.NewDecoder(limited)
	page, err := decodeDropboxFolderPage(decoder)
	if err != nil {
		if limited.N <= 0 {
			return dropboxFolderPage{}, fmt.Errorf("Dropbox folder page is too large")
		}
		return dropboxFolderPage{}, fmt.Errorf("decode Dropbox folder %q: %w", share.SubPath, err)
	}
	if limited.N <= 0 {
		return dropboxFolderPage{}, fmt.Errorf("Dropbox folder page is too large")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return dropboxFolderPage{}, fmt.Errorf("Dropbox folder %q returned trailing JSON data", share.SubPath)
	}
	return page, nil
}

func decodeDropboxFolderPage(decoder *json.Decoder) (dropboxFolderPage, error) {
	start, err := decoder.Token()
	if err != nil {
		return dropboxFolderPage{}, err
	}
	if start != json.Delim('{') {
		return dropboxFolderPage{}, fmt.Errorf("Dropbox folder page must be a JSON object")
	}
	var page dropboxFolderPage
	for decoder.More() {
		name, err := decoder.Token()
		if err != nil {
			return dropboxFolderPage{}, err
		}
		switch name {
		case "entries":
			start, err := decoder.Token()
			if err != nil {
				return dropboxFolderPage{}, err
			}
			if start != json.Delim('[') {
				return dropboxFolderPage{}, fmt.Errorf("Dropbox folder entries must be an array")
			}
			for decoder.More() {
				if len(page.Entries) >= dropboxFolderMaxEntries {
					return dropboxFolderPage{}, fmt.Errorf("Dropbox folder exceeds the %d-entry safety limit", dropboxFolderMaxEntries)
				}
				var entry dropboxWebEntry
				if err := decoder.Decode(&entry); err != nil {
					return dropboxFolderPage{}, err
				}
				page.Entries = append(page.Entries, entry)
			}
			if _, err := decoder.Token(); err != nil {
				return dropboxFolderPage{}, err
			}
		case "folder":
			if err := decoder.Decode(&page.Folder); err != nil {
				return dropboxFolderPage{}, err
			}
		case "has_more_entries":
			if err := decoder.Decode(&page.HasMoreEntries); err != nil {
				return dropboxFolderPage{}, err
			}
		case "next_request_voucher":
			if err := decoder.Decode(&page.NextRequestVoucher); err != nil {
				return dropboxFolderPage{}, err
			}
		default:
			if err := skipJSONValue(decoder); err != nil {
				return dropboxFolderPage{}, err
			}
		}
	}
	if _, err := decoder.Token(); err != nil {
		return dropboxFolderPage{}, err
	}
	return page, nil
}

func skipJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, nested := token.(json.Delim)
	if !nested || (delimiter != '{' && delimiter != '[') {
		return nil
	}
	for decoder.More() {
		if delimiter == '{' {
			if _, err := decoder.Token(); err != nil {
				return err
			}
		}
		if err := skipJSONValue(decoder); err != nil {
			return err
		}
	}
	_, err = decoder.Token()
	return err
}

func primeDropboxWebSession(ctx context.Context, client *http.Client, value string, profile dropboxComponentConfig) (string, error) {
	pageURL, err := url.Parse(value)
	if err != nil {
		return "", err
	}
	query := pageURL.Query()
	query.Set("dl", "0")
	pageURL.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL.String(), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "text/html,application/xhtml+xml")
	request.Header.Set("Accept-Language", "en-US,en;q=0.9")
	request.Header.Set("User-Agent", profile.UserAgent)
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("Dropbox page returned HTTP %d", response.StatusCode)
	}
	endpoint, _ := url.Parse(dropboxFolderEntriesURL(profile))
	for _, cookie := range client.Jar.Cookies(endpoint) {
		if oneOf(cookie.Name, profile.CSRFCookieNames...) {
			if value := strings.TrimSpace(cookie.Value); value != "" {
				return value, nil
			}
		}
	}
	return "", fmt.Errorf("Dropbox did not issue a CSRF cookie")
}

func dropboxFolderEntriesURL(profile dropboxComponentConfig) string {
	return "https://www.dropbox.com" + profile.FolderEntriesPath
}

func parseDropboxWebShare(value string) (dropboxWebShare, bool) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || !isDropboxHost(parsed.Hostname()) {
		return dropboxWebShare{}, false
	}
	segments := strings.Split(strings.Trim(parsed.EscapedPath(), "/"), "/")
	if len(segments) < 4 || !strings.EqualFold(segments[0], "scl") || !strings.EqualFold(segments[1], "fo") {
		return dropboxWebShare{}, false
	}
	decoded := make([]string, 0, len(segments)-4)
	for _, segment := range segments[4:] {
		part, decodeErr := url.PathUnescape(segment)
		if decodeErr != nil || part == "" || strings.Contains(part, "/") {
			return dropboxWebShare{}, false
		}
		decoded = append(decoded, part)
	}
	linkKey, err1 := url.PathUnescape(segments[2])
	secureHash, err2 := url.PathUnescape(segments[3])
	if err1 != nil || err2 != nil || linkKey == "" || secureHash == "" || len(linkKey) > 256 || len(secureHash) > 256 {
		return dropboxWebShare{}, false
	}
	pageURL := *parsed
	pageURL.Fragment = ""
	subPath := ""
	if len(decoded) > 0 {
		subPath = "/" + strings.Join(decoded, "/")
	}
	return dropboxWebShare{
		LinkKey:    linkKey,
		SecureHash: secureHash,
		SubPath:    subPath,
		RLKey:      parsed.Query().Get("rlkey"),
		PageURL:    pageURL.String(),
	}, true
}

func dropboxFileDownloadLink(value, rootLinkKey string) (string, bool) {
	share, ok := parseDropboxWebShare(value)
	if !ok || share.LinkKey != rootLinkKey || share.SubPath == "/" {
		return "", false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", false
	}
	query := parsed.Query()
	query.Set("dl", "1")
	parsed.RawQuery = query.Encode()
	parsed.Fragment = ""
	return parsed.String(), true
}

// DropboxFolderDownloadLink turns a supported shared-folder URL into Dropbox's
// direct archive form. It leaves non-folder URLs untouched.
func DropboxFolderDownloadLink(value string) (string, bool) {
	if _, ok := parseDropboxWebShare(value); !ok {
		return value, false
	}
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return value, false
	}
	query := parsed.Query()
	query.Set("dl", "1")
	parsed.RawQuery = query.Encode()
	parsed.Fragment = ""
	return parsed.String(), true
}

func normalizeDropboxExcludedExtensions(rules DownloadRules, enabled bool) (map[string]struct{}, error) {
	result := make(map[string]struct{})
	if !enabled {
		return result, nil
	}
	rules.Enabled = true
	normalized, err := normalizeDownloadRules(rules)
	if err != nil {
		return nil, err
	}
	for _, value := range normalized.ExcludedExtensions {
		result[value] = struct{}{}
	}
	return result, nil
}

func dropboxFileExcluded(name, href string, excluded map[string]struct{}) bool {
	values := []string{strings.ToLower(strings.TrimSpace(name))}
	if parsed, err := url.Parse(href); err == nil {
		path, unescapeErr := url.PathUnescape(parsed.EscapedPath())
		if unescapeErr == nil {
			values = append(values, strings.ToLower(path))
		}
	}
	for suffix := range excluded {
		for _, value := range values {
			if strings.HasSuffix(value, suffix) {
				return true
			}
		}
	}
	return false
}

func appendDropboxRelative(parent []string, value string) []string {
	component := sanitizeDropboxPathComponent(value)
	if component == "" {
		component = "folder"
	}
	result := make([]string, len(parent), len(parent)+1)
	copy(result, parent)
	return append(result, component)
}

func sanitizeDropboxPathComponent(value string) string {
	value = strings.TrimSpace(value)
	var builder strings.Builder
	for _, char := range value {
		if char < 32 || char == 127 || strings.ContainsRune(`/\<>:"|?*`, char) {
			builder.WriteRune('_')
		} else {
			builder.WriteRune(char)
		}
	}
	value = strings.TrimRight(builder.String(), " .")
	if value == "." || value == ".." {
		value = "_" + value
	}
	base := strings.ToUpper(strings.SplitN(value, ".", 2)[0])
	switch base {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		value = "_" + value
	}
	for utf8.RuneCountInString(value) > 200 {
		_, size := utf8.DecodeLastRuneInString(value)
		value = value[:len(value)-size]
	}
	return value
}

func dropboxShareKey(share dropboxWebShare) string {
	return share.LinkKey + "\x00" + share.SecureHash + "\x00" + share.SubPath
}
