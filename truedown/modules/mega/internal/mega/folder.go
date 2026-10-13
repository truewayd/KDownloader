package mega

import (
	"context"
	"crypto/aes"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"sort"
	"strings"

	"truedown/internal/modulehost"
)

const maxFolderNodes = 6000

type Source struct {
	File     Link
	Folder   string
	Key      [16]byte
	Node     string
	NodeKind string
}

func validHandle(value string) bool {
	data, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(value) == 8 && len(data) == 6
}

func ParseSource(raw string) (Source, error) {
	if link, err := ParseLink(raw); err == nil {
		return Source{File: link}, nil
	}
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 1024 || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" {
		return Source{}, ErrSource
	}
	switch strings.ToLower(u.Host) {
	case "mega.nz", "www.mega.nz", "mega.co.nz", "www.mega.co.nz":
	default:
		return Source{}, ErrSource
	}
	var s Source
	var key string
	if strings.HasPrefix(u.Path, "/folder/") {
		s.Folder = strings.TrimPrefix(u.Path, "/folder/")
		parts := strings.Split(u.Fragment, "/")
		key = parts[0]
		if len(parts) == 3 && (parts[1] == "file" || parts[1] == "folder") && validHandle(parts[2]) {
			s.NodeKind, s.Node = parts[1], parts[2]
		} else if len(parts) != 1 {
			return Source{}, ErrSource
		}
	} else if u.Path == "/" && strings.HasPrefix(u.Fragment, "F!") {
		parts := strings.Split(u.Fragment, "!")
		if len(parts) != 3 && len(parts) != 4 {
			return Source{}, ErrSource
		}
		s.Folder, key = parts[1], parts[2]
		if len(parts) == 4 {
			if !validHandle(parts[3]) {
				return Source{}, ErrSource
			}
			s.NodeKind, s.Node = "folder", parts[3]
		}
	} else {
		return Source{}, ErrUnsupported
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(key)
	if err != nil || len(decoded) != 16 || len(key) != 22 || !validHandle(s.Folder) {
		return Source{}, ErrSource
	}
	copy(s.Key[:], decoded)
	return s, nil
}

func (s Source) URL() string {
	if s.Folder == "" {
		return "https://mega.nz/file/" + s.File.Handle + "#" + base64.RawURLEncoding.EncodeToString(s.File.Key[:])
	}
	value := "https://mega.nz/folder/" + s.Folder + "#" + base64.RawURLEncoding.EncodeToString(s.Key[:])
	if s.Node != "" {
		value += "/" + s.NodeKind + "/" + s.Node
	}
	return value
}

