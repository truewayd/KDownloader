package downloader

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const maxTorrentMetainfoBytes = 4 * 1024 * 1024

type bitTorrentIdentity struct {
	Kind          string `json:"kind"`
	TorrentBase64 string `json:"torrentBase64,omitempty"`
	FileCount     int    `json:"fileCount,omitempty"`
	SmartFolder   bool   `json:"smartFolder"`
}

type torrentAddRPC interface {
	addTorrent(*Task, string, map[string]any) error
}

type torrentMetainfo struct {
	Name      string
	FileCount int
}

// AddBitTorrentLink accepts an explicit HTTP(S) metainfo URL or magnet link.
func (m *Manager) AddBitTorrentLink(link, folder string, headers map[string]string, downloadPage string, opts Aria2Opts) (*Task, bool, error) {
	if !m.aria2Next {
		return nil, false, &ValidationError{Message: "BitTorrent downloads require Aria2 Next; install and select it first"}
	}
	identity := normalizeRequest(link, torrentLinkName(link), folder, m.defaultDir, headers, downloadPage, 0, opts)
	identity.BitTorrent = &bitTorrentIdentity{Kind: "link", SmartFolder: true}
	if err := validateRequest(identity); err != nil {
		return nil, false, err
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.addIdentityLocked(identity, "")
}

// AddTorrentMetainfo validates and persists an imported .torrent payload.
func (m *Manager) AddTorrentMetainfo(data []byte, folder string, opts Aria2Opts) (*Task, bool, error) {
	if !m.aria2Next {
		return nil, false, &ValidationError{Message: "importing .torrent files requires Aria2 Next; install and select it first"}
	}
	if len(data) == 0 || len(data) > maxTorrentMetainfoBytes {
		return nil, false, &ValidationError{Message: "torrent file must be between 1 byte and 4 MiB"}
	}
	metadata, err := parseTorrentMetainfo(data)
	if err != nil {
		return nil, false, &ValidationError{Message: "invalid torrent metainfo: " + err.Error()}
	}
	digest := sha256.Sum256(data)
	identity := normalizeRequest("torrent://"+hex.EncodeToString(digest[:]), metadata.Name, folder, m.defaultDir, nil, "", 0, opts)
	identity.BitTorrent = &bitTorrentIdentity{
		Kind:          "file",
		TorrentBase64: base64.StdEncoding.EncodeToString(data),
		FileCount:     metadata.FileCount,
		SmartFolder:   true,
	}
	if err := validateRequest(identity); err != nil {
		return nil, false, err
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.addIdentityLocked(identity, "")
}

func validateBitTorrentIdentity(identity requestIdentity) error {
	source := identity.BitTorrent
	if source == nil || !source.SmartFolder {
		return errors.New("smart folder mode is required")
	}
	switch source.Kind {
	case "link":
		if source.TorrentBase64 != "" || source.FileCount != 0 {
			return errors.New("link source contains imported-file fields")
		}
		return validateBitTorrentLink(identity.Link)
	case "file":
		parsed, err := url.Parse(identity.Link)
		if err != nil || parsed.Scheme != "torrent" || len(parsed.Host) != 64 || parsed.Path != "" {
			return errors.New("invalid imported torrent identity")
		}
		if _, err := hex.DecodeString(parsed.Host); err != nil {
			return errors.New("invalid imported torrent digest")
		}
		data, err := base64.StdEncoding.DecodeString(source.TorrentBase64)
		if err != nil || len(data) == 0 || len(data) > maxTorrentMetainfoBytes {
			return errors.New("invalid imported torrent payload")
		}
		digest := sha256.Sum256(data)
		if !strings.EqualFold(parsed.Host, hex.EncodeToString(digest[:])) {
			return errors.New("imported torrent digest mismatch")
		}
		if source.FileCount < 1 || source.FileCount > 1_000_000 {
			return errors.New("invalid imported torrent metadata")
		}
		return nil
	default:
		return errors.New("unknown BitTorrent source kind")
	}
}

func validateBitTorrentLink(value string) error {
	if len(value) == 0 || len(value) > 16*1024 {
		return errors.New("BitTorrent link is empty or too long")
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return errors.New("invalid BitTorrent link")
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		return validateDownloadURL(value)
	}
	if parsed.Scheme != "magnet" || parsed.User != nil {
		return errors.New("only magnet or absolute HTTP(S) torrent links are supported")
	}
	for _, topic := range parsed.Query()["xt"] {
		lower := strings.ToLower(topic)
		if strings.HasPrefix(lower, "urn:btih:") || strings.HasPrefix(lower, "urn:btmh:") {
			return nil
		}
	}
	return errors.New("magnet link must contain a BitTorrent xt value")
}

func torrentLinkName(link string) string {
	parsed, err := url.Parse(strings.TrimSpace(link))
	if err == nil && parsed.Scheme == "magnet" {
		if name := strings.TrimSpace(parsed.Query().Get("dn")); validTorrentDisplayName(name) {
			return name
		}
		return "Magnet download"
	}
	name := displayName(link)
	if strings.EqualFold(filepath.Ext(name), ".torrent") {
		name = strings.TrimSuffix(name, filepath.Ext(name))
	}
	if validTorrentDisplayName(name) {
		return name
	}
	return "BitTorrent download"
}

func parseTorrentMetainfo(data []byte) (torrentMetainfo, error) {
	position := 0
	if len(data) == 0 || data[position] != 'd' {
		return torrentMetainfo{}, errors.New("root must be a bencoded dictionary")
	}
	position++
	var metadata torrentMetainfo
	foundInfo := false
	for position < len(data) && data[position] != 'e' {
		key, ok := bencodeBytes(data, &position)
		if !ok {
			return torrentMetainfo{}, errors.New("invalid root dictionary key")
		}
		if string(key) == "info" {
			if foundInfo {
				return torrentMetainfo{}, errors.New("duplicate info dictionary")
			}
			var err error
			metadata, err = parseTorrentInfo(data, &position)
			if err != nil {
				return torrentMetainfo{}, err
			}
			foundInfo = true
			continue
		}
		if !skipBencodeValue(data, &position, 0) {
			return torrentMetainfo{}, errors.New("invalid root dictionary value")
		}
	}
	if position >= len(data) || data[position] != 'e' || position+1 != len(data) {
		return torrentMetainfo{}, errors.New("unterminated root dictionary or trailing data")
	}
	if !foundInfo {
		return torrentMetainfo{}, errors.New("missing info dictionary")
	}
	return metadata, nil
}

func parseTorrentInfo(data []byte, position *int) (torrentMetainfo, error) {
	if *position >= len(data) || data[*position] != 'd' {
		return torrentMetainfo{}, errors.New("info must be a dictionary")
	}
	*position++
	name := ""
	utf8Name := ""
	fileCount := 1
	for *position < len(data) && data[*position] != 'e' {
		key, ok := bencodeBytes(data, position)
		if !ok {
			return torrentMetainfo{}, errors.New("invalid info dictionary key")
		}
		switch string(key) {
		case "name", "name.utf-8":
			value, ok := bencodeBytes(data, position)
			if !ok {
				return torrentMetainfo{}, errors.New("invalid torrent name")
			}
			if string(key) == "name.utf-8" {
				if !utf8.Valid(value) {
					return torrentMetainfo{}, errors.New("invalid UTF-8 torrent name")
				}
				utf8Name = string(value)
			} else if utf8.Valid(value) {
				name = string(value)
			}
		case "files":
			count, ok := countBencodeList(data, position)
			if !ok || count == 0 {
				return torrentMetainfo{}, errors.New("invalid multi-file list")
			}
			fileCount = count
		default:
			if !skipBencodeValue(data, position, 0) {
				return torrentMetainfo{}, errors.New("invalid info dictionary value")
			}
		}
	}
	if *position >= len(data) || data[*position] != 'e' {
		return torrentMetainfo{}, errors.New("unterminated info dictionary")
	}
	*position++
	if utf8Name != "" {
		name = utf8Name
	}
	name = strings.TrimSpace(name)
	if !validTorrentDisplayName(name) {
		return torrentMetainfo{}, errors.New("torrent name is not a safe path component")
	}
	return torrentMetainfo{Name: name, FileCount: fileCount}, nil
}

func countBencodeList(data []byte, position *int) (int, bool) {
	if *position >= len(data) || data[*position] != 'l' {
		return 0, false
	}
	*position++
	count := 0
	for *position < len(data) && data[*position] != 'e' {
		if count >= 1_000_000 || !skipBencodeValue(data, position, 0) {
			return 0, false
		}
		count++
	}
	if *position >= len(data) {
		return 0, false
	}
	*position++
	return count, true
}

func validTorrentDisplayName(name string) bool {
	if name == "" || name == "." || name == ".." || utf8.RuneCountInString(name) > 240 ||
		strings.ContainsAny(name, `/\<>:"|?*`) || strings.HasSuffix(name, " ") || strings.HasSuffix(name, ".") {
		return false
	}
	for _, char := range name {
		if char < 32 || char == 127 {
			return false
		}
	}
	base := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	switch base {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return false
	}
	return true
}
