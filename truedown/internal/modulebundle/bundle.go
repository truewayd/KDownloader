// Package modulebundle carries independently built baseline executables in the
// signed application distribution; their Go implementations are not linked in.
package modulebundle

import (
	"crypto/sha256"
	"embed"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"truedown/internal/modulehost"
)

//go:embed assets/*
var assets embed.FS

var extractMu sync.Mutex

func Ensure(root, id string) (string, error) {
	extractMu.Lock()
	defer extractMu.Unlock()
	if id != "mega" {
		return "", fmt.Errorf("unknown bundled module")
	}
	data, err := assets.ReadFile("assets/" + id + "-" + runtime.GOOS + "-" + runtime.GOARCH + ".bin")
	if err != nil || len(data) == 0 || len(data) > 64*1024*1024 {
		return "", fmt.Errorf("bundled download module is unavailable")
	}
	digest := sha256.Sum256(data)
	directory := filepath.Join(root, "baseline", fmt.Sprintf("%x", digest))
	if err := modulehost.MakeDirectory(directory); err != nil {
		return "", err
	}
	entry := "provider"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	path := filepath.Join(directory, entry)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		file, err := os.CreateTemp(directory, ".extract-")
		if err != nil {
			return "", err
		}
		defer os.Remove(file.Name())
		if err := file.Chmod(0700); err != nil {
			file.Close()
			return "", err
		}
		_, err = file.Write(data)
		if err == nil {
			err = file.Sync()
		}
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return "", err
		}
		if err := os.Rename(file.Name(), path); err != nil {
			return "", err
		}
		return path, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() != int64(len(data)) {
		return "", fmt.Errorf("invalid bundled module cache")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return "", fmt.Errorf("module cache changed")
	}
	hash := sha256.New()
	_, err = io.Copy(hash, io.LimitReader(file, int64(len(data))+1))
	if err != nil || fmt.Sprintf("%x", hash.Sum(nil)) != fmt.Sprintf("%x", digest) {
		return "", fmt.Errorf("module cache checksum mismatch")
	}
	return path, nil
}
