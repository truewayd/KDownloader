// Package mediafire resolves public sharing links. It never transfers file
// payloads, opens output files, or imports TrueDown's manager/store packages.
package mediafire

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"truedown/internal/modulehost"
	"truedown/internal/netproxy"
)

var (
	ErrSource      = errors.New("invalid public MediaFire source")
	ErrUnavailable = errors.New("MediaFire link unavailable or requires browser interaction")
	ErrResponse    = errors.New("invalid MediaFire response")
	keyPattern     = regexp.MustCompile(`^[a-z0-9]{10,32}$`)
	cdnPattern     = regexp.MustCompile(`^download[0-9]+\.(mediafire\.com|mediafirecdn\.com)$`)
)

func ParseSource(raw string) (modulehost.HTTPSource, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 8192 || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" || (strings.ToLower(u.Host) != "www.mediafire.com" && strings.ToLower(u.Host) != "mediafire.com") {
		return modulehost.HTTPSource{}, ErrSource
	}
	key, kind := "", "file"
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if (u.Path == "" || u.Path == "/") && keyPattern.MatchString(u.RawQuery) {
		key = u.RawQuery
	} else if len(parts) >= 2 && (parts[0] == "file" || parts[0] == "download" || parts[0] == "folder") {
		key = parts[1]
		if parts[0] == "folder" {
			kind = "folder"
		}
	}
	if !keyPattern.MatchString(key) {
		return modulehost.HTTPSource{}, ErrSource
	}
	return modulehost.HTTPSource{Source: "https://www.mediafire.com/" + kind + "/" + key, Folder: kind == "folder"}, nil
}
func sourceKey(source modulehost.HTTPSource) string {
	parts := strings.Split(source.Source, "/")
	return parts[len(parts)-1]
}
func validCDN(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && len(raw) <= 16384 && u.Scheme == "https" && u.User == nil && u.Port() == "" && u.Fragment == "" && cdnPattern.MatchString(strings.ToLower(u.Host))
}

type Client struct{ http *http.Client }

func NewClient() *Client { c := &Client{}; _ = c.SetProxy(""); return c }
func (c *Client) SetProxy(raw string) error {
	proxy, err := netproxy.Resolved(raw)
	if err != nil {
		return ErrSource
	}
	if c.http != nil {
		c.http.CloseIdleConnections()
	}
	c.http = &http.Client{Transport: netproxy.NewTransport(proxy), Timeout: 25 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return ErrResponse
		}
		// Stop before a CDN request: the module must not download the payload.
		if validCDN(req.URL.String()) {
			return http.ErrUseLastResponse
		}
		if req.URL.Scheme != "https" || req.URL.User != nil || req.URL.Port() != "" || (strings.ToLower(req.URL.Host) != "www.mediafire.com" && strings.ToLower(req.URL.Host) != "mediafire.com") {
			return ErrResponse
		}
		return nil
	}}
	return nil
}
func (c *Client) get(ctx context.Context, raw string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, "", ErrSource
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 TrueDown-MediaFire/1.0")
	response, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		location, err := response.Location()
		if err == nil && validCDN(location.String()) {
			return nil, location.String(), nil
		}
		return nil, "", ErrUnavailable
	}
	if response.StatusCode != 200 {
		return nil, "", ErrUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	if err != nil || len(data) > 2*1024*1024 {
		return nil, "", ErrResponse
	}
	return data, "", nil
}

type fileInfo struct {
	Key      string          `json:"quickkey"`
	Name     string          `json:"filename"`
	Size     json.RawMessage `json:"size"`
	Hash     string          `json:"hash"`
	Privacy  string          `json:"privacy"`
	Password string          `json:"password_protected"`
}
type folderInfo struct {
	Key     string `json:"folderkey"`
	Name    string `json:"name"`
	Privacy string `json:"privacy"`
}
type apiResponse struct {
	Response struct {
		Result  string     `json:"result"`
		File    fileInfo   `json:"file_info"`
		Folder  folderInfo `json:"folder_info"`
		Content struct {
			Files   []fileInfo   `json:"files"`
			Folders []folderInfo `json:"folders"`
			More    string       `json:"more_chunks"`
		} `json:"folder_content"`
	} `json:"response"`
}

