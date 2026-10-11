package modulehost

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const MaxExecutableBytes = 64 * 1024 * 1024

type ExecutableManifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	ID            string `json:"id"`
	Version       string `json:"version"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	Protocol      int    `json:"protocol"`
	Size          int64  `json:"size"`
	SHA256        string `json:"sha256"`
}

var ErrPackage = errors.New("invalid executable module package")

func Version(value string) ([3]uint64, error) {
	var result [3]uint64
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return result, ErrPackage
	}
	for i, part := range parts {
		n, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(n, 10) != part {
			return result, ErrPackage
		}
		result[i] = n
	}
	return result, nil
}

func Newer(candidate, current string) bool {
	a, err := Version(candidate)
	if err != nil {
		return false
	}
	b, err := Version(current)
	if err != nil {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func DecodeManifest(raw []byte, id string) (ExecutableManifest, error) {
	var m ExecutableManifest
	if len(raw) > 16*1024 || Decode(raw, &m) != nil || m.SchemaVersion != 1 || m.ID != id || id == "" || strings.ContainsAny(id, "/\\.:") || m.OS != runtime.GOOS || m.Arch != runtime.GOARCH || m.Protocol != ProtocolVersion || m.Size <= 0 || m.Size > MaxExecutableBytes {
		return m, ErrPackage
	}
	if _, err := Version(m.Version); err != nil {
		return m, ErrPackage
	}
	if digest, err := hex.DecodeString(m.SHA256); err != nil || len(digest) != 32 || m.SHA256 != strings.ToLower(m.SHA256) {
		return m, ErrPackage
	}
	return m, nil
}

// InstallSigned verifies an independently published binary before activation.
// Keys are supplied by the trusted host, never by the downloaded package.
// The caller owns this private directory and serializes installation/selection.
func InstallSigned(root, id, current string, raw, signature []byte, key ed25519.PublicKey, binary io.Reader) (string, error) {
	if len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, raw, signature) {
		return "", ErrPackage
	}
	m, err := DecodeManifest(raw, id)
	if err != nil || !Newer(m.Version, current) {
		return "", ErrPackage
	}
	if err := MakeDirectory(root); err != nil {
		return "", err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", ErrPackage
	}
	entry := "provider"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	final := filepath.Join(root, m.Version)
	if info, err := os.Lstat(final); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", ErrPackage
		}
		oldManifest, err := readRegular(filepath.Join(final, "manifest.json"), 16*1024)
		if err != nil || !bytes.Equal(raw, oldManifest) {
			return "", ErrPackage
		}
		oldSignature, err := readRegular(filepath.Join(final, "manifest.sig"), 64)
		if err != nil || !bytes.Equal(signature, oldSignature) {
			return "", ErrPackage
		}
		data, err := readRegular(filepath.Join(final, entry), MaxExecutableBytes)
		if err != nil || int64(len(data)) != m.Size {
			return "", ErrPackage
		}
		hash := sha256.Sum256(data)
		if hex.EncodeToString(hash[:]) != m.SHA256 {
			return "", ErrPackage
		}
		return filepath.Join(final, entry), nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	directory, err := os.MkdirTemp(root, ".install-")
	if err != nil {
		return "", err
	}
	path := filepath.Join(directory, entry)
	committed := false
	defer func() {
		if !committed {
			os.Remove(path)
			os.Remove(filepath.Join(directory, "manifest.json"))
			os.Remove(filepath.Join(directory, "manifest.sig"))
			os.Remove(directory)
		}
	}()
	output, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(binary, m.Size+1))
	if err == nil {
		err = output.Sync()
	}
	if closeErr := output.Close(); err == nil {
		err = closeErr
	}
	if err != nil || n != m.Size || hex.EncodeToString(hash.Sum(nil)) != m.SHA256 {
		return "", ErrPackage
	}
	if err := os.WriteFile(filepath.Join(directory, "manifest.json"), raw, 0600); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(directory, "manifest.sig"), signature, 0600); err != nil {
		return "", err
	}
	if _, err := os.Lstat(final); !os.IsNotExist(err) {
		return "", ErrPackage
	}
	if err := os.Rename(directory, final); err != nil {
		return "", err
	}
	committed = true
	return filepath.Join(final, entry), nil
}

func readRegular(path string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maximum {
		return nil, ErrPackage
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, ErrPackage
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(data)) != info.Size() {
		return nil, ErrPackage
	}
	return data, nil
}