type FileData struct {
	Node string `json:"node"`
	Key  string `json:"key"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// A folder child's handle is private to that share, not a public-file handle.
func FileLink(source Source, data json.RawMessage) (Link, FileData, error) {
	if source.Folder == "" {
		return source.File, FileData{}, nil
	}
	var file FileData
	if source.NodeKind != "file" || modulehost.Decode(data, &file) != nil || file.Node != source.Node || file.Name == "" || len(file.Name) > 4096 || file.Size < 0 || file.Size > 1<<50 {
		return Link{}, file, ErrSource
	}
	key, err := base64.RawURLEncoding.Strict().DecodeString(file.Key)
	if err != nil || len(file.Key) != 43 || len(key) != 32 {
		return Link{}, file, ErrSource
	}
	link := Link{Handle: file.Node}
	copy(link.Key[:], key)
	return link, file, nil
}

type folderNode struct {
	Handle     string `json:"h"`
	Parent     string `json:"p"`
	Type       int    `json:"t"`
	Key        string `json:"k"`
	Attributes string `json:"a"`
	Size       int64  `json:"s"`
	name       string
	key        []byte
}

// Protocol behavior is referenced to MEGAJS lib/file.mjs at the revision in
// sources.json (MIT). This independent implementation has no JS dependency.
func (c *Client) ListFolder(ctx context.Context, source Source) (modulehost.ArtifactCollection, error) {
	var response struct {
		Nodes []folderNode `json:"f"`
	}
	if source.Folder == "" {
		return modulehost.ArtifactCollection{}, ErrSource
	}
	if err := c.api(ctx, source.Folder, map[string]any{"a": "f", "c": 1, "ca": 1, "r": 1}, 16*1024*1024, &response); err != nil {
		return modulehost.ArtifactCollection{}, err
	}
	if len(response.Nodes) == 0 || len(response.Nodes) > maxFolderNodes {
		return modulehost.ArtifactCollection{}, ErrSource
	}
	nodes := make(map[string]*folderNode, len(response.Nodes))
	root := ""
	for i := range response.Nodes {
		n := &response.Nodes[i]
		if !validHandle(n.Handle) || (n.Type != 0 && n.Type != 1) || nodes[n.Handle] != nil || n.Size < 0 || n.Size > 1<<50 {
			return modulehost.ArtifactCollection{}, ErrSource
		}
		nodes[n.Handle] = n
		if n.Type == 1 {
			for _, alternative := range strings.Split(n.Key, "/") {
				if strings.HasPrefix(alternative, n.Handle+":") {
					if root != "" && root != n.Handle {
						return modulehost.ArtifactCollection{}, ErrSource
					}
					root = n.Handle
				}
			}
		}
	}
	if root == "" {
		return modulehost.ArtifactCollection{}, ErrSource
	}
	block, _ := aes.NewCipher(source.Key[:])
	for _, n := range nodes {
		for _, alternative := range strings.Split(n.Key, "/") {
			parts := strings.Split(alternative, ":")
			if len(parts) != 2 || parts[0] != root {
				continue
			}
			key, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
			length := 32
			if n.Type == 1 {
				length = 16
			}
			if err != nil || len(key) != length {
				return modulehost.ArtifactCollection{}, ErrSource
			}
			for offset := 0; offset < len(key); offset += aes.BlockSize {
				block.Decrypt(key[offset:offset+16], key[offset:offset+16])
			}
			n.key = key
			attributeBlock := block
			if n.Type == 1 {
				attributeBlock, _ = aes.NewCipher(key)
			} else {
				var file Link
				copy(file.Key[:], key)
				attributeBlock = file.block()
			}
			n.name, err = decryptAttributes(attributeBlock, n.Attributes)
			if err != nil {
				return modulehost.ArtifactCollection{}, err
			}
			break
		}
		if n.name == "" {
			return modulehost.ArtifactCollection{}, ErrSource
		}
	}
	selected := root
	if source.Node != "" {
		selected = source.Node
	}
	if nodes[selected] == nil {
		return modulehost.ArtifactCollection{}, ErrSource
	}
	if source.Node != "" && ((source.NodeKind == "file") != (nodes[selected].Type == 0)) {
		return modulehost.ArtifactCollection{}, ErrSource
	}
	// Validate every parent chain before selecting a subtree. Broken or cyclic
	// responses must not silently omit files from an apparently complete ZIP.
	paths := make(map[string][]string, len(nodes))
	var pathFor func(string, map[string]bool) ([]string, error)
	pathFor = func(handle string, active map[string]bool) ([]string, error) {
		if handle == root {
			return []string{}, nil
		}
		if path, ok := paths[handle]; ok {
			return path, nil
		}
		n := nodes[handle]
		if n == nil || active[handle] || len(active) >= 64 || nodes[n.Parent] == nil || nodes[n.Parent].Type != 1 {
			return nil, ErrSource
		}
		active[handle] = true
		parent, err := pathFor(n.Parent, active)
		delete(active, handle)
		if err != nil {
			return nil, err
		}
		path := append(append([]string{}, parent...), n.name)
		paths[handle] = path
		return path, nil
	}
	for handle := range nodes {
		if _, err := pathFor(handle, map[string]bool{}); err != nil {
			return modulehost.ArtifactCollection{}, err
		}
	}
	base, _ := pathFor(selected, map[string]bool{})
	result := modulehost.ArtifactCollection{Name: nodes[selected].name}
	for handle, n := range nodes {
		if handle == selected && n.Type == 1 {
			continue
		}
		ancestor := handle
		for ancestor != selected && ancestor != root {
			ancestor = nodes[ancestor].Parent
		}
		if ancestor != selected {
			continue
		}
		path, _ := pathFor(handle, map[string]bool{})
		if len(path) <= len(base) {
			continue
		}
		entry := modulehost.ArtifactEntry{Path: append([]string{}, path[len(base):]...), Size: n.Size, Directory: n.Type == 1}
		if !entry.Directory {
			child := source
			child.NodeKind, child.Node = "file", handle
			entry.Source = child.URL()
			entry.Data, _ = json.Marshal(FileData{Node: handle, Key: base64.RawURLEncoding.EncodeToString(n.key), Name: n.name, Size: n.Size})
		}
		result.Entries = append(result.Entries, entry)
	}
	if nodes[selected].Type == 0 {
		n := nodes[selected]
		child := source
		child.NodeKind = "file"
		data, _ := json.Marshal(FileData{Node: selected, Key: base64.RawURLEncoding.EncodeToString(n.key), Name: n.name, Size: n.Size})
		result.Entries = []modulehost.ArtifactEntry{{Source: child.URL(), Path: []string{n.name}, Size: n.Size, Data: data}}
	}
	sort.Slice(result.Entries, func(i, j int) bool {
		return strings.Join(result.Entries[i].Path, "/") < strings.Join(result.Entries[j].Path, "/")
	})
	return result, nil
}
