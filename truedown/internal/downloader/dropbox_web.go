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
	"time"
	"unicode/utf8"
)

const (
	dropboxFolderEntriesEndpoint = "https://www.dropbox.com/list_shared_link_folder_entries"
	dropboxFolderResponseLimit   = 16 * 1024 * 1024
	dropboxFolderMaxFiles        = 5000
	dropboxFolderMaxDirectories  = 1000
	dropboxFolderMaxPages        = 2000
	dropboxFolderMaxDepth        = 64
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
) (DropboxExpansionResult, bool, error) {
	share, ok := parseDropboxWebShare(link)
	if !ok {
		return DropboxExpansionResult{}, false, nil
	}
	identity := normalizeRequest(link, "", folder, m.defaultDir, headers, downloadPage, queueID, opts)
	if err := validateRequest(identity); err != nil {
		return DropboxExpansionResult{}, true, err
	}
	excluded, err := normalizeDropboxExcludedExtensions(m.DownloadRules())
	if err != nil {
		return DropboxExpansionResult{}, true, err
	}
	if m.dropboxClient == nil {
		return DropboxExpansionResult{}, true, fmt.Errorf("Dropbox web client is unavailable")
	}
	webClient := newDropboxWebSessionClient(m.dropboxClient)

	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	csrf, err := primeDropboxWebSession(ctx, webClient, share.PageURL)
	if err != nil {
		return DropboxExpansionResult{}, true, fmt.Errorf("open Dropbox shared folder: %w", err)
	}

	files, rootName, handled, filtered, err := crawlDropboxFolder(ctx, webClient, csrf, share, excluded)
	if err != nil || !handled {
		return DropboxExpansionResult{Filtered: filtered}, handled, err
	}

	baseFolder := identity.Folder
	rootName = sanitizeDropboxPathComponent(rootName)
	if rootName == "" {
		rootName = "Dropbox"
	}

	result := DropboxExpansionResult{
		Tasks:    make([]*Task, 0, len(files)),
		Filtered: filtered,
	}
	for _, file := range files {
		targetFolder := filepath.Join(baseFolder, rootName)
		if len(file.Relative) > 0 {
			targetFolder = filepath.Join(append([]string{targetFolder}, file.Relative...)...)
		}
		fileName := sanitizeDropboxPathComponent(file.Name)
		if fileName == "" {
			fileName = "file"
		}
		task, duplicate, addErr := m.AddTask(
			file.Link,
			fileName,
			targetFolder,
			identity.Headers,
			identity.DownloadPage,
			identity.QueueID,
			identity.Opts,
		)
		if addErr != nil {
			return result, true, fmt.Errorf("add Dropbox file %q: %w", file.Name, addErr)
		}
		if duplicate {
			result.Duplicates++
		}
		result.Tasks = append(result.Tasks, task)
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
) ([]dropboxFileWork, string, bool, int, error) {
	pending := []dropboxFolderWork{{Share: root}}
	seenFolders := map[string]struct{}{dropboxShareKey(root): {}}
	seenFiles := make(map[string]struct{})
	files := make([]dropboxFileWork, 0)
	rootName := ""
	filtered := 0
	directoryCount := 1
	pageCount := 0

	for len(pending) > 0 {
		work := pending[0]
		pending = pending[1:]
		voucher := ""
		firstPage := true
		for {
			pageCount++
			if pageCount > dropboxFolderMaxPages {
				return nil, "", true, filtered, fmt.Errorf("Dropbox folder exceeds the %d-page safety limit", dropboxFolderMaxPages)
			}
			page, err := requestDropboxFolderPage(ctx, client, csrf, work.Share, voucher)
			if err != nil {
				return nil, "", true, filtered, err
			}
			if firstPage && (page.Folder == nil || !page.Folder.IsDir) {
				if len(work.Relative) == 0 {
					return nil, "", false, 0, nil
				}
				return nil, "", true, filtered, fmt.Errorf("Dropbox returned no folder metadata for %q", work.Share.SubPath)
			}
			if firstPage && len(work.Relative) == 0 && page.Folder != nil {
				rootName = page.Folder.Filename
			}

			for _, entry := range page.Entries {
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

			firstPage = false
			if !page.HasMoreEntries {
				break
			}
			voucher = strings.TrimSpace(page.NextRequestVoucher)
			if voucher == "" || len(voucher) > 64*1024 {
				return nil, "", true, filtered, fmt.Errorf("Dropbox returned an invalid continuation voucher")
			}
		}
	}
	return files, rootName, true, filtered, nil
}

func requestDropboxFolderPage(
	ctx context.Context,
	client *http.Client,
	csrf string,
	share dropboxWebShare,
	voucher string,
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
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, dropboxFolderEntriesEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return dropboxFolderPage{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Language", "en-US,en;q=0.9")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	request.Header.Set("Origin", "https://www.dropbox.com")
	request.Header.Set("Referer", share.PageURL)
	request.Header.Set("User-Agent", "Mozilla/5.0")
	request.Header.Set("X-Requested-With", "XMLHttpRequest")
	response, err := client.Do(request)
	if err != nil {
		return dropboxFolderPage{}, fmt.Errorf("list Dropbox folder %q: %w", share.SubPath, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return dropboxFolderPage{}, fmt.Errorf("list Dropbox folder %q returned HTTP %d", share.SubPath, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, dropboxFolderResponseLimit+1))
	if err != nil {
		return dropboxFolderPage{}, fmt.Errorf("read Dropbox folder %q: %w", share.SubPath, err)
	}
	if len(body) > dropboxFolderResponseLimit {
		return dropboxFolderPage{}, fmt.Errorf("Dropbox folder page is too large")
	}
	var page dropboxFolderPage
	if err := json.Unmarshal(body, &page); err != nil {
		return dropboxFolderPage{}, fmt.Errorf("decode Dropbox folder %q: %w", share.SubPath, err)
	}
	return page, nil
}

func primeDropboxWebSession(ctx context.Context, client *http.Client, value string) (string, error) {
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
	request.Header.Set("User-Agent", "Mozilla/5.0")
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("Dropbox page returned HTTP %d", response.StatusCode)
	}
	endpoint, _ := url.Parse(dropboxFolderEntriesEndpoint)
	for _, cookie := range client.Jar.Cookies(endpoint) {
		if cookie.Name == "__Host-js_csrf" || cookie.Name == "t" {
			if value := strings.TrimSpace(cookie.Value); value != "" {
				return value, nil
			}
		}
	}
	return "", fmt.Errorf("Dropbox did not issue a CSRF cookie")
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

func normalizeDropboxExcludedExtensions(rules DownloadRules) (map[string]struct{}, error) {
	result := make(map[string]struct{})
	if !rules.Enabled {
		return result, nil
	}
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
