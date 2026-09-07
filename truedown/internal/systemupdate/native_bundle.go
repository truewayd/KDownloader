package systemupdate

import (
	"archive/zip"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Engine binaries have a separate lifecycle. Only these application-owned
// files participate in a native program update, including their license text.
var nativeNames = []string{"truedown-core.exe", "truedown-cli.exe", "THIRD_PARTY_NOTICES.md", "NATIVE_LICENSES.txt", "TrueDown.exe"}

type nativeFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func nativeLimit(name string) int64 {
	if strings.HasSuffix(name, ".exe") {
		return maxExecutableBytes
	}
	return 4 << 20
}

func validateNativeFiles(files []nativeFile) error {
	if len(files) != len(nativeNames) {
		return fmt.Errorf("native release must contain the complete application file set")
	}
	seen := map[string]bool{}
	for _, file := range files {
		allowed := false
		for _, name := range nativeNames {
			if file.Name == name {
				allowed = true
				break
			}
		}
		if !allowed || seen[file.Name] || file.Size <= 2 || file.Size > nativeLimit(file.Name) || normalizeSHA256(file.SHA256) != file.SHA256 {
			return fmt.Errorf("invalid or duplicate native release file")
		}
		seen[file.Name] = true
	}
	return nil
}

func nativeHash(path string, maximum int64) (string, int64, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() {
		return "", 0, fmt.Errorf("native update files must be regular files")
	}
	return hashFile(path, maximum)
}

func verifyNativeFile(directory string, file nativeFile) error {
	digest, size, err := nativeHash(filepath.Join(directory, file.Name), nativeLimit(file.Name))
	if err != nil || digest != file.SHA256 || size != file.Size {
		return fmt.Errorf("native file %s failed its size or SHA-256 check", file.Name)
	}
	return nil
}

func inspectNativePE(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := make([]byte, 64)
	if _, err := io.ReadFull(file, header); err != nil || string(header[:2]) != "MZ" {
		return fmt.Errorf("native executable is not a Windows PE file")
	}
	offset := int64(binary.LittleEndian.Uint32(header[60:64]))
	if offset < 64 || offset > 4096 {
		return fmt.Errorf("invalid PE header offset")
	}
	if _, err := file.ReadAt(header[:6], offset); err != nil || string(header[:4]) != "PE\x00\x00" {
		return fmt.Errorf("invalid PE signature")
	}
	machine := uint16(0x8664)
	if runtime.GOARCH == "arm64" {
		machine = 0xaa64
	}
	if binary.LittleEndian.Uint16(header[4:6]) != machine {
		return fmt.Errorf("native executable architecture does not match this package")
	}
	return nil
}

func (m *Manager) stageNativeArchive(archivePath string, available *availableAppUpdate, manifest updateManifest) error {
	if err := os.MkdirAll(m.updatesDir, 0700); err != nil {
		return err
	}
	directory, err := os.MkdirTemp(m.updatesDir, fmt.Sprintf("native-build-%d-", available.Build))
	if err != nil {
		return err
	}
	keep := false
	defer func() {
		if !keep {
			removeNativeStage(directory)
		}
	}()
	if err := extractNativeArchive(archivePath, directory, manifest.Files); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.state.PendingUpdate
	next := m.state
	next.PendingUpdate = &pendingAppUpdate{Version: available.Version, Build: available.Build,
		File: filepath.Base(directory), SHA256: manifest.Asset.SHA256, NativeFiles: append([]nativeFile(nil), manifest.Files...)}
	next.LastUpdateError = ""
	if err := m.persistStateLocked(next); err != nil {
		return err
	}
	keep = true
	if previous != nil && len(previous.NativeFiles) > 0 && previous.File != next.PendingUpdate.File {
		if old, err := m.pendingUpdatePathLocked(previous); err == nil {
			removeNativeStage(old)
		}
	}
	return nil
}

func extractNativeArchive(archivePath, destination string, files []nativeFile) error {
	if err := validateNativeFiles(files); err != nil {
		return err
	}
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer archive.Close()
	if len(archive.File) == 0 || len(archive.File) > maxArchiveEntries {
		return fmt.Errorf("invalid native archive entry count")
	}
	entries := map[string]*zip.File{}
	var expanded uint64
	for _, entry := range archive.File {
		if entry.Name == "" || strings.ContainsAny(entry.Name, "/\\:") || entry.Name == "." || entry.Name == ".." || !entry.Mode().IsRegular() || entries[strings.ToLower(entry.Name)] != nil {
			return fmt.Errorf("native archive must contain unique regular top-level files")
		}
		if entry.UncompressedSize64 > maxArchiveExpanded-expanded {
			return fmt.Errorf("native archive expands beyond its limit")
		}
		expanded += entry.UncompressedSize64
		entries[strings.ToLower(entry.Name)] = entry
	}
	for _, expected := range files {
		entry := entries[strings.ToLower(expected.Name)]
		if entry == nil || entry.Name != expected.Name || entry.UncompressedSize64 != uint64(expected.Size) {
			return fmt.Errorf("native archive is missing %s or has a mismatched size", expected.Name)
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		path := filepath.Join(destination, expected.Name)
		output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			reader.Close()
			return err
		}
		written, copyErr := io.Copy(output, io.LimitReader(reader, expected.Size+1))
		reader.Close()
		syncErr := output.Sync()
		closeErr := output.Close()
		if copyErr != nil || syncErr != nil || closeErr != nil || written != expected.Size {
			return fmt.Errorf("cannot extract native file %s", expected.Name)
		}
		if err := verifyNativeFile(destination, expected); err != nil {
			return err
		}
		if strings.HasSuffix(expected.Name, ".exe") {
			if err := inspectNativePE(path); err != nil {
				return fmt.Errorf("%s: %w", expected.Name, err)
			}
		}
	}
	return nil
}

func removeNativeStage(directory string) {
	for _, name := range nativeNames {
		_ = os.Remove(filepath.Join(directory, name))
	}
	_ = os.Remove(directory)
}
