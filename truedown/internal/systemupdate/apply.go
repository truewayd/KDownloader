package systemupdate

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"truedown/internal/safefile"
)

const (
	updateHealthFileEnv  = "TRUEDOWN_UPDATE_HEALTH_FILE"
	updateHealthTokenEnv = "TRUEDOWN_UPDATE_HEALTH_TOKEN"
	maxExecutableBytes   = 96 * 1024 * 1024
)

// LaunchPendingApply starts the verified native bundle helper. The caller then
// shuts down the owned core so the helper can replace the shell and sidecars.
func (m *Manager) LaunchPendingApply(arguments []string) error {
	if m.programUpdatesDisabled || m.nativeExecutable == "" {
		return fmt.Errorf("program updates require the packaged native desktop")
	}
	return m.launchNativeApply(arguments)
}

func (m *Manager) discardPendingUpdate(build int64, updateErr error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := m.state
	if next.PendingUpdate != nil && next.PendingUpdate.Build == build {
		next.PendingUpdate = nil
	}
	m.lastError = truncate(updateErr.Error(), 1024)
	next.LastUpdateError = m.lastError
	if persistErr := m.persistStateLocked(next); persistErr != nil {
		m.lastError += fmt.Sprintf("; persist update failure: %v", persistErr)
	}
}

func (m *Manager) recordUpdateError(updateErr error) {
	if updateErr == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastError = truncate(updateErr.Error(), 1024)
	m.state.LastUpdateError = m.lastError
	_ = m.persistLocked()
}

func (m *Manager) cleanupOldUpdateHelpers() {
	directory := m.updatesDir
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && updateHelperPattern.MatchString(entry.Name()) {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
		if entry.Type().IsRegular() && nativeHelperPattern.MatchString(entry.Name()) {
			info, err := entry.Info()
			if err == nil && m.now().Sub(info.ModTime()) > 24*time.Hour {
				// Never reclaim the recovery helper named by an unfinished marker.
				if _, err := os.Lstat(filepath.Join(m.baseDir, nativeMarkerName)); os.IsNotExist(err) {
					_ = os.Remove(filepath.Join(directory, entry.Name()))
				}
			}
		}
	}
}

func (m *Manager) pendingUpdatePathLocked(pending *pendingAppUpdate) (string, error) {
	if pending == nil || filepath.Base(pending.File) != pending.File || pending.File == "." || pending.File == "" {
		return "", fmt.Errorf("invalid staged TrueDown update metadata")
	}
	root := filepath.Clean(m.updatesDir)
	path := filepath.Clean(filepath.Join(root, pending.File))
	if !pathWithin(root, path) {
		return "", fmt.Errorf("staged TrueDown update escapes its managed directory")
	}
	return path, nil
}

func launchAndAwaitHealth(transaction nativeTransaction) error {
	command := exec.Command(filepath.Join(transaction.Directory, "TrueDown.exe"), transaction.Arguments...)
	command.Env = append(withoutUpdateEnvironment(os.Environ()),
		updateHealthFileEnv+"="+transaction.HealthPath,
		updateHealthTokenEnv+"="+transaction.Token,
	)
	command.Env = append(command.Env, nativeBypassEnv+"="+transaction.Token, "TRUEDOWN_UPDATE_EXPECTED_BUILD="+fmt.Sprint(transaction.Build))
	configureHiddenProcess(command)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start updated TrueDown: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	timer := time.NewTimer(60 * time.Second)
	defer timer.Stop()
	for {
		select {
		case err := <-done:
			if err == nil {
				return fmt.Errorf("updated TrueDown exited before becoming healthy")
			}
			return fmt.Errorf("updated TrueDown exited before becoming healthy: %w", err)
		case <-ticker.C:
			if healthTokenMatches(transaction.HealthPath, transaction.Token) {
				return nil
			}
		case <-timer.C:
			_ = command.Process.Kill()
			<-done
			return fmt.Errorf("updated TrueDown did not report healthy startup")
		}
	}
}

func healthTokenMatches(path, expected string) bool {
	data, err := safefile.ReadFile(path, 512)
	return err == nil && strings.TrimSpace(string(data)) == expected
}

func clearPendingUpdate(statePath string, build int64, updateError string) error {
	data, err := safefile.ReadFile(statePath, 256*1024)
	if err != nil {
		return err
	}
	data, err = requireJSONObject(data, "update settings")
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var state persistedState
	if err := decoder.Decode(&state); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("update settings must contain one JSON object")
	}
	if state.SchemaVersion != stateSchemaVersion {
		return fmt.Errorf("unsupported update settings schema %d", state.SchemaVersion)
	}
	if state.PendingUpdate != nil && state.PendingUpdate.Build == build {
		state.PendingUpdate = nil
	}
	state.LastUpdateError = truncate(updateError, 1024)
	data, err = json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomicFile(statePath, append(data, '\n'), 0600)
}

func copyExecutable(source, destination string) error {
	digest, size, err := hashFile(source, maxExecutableBytes)
	if err != nil {
		return fmt.Errorf("inspect executable: %w", err)
	}
	if digest == "" || size <= 2 {
		return fmt.Errorf("inspect executable: file is empty or invalid")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	directory := filepath.Dir(destination)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".truedown-copy-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0700); err != nil {
		temporary.Close()
		return err
	}
	written, err := io.Copy(temporary, io.LimitReader(input, maxExecutableBytes+1))
	if err != nil {
		temporary.Close()
		return fmt.Errorf("copy executable: %w", err)
	}
	if written != size {
		temporary.Close()
		return fmt.Errorf("copy executable: source changed while copying")
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	copiedDigest, copiedSize, err := hashFile(temporaryPath, maxExecutableBytes)
	if err != nil || copiedSize != size || !strings.EqualFold(copiedDigest, digest) {
		return fmt.Errorf("copy executable: copied file failed its SHA-256 check")
	}
	_ = os.Remove(destination)
	return os.Rename(temporaryPath, destination)
}

func copyVerifiedExecutable(source, destination, expectedSHA string, expectedSize int64) error {
	if err := copyExecutable(source, destination); err != nil {
		_ = os.Remove(destination)
		return err
	}
	digest, size, err := hashFile(destination, maxExecutableBytes)
	if err != nil || size != expectedSize || !strings.EqualFold(digest, expectedSHA) {
		_ = os.Remove(destination)
		return fmt.Errorf("copied executable does not match the staged update manifest")
	}
	return nil
}

func randomToken() (string, error) {
	data := make([]byte, 24)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func validToken(value string) bool {
	if len(value) != 48 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)) && !filepath.IsAbs(relative)
}
