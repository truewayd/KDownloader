package systemupdate

import (
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

func installerAssetName(build int64) string {
	return fmt.Sprintf("TrueDown-build-%d-windows-%s-setup.exe", build, runtime.GOARCH)
}

func inspectInstaller(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := make([]byte, 64)
	if _, err := file.ReadAt(header, 0); err != nil || string(header[:2]) != "MZ" {
		return fmt.Errorf("invalid installer PE header")
	}
	offset := int64(binary.LittleEndian.Uint32(header[60:64]))
	if offset < 64 || offset > 4096 {
		return fmt.Errorf("invalid installer PE offset")
	}
	if _, err := file.ReadAt(header[:6], offset); err != nil || string(header[:6]) != "PE\x00\x00\x4c\x01" {
		return fmt.Errorf("invalid NSIS bootstrap architecture")
	}
	return nil
}

func (m *Manager) stageInstaller(ctx context.Context, path string, available *availableAppUpdate, manifest updateManifest) error {
	if err := validateNativeFiles(manifest.Files); err != nil {
		return err
	}
	if manifest.Asset.Name != installerAssetName(available.Build) {
		return fmt.Errorf("unexpected installer asset")
	}
	// Recheck the exact execution input, even when called outside the downloader.
	digest, size, err := nativeHash(path, maxReleaseArchiveBytes)
	if err != nil || digest != manifest.Asset.SHA256 || size != manifest.Asset.Size {
		return fmt.Errorf("installer failed its size or SHA-256 check")
	}
	if err := inspectInstaller(path); err != nil {
		return err
	}
	return m.stageNativePayload(path, available, manifest, func(path, directory string, files []nativeFile) error {
		return extractInstaller(ctx, path, directory, files)
	})
}

func extractInstaller(ctx context.Context, path, directory string, files []nativeFile) error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf("installer updates require Windows")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, path, "/S", "/UPDATE", "/TRUEDOWN-STAGE", "/D="+directory)
	configureInstallerProcess(command, directory)
	command.Env = withoutUpdateEnvironment(os.Environ())
	if err := command.Run(); err != nil {
		return fmt.Errorf("prepare installer update: %w", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) != len(files) {
		return fmt.Errorf("installer staged an unexpected file set")
	}
	for _, file := range files {
		if err := verifyNativeFile(directory, file); err != nil {
			return err
		}
		if filepath.Ext(file.Name) == ".exe" {
			if err := inspectNativePE(filepath.Join(directory, file.Name)); err != nil {
				return err
			}
		}
	}
	return nil
}