func (c *Client) api(ctx context.Context, method string, query url.Values) (apiResponse, error) {
	query.Set("response_format", "json")
	data, redirect, err := c.get(ctx, "https://www.mediafire.com/api/1.5/"+method+".php?"+query.Encode())
	var response apiResponse
	if err != nil {
		return response, err
	}
	if redirect != "" || json.Unmarshal(data, &response) != nil {
		return response, ErrResponse
	}
	if response.Response.Result != "Success" {
		return response, ErrUnavailable
	}
	return response, nil
}
func metadata(file fileInfo) (modulehost.PreparedHTTP, error) {
	if !keyPattern.MatchString(file.Key) || !modulehost.ValidCollectionName(file.Name) {
		return modulehost.PreparedHTTP{}, ErrResponse
	}
	if (file.Privacy != "" && file.Privacy != "public") || (file.Password != "" && file.Password != "no") {
		return modulehost.PreparedHTTP{}, ErrUnavailable
	}
	sizeText := string(file.Size)
	if strings.HasPrefix(sizeText, `"`) {
		if json.Unmarshal(file.Size, &sizeText) != nil {
			return modulehost.PreparedHTTP{}, ErrResponse
		}
	}
	size, err := strconv.ParseInt(sizeText, 10, 64)
	if err != nil || size < 0 || size > 1<<50 {
		return modulehost.PreparedHTTP{}, ErrResponse
	}
	digest := ""
	if len(file.Hash) == 64 {
		if decoded, err := hex.DecodeString(file.Hash); err != nil || len(decoded) != 32 {
			return modulehost.PreparedHTTP{}, ErrResponse
		}
		digest = strings.ToLower(file.Hash)
	}
	return modulehost.PreparedHTTP{Name: file.Name, Size: size, SHA256: digest}, nil
}
func (c *Client) Prepare(ctx context.Context, raw string) (modulehost.PreparedHTTP, error) {
	source, err := ParseSource(raw)
	if err != nil || source.Folder {
		return modulehost.PreparedHTTP{}, ErrSource
	}
	response, err := c.api(ctx, "file/get_info", url.Values{"quick_key": {sourceKey(source)}})
	if err != nil {
		return modulehost.PreparedHTTP{}, err
	}
	if response.Response.File.Key != sourceKey(source) {
		return modulehost.PreparedHTTP{}, ErrResponse
	}
	prepared, err := metadata(response.Response.File)
	if err != nil {
		return modulehost.PreparedHTTP{}, err
	}
	page, direct, err := c.get(ctx, source.Source)
	if err != nil {
		return modulehost.PreparedHTTP{}, err
	}
	if direct == "" {
		direct, err = downloadURL(string(page))
		if err != nil {
			return modulehost.PreparedHTTP{}, err
		}
	}
	prepared.URL = direct
	return prepared, nil
}

// Match complete quoted attributes, including > inside quotes. Bounds are
// enforced on the page before parsing. No script evaluation is performed.
var anchorPattern = regexp.MustCompile(`(?is)<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>`)
var attributePattern = regexp.MustCompile("(?is)([a-z_:][a-z0-9_:.-]*)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?")

