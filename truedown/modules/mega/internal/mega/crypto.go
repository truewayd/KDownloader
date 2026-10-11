// Package mega implements anonymous MEGA public-file downloads. It does not use
// an application key, the official SDK, or an account session.
package mega

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"unicode/utf8"
)

var ErrSource = errors.New("invalid_source")
var ErrIntegrity = errors.New("integrity")
var ErrUnsupported = errors.New("unsupported")
var ErrNetwork = errors.New("network")
var ErrQuota = errors.New("quota")

type Link struct {
	Handle string
	Key    [32]byte
}

func ParseLink(raw string) (Link, error) {
	var link Link
	if len(raw) > 1024 {
		return link, ErrSource
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" {
		return link, ErrSource
	}
	switch strings.ToLower(u.Host) {
	case "mega.nz", "www.mega.nz", "mega.co.nz", "www.mega.co.nz":
	default:
		return link, ErrSource
	}
	var key string
	if strings.HasPrefix(u.Path, "/file/") {
		link.Handle = strings.TrimPrefix(u.Path, "/file/")
		key = u.Fragment
	} else if u.Path == "/" && strings.HasPrefix(u.Fragment, "!") {
		parts := strings.Split(u.Fragment, "!")
		if len(parts) != 3 {
			return Link{}, ErrSource
		}
		link.Handle, key = parts[1], parts[2]
	} else {
		return link, ErrUnsupported
	}
	handle, err := base64.RawURLEncoding.Strict().DecodeString(link.Handle)
	if err != nil || len(handle) != 6 || len(link.Handle) != 8 || len(key) != 43 {
		return Link{}, ErrSource
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(key)
	if err != nil || len(decoded) != 32 {
		return Link{}, ErrSource
	}
	copy(link.Key[:], decoded)
	return link, nil
}

func (link Link) block() cipher.Block {
	var key [16]byte
	for i := range key {
		key[i] = link.Key[i] ^ link.Key[i+16]
	}
	block, _ := aes.NewCipher(key[:])
	return block
}

func (link Link) DecryptAttributes(encoded string) (string, error) {
	if len(encoded) > 64*1024 {
		return "", ErrSource
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return "", ErrSource
	}
	var iv [16]byte
	cipher.NewCBCDecrypter(link.block(), iv[:]).CryptBlocks(data, data)
	data = bytes.TrimRight(data, "\x00")
	if !bytes.HasPrefix(data, []byte("MEGA{")) || !utf8.Valid(data) {
		return "", ErrSource
	}
	var attributes struct {
		Name string `json:"n"`
	}
	if json.Unmarshal(data[4:], &attributes) != nil || attributes.Name == "" || len(attributes.Name) > 4096 || strings.ContainsRune(attributes.Name, 0) {
		return "", ErrSource
	}
	return attributes.Name, nil
}

func (link Link) Stream(offset int64) (cipher.Stream, error) {
	if offset < 0 || offset%16 != 0 {
		return nil, ErrSource
	}
	var iv [16]byte
	copy(iv[:8], link.Key[16:24])
	binary.BigEndian.PutUint64(iv[8:], uint64(offset/16))
	return cipher.NewCTR(link.block(), iv[:]), nil
}

// MAC follows the SDK's CBC chunk MAC and ordered MAC-of-MACs. It retains only
// one AES block, even for large files, and never authenticates a partial prefix.
type MAC struct {
	block                             cipher.Block
	seed, current, aggregate, pending [16]byte
	used                              int
	chunkBytes, chunkSize             int64
}

func (link Link) NewMAC() *MAC {
	m := &MAC{block: link.block(), chunkSize: 128 * 1024}
	copy(m.seed[:8], link.Key[16:24])
	copy(m.seed[8:], link.Key[16:24])
	m.current = m.seed
	return m
}

func (m *MAC) Write(data []byte) (int, error) {
	n := len(data)
	for len(data) > 0 {
		copied := copy(m.pending[m.used:], data)
		m.used += copied
		data = data[copied:]
		if m.used == 16 {
			m.blockMAC(16)
		}
	}
	return n, nil
}

func (m *MAC) blockMAC(size int) {
	for i := range m.current {
		m.current[i] ^= m.pending[i]
	}
	m.block.Encrypt(m.current[:], m.current[:])
	m.chunkBytes += int64(size)
	m.pending = [16]byte{}
	m.used = 0
	if m.chunkBytes == m.chunkSize {
		m.fold()
	}
}

func (m *MAC) fold() {
	for i := range m.aggregate {
		m.aggregate[i] ^= m.current[i]
	}
	m.block.Encrypt(m.aggregate[:], m.aggregate[:])
	m.current = m.seed
	m.chunkBytes = 0
	if m.chunkSize < 1024*1024 {
		m.chunkSize += 128 * 1024
	}
}

func (m *MAC) Sum() [8]byte {
	copyMAC := *m
	if copyMAC.used != 0 {
		copyMAC.blockMAC(copyMAC.used)
	}
	if copyMAC.chunkBytes != 0 {
		copyMAC.fold()
	}
	var result [8]byte
	for i := 0; i < 4; i++ {
		result[i] = copyMAC.aggregate[i] ^ copyMAC.aggregate[i+4]
		result[i+4] = copyMAC.aggregate[i+8] ^ copyMAC.aggregate[i+12]
	}
	return result
}

func (link Link) Verify(m *MAC) error {
	actual := m.Sum()
	if subtle.ConstantTimeCompare(actual[:], link.Key[24:]) != 1 {
		return ErrIntegrity
	}
	return nil
}
