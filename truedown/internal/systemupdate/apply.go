package systemupdate

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"truedown/internal/profile"
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
	m.lastErrorScope = "truedown"
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
	m.lastErrorScope = "truedown"
	m.state.LastUpdateError = m.lastError
	_ = m.persistLocked()
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

// Keep the journal if the child cannot be reaped. Replacing files underneath
// a possibly live shell would make a later recovery ambiguous.
var errReplacementStillRunning = errors.New("updated TrueDown has not exited")

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
	timer := time.NewTimer(90 * time.Second)
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
			// The health file can arrive on the same tick as the deadline.
			if healthTokenMatches(transaction.HealthPath, transaction.Token) {
				return nil
			}
			if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				return fmt.Errorf("%w: %v", errReplacementStillRunning, err)
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				return errReplacementStillRunning
			}
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
	// Keep the rollback guard separate from the strict, shared update settings.
	// Record it first so a restart never retries the build while clearing the stage.
	if err := writeAtomicFile(failedBuildPath(statePath), []byte(strconv.FormatInt(build, 10)+"\n"), 0600); err != nil {
		return err
	}
	state.LastUpdateError = truncate(updateError, 1024)
	data, err = json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomicFile(statePath, append(data, '\n'), 0600)
}

func failedBuildPath(statePath string) string {
	return filepath.Join(filepath.Dir(statePath), profile.UpdateFailedBuild)
}

func (m *Manager) isFailedBuild(build int64) (bool, error) {
	if m.statePath == "" {
		return false, nil
	}
	data, err := safefile.ReadFile(failedBuildPath(m.statePath), 32)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read TrueDown update rollback guard: %w", err)
	}
	failed, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || failed <= 0 {
		return false, fmt.Errorf("invalid TrueDown update rollback guard")
	}
	return failed == build, nil
}

func copyVerifiedExecutable(source, destination, expectedSHA string, expectedSize int64) error {
	info, err := os.Lstat(source)
	if err != nil {
		return fmt.Errorf("inspect executable: %w", err)
	}
	if !info.Mode().IsRegular() || expectedSize <= 2 || expectedSize > maxExecutableBytes || info.Size() != expectedSize {
		return fmt.Errorf("inspect executable: invalid source or size")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	opened, err := input.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return fmt.Errorf("copy executable: source changed before copying")
	}
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
	written, err := io.Copy(temporary, io.LimitReader(input, expectedSize+1))
	if err != nil {
		temporary.Close()
		return fmt.Errorf("copy executable: %w", err)
	}
	if written != expectedSize {
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
	copiedDigest, copiedSize, err := hashFile(temporaryPath, expectedSize)
	if err != nil || copiedSize != expectedSize || !strings.EqualFold(copiedDigest, expectedSHA) {
		return fmt.Errorf("copy executable: copied file failed its SHA-256 check")
	}
	return os.Rename(temporaryPath, destination)
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