func downloadURL(page string) (string, error) {
	for _, tag := range anchorPattern.FindAllString(page, -1) {
		attrs := map[string]string{}
		duplicate := false
		for _, match := range attributePattern.FindAllStringSubmatch(tag[2:len(tag)-1], -1) {
			key := strings.ToLower(match[1])
			if _, exists := attrs[key]; exists {
				duplicate = true
				break
			}
			attrs[key] = html.UnescapeString(match[2] + match[3] + match[4])
		}
		if duplicate || (attrs["id"] != "downloadButton" && attrs["aria-label"] != "Download file") {
			continue
		}
		if validCDN(attrs["href"]) {
			return attrs["href"], nil
		}
		if decoded, err := base64.StdEncoding.DecodeString(attrs["data-scrambled-url"]); err == nil && validCDN(string(decoded)) {
			return string(decoded), nil
		}
	}
	return "", ErrUnavailable
}

func (c *Client) List(ctx context.Context, raw string) (modulehost.ArtifactCollection, error) {
	source, err := ParseSource(raw)
	if err != nil || !source.Folder {
		return modulehost.ArtifactCollection{}, ErrSource
	}
	root, err := c.api(ctx, "folder/get_info", url.Values{"folder_key": {sourceKey(source)}})
	if err != nil {
		return modulehost.ArtifactCollection{}, err
	}
	if root.Response.Folder.Key != sourceKey(source) || !modulehost.ValidCollectionName(root.Response.Folder.Name) {
		return modulehost.ArtifactCollection{}, ErrResponse
	}
	collection := modulehost.ArtifactCollection{Name: root.Response.Folder.Name, Entries: []modulehost.ArtifactEntry{}}
	type pending struct {
		key  string
		path []string
	}
	queue := []pending{{key: sourceKey(source)}}
	seenFolders, seenFiles := map[string]bool{sourceKey(source): true}, map[string]bool{}
	for len(queue) > 0 {
		folder := queue[0]
		queue = queue[1:]
		if len(folder.path) >= 64 {
			return collection, ErrResponse
		}
		for _, kind := range []string{"files", "folders"} {
			for chunk := 1; ; chunk++ {
				if chunk > 60 {
					return collection, ErrResponse
				}
				page, err := c.api(ctx, "folder/get_content", url.Values{"folder_key": {folder.key}, "content_type": {kind}, "chunk": {strconv.Itoa(chunk)}, "chunk_size": {"100"}})
				if err != nil {
					return collection, err
				}
				content := page.Response.Content
				count := len(content.Files) + len(content.Folders)
				if count > 100 || (kind == "files" && len(content.Folders) != 0) || (kind == "folders" && len(content.Files) != 0) {
					return collection, ErrResponse
				}
				for _, file := range content.Files {
					meta, err := metadata(file)
					if err != nil {
						return collection, err
					}
					if seenFiles[file.Key] {
						return collection, ErrResponse
					}
					seenFiles[file.Key] = true
					collection.Entries = append(collection.Entries, modulehost.ArtifactEntry{Source: "https://www.mediafire.com/file/" + file.Key, Path: append(append([]string{}, folder.path...), meta.Name), Size: meta.Size, Data: json.RawMessage(`{}`)})
				}
				for _, child := range content.Folders {
					if !keyPattern.MatchString(child.Key) || !modulehost.ValidCollectionName(child.Name) || seenFolders[child.Key] || (child.Privacy != "" && child.Privacy != "public") {
						return collection, ErrResponse
					}
					seenFolders[child.Key] = true
					path := append(append([]string{}, folder.path...), child.Name)
					collection.Entries = append(collection.Entries, modulehost.ArtifactEntry{Path: path, Directory: true})
					queue = append(queue, pending{key: child.Key, path: path})
				}
				if len(seenFiles) > 5000 || len(seenFolders) > 1000 || len(collection.Entries) > 6000 {
					return collection, ErrResponse
				}
				if content.More == "no" {
					break
				}
				if content.More != "yes" || count == 0 {
					return collection, fmt.Errorf("%w: folder cursor", ErrResponse)
				}
			}
		}
	}
	if _, err := modulehost.ValidateCollection(&collection); err != nil {
		return collection, ErrResponse
	}
	return collection, nil
}
