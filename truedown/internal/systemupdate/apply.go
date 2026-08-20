package systemupdate

import (
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
)

const (
	applyArgument        = "--truedown-apply-update"
	applySchemaVersion   = 1
	updateHealthFileEnv  = "TRUEDOWN_UPDATE_HEALTH_FILE"
	updateHealthTokenEnv = "TRUEDOWN_UPDATE_HEALTH_TOKEN"
	maxExecutableBytes   = 96 * 1024 * 1024
)

type applyTransaction struct {
	SchemaVersion int      `json:"schemaVersion"`
	Build         int64    `json:"build"`
	TargetPath    string   `json:"targetPath"`
	StagedPath    string   `json:"stagedPath"`
	BackupPath    string   `json:"backupPath"`
	StatePath     string   `json:"statePath"`
	HealthPath    string   `json:"healthPath"`
	HealthToken   string   `json:"healthToken"`
	ExpectedSHA   string   `json:"expectedSha256"`
	OriginalArgs  []string `json:"originalArgs,omitempty"`
}

// RunHelperIfRequested handles the private updater invocation before the normal
// TrueDown process initializes any files or listeners.
func RunHelperIfRequested(args []string) (bool, int) {
	if len(args) == 0 || args[0] != applyArgument {
		return false, 0
	}
	if len(args) != 2 {
		return true, 2
	}
	if err := runApplyTransaction(args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "TrueDown update failed:", err)
		return true, 1
	}
	return true, 0
}

// SignalHealthyFromEnvironment tells the update helper that the replacement
// process initialized successfully. Normal launches do nothing.
func SignalHealthyFromEnvironment() error {
	path := strings.TrimSpace(os.Getenv(updateHealthFileEnv))
	token := strings.TrimSpace(os.Getenv(updateHealthTokenEnv))
	if path == "" && token == "" {
		return nil
	}
	if path == "" || !validToken(token) || !filepath.IsAbs(path) {
		return fmt.Errorf("invalid TrueDown update health environment")
	}
	return writeAtomicFile(path, []byte(token+"\n"), 0600)
}

func IsUpdateRelaunch() bool {
	return strings.TrimSpace(os.Getenv(updateHealthFileEnv)) != ""
}

// LaunchPendingApply starts a copy of the current executable as an updater. The
// caller should then shut down normally so the helper can replace TrueDown.exe.
func (m *Manager) LaunchPendingApply(originalArgs []string) error {
	m.mu.Lock()
	if m.applyLaunched {
		m.mu.Unlock()
		return fmt.Errorf("TrueDown update restart is already in progress")
	}
	pending := m.state.PendingUpdate
	if pending == nil || pending.Build <= m.currentBuild {
		m.mu.Unlock()
		return fmt.Errorf("no staged TrueDown update is ready")
	}
	stagedPath, err := m.pendingUpdatePathLocked(pending)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	expectedSHA := pending.SHA256
	build := pending.Build
	m.mu.Unlock()

	digest, _, err := hashFile(stagedPath, maxExecutableBytes)
	if err != nil || !strings.EqualFold(digest, expectedSHA) {
		validationErr := fmt.Errorf("staged TrueDown update failed its SHA-256 check; check for updates again")
		_ = os.Remove(stagedPath)
		m.discardPendingUpdate(build, validationErr)
		return validationErr
	}
	if !strings.EqualFold(filepath.Clean(filepath.Dir(m.currentExe)), m.baseDir) {
		return fmt.Errorf("running TrueDown executable is outside its package directory")
	}
	updatesDir := filepath.Join(m.dataDir, "updates")
	if err := os.MkdirAll(updatesDir, 0700); err != nil {
		return fmt.Errorf("prepare update helper directory: %w", err)
	}
	helperPath := filepath.Join(updatesDir, fmt.Sprintf("TrueDown-updater-%d.exe", m.currentBuild))
	if err := copyExecutable(m.currentExe, helperPath); err != nil {
		return fmt.Errorf("prepare update helper: %w", err)
	}
	token, err := randomToken()
	if err != nil {
		return fmt.Errorf("prepare update health token: %w", err)
	}
	transactionPath := filepath.Join(updatesDir, fmt.Sprintf("apply-%d-%s.json", build, token[:12]))
	transaction := applyTransaction{
		SchemaVersion: applySchemaVersion,
		Build:         build,
		TargetPath:    m.currentExe,
		StagedPath:    stagedPath,
		BackupPath:    m.currentExe + ".previous",
		StatePath:     m.statePath,
		HealthPath:    filepath.Join(updatesDir, fmt.Sprintf("health-%d-%s", build, token[:12])),
		HealthToken:   token,
		ExpectedSHA:   strings.ToLower(expectedSHA),
		OriginalArgs:  sanitizeOriginalArgs(originalArgs),
	}
	data, err := json.MarshalIndent(transaction, "", "  ")
	if err != nil {
		return fmt.Errorf("encode update transaction: %w", err)
	}
	if err := writeAtomicFile(transactionPath, append(data, '\n'), 0600); err != nil {
		return fmt.Errorf("persist update transaction: %w", err)
	}
	command := exec.Command(helperPath, applyArgument, transactionPath)
	configureHiddenProcess(command)
	if err := command.Start(); err != nil {
		_ = os.Remove(transactionPath)
		return fmt.Errorf("start update helper: %w", err)
	}
	_ = command.Process.Release()
	m.mu.Lock()
	m.applyLaunched = true
	m.mu.Unlock()
	return nil
}

func (m *Manager) discardPendingUpdate(build int64, updateErr error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.PendingUpdate != nil && m.state.PendingUpdate.Build == build {
		m.state.PendingUpdate = nil
	}
	m.lastError = truncate(updateErr.Error(), 1024)
	m.state.LastUpdateError = m.lastError
	if persistErr := m.persistLocked(); persistErr != nil {
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
	directory := filepath.Join(m.dataDir, "updates")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && updateHelperPattern.MatchString(entry.Name()) {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
	}
}

func (m *Manager) pendingUpdatePathLocked(pending *pendingAppUpdate) (string, error) {
	if pending == nil || filepath.Base(pending.File) != pending.File || pending.File == "." || pending.File == "" {
		return "", fmt.Errorf("invalid staged TrueDown update metadata")
	}
	root := filepath.Clean(filepath.Join(m.dataDir, "updates"))
	path := filepath.Clean(filepath.Join(root, pending.File))
	if !pathWithin(root, path) {
		return "", fmt.Errorf("staged TrueDown update escapes its managed directory")
	}
	return path, nil
}

func runApplyTransaction(transactionPath string) error {
	transactionPath, err := filepath.Abs(transactionPath)
	if err != nil {
		return fmt.Errorf("resolve update transaction: %w", err)
	}
	transaction, err := loadApplyTransaction(transactionPath)
	if err != nil {
		return err
	}
	defer os.Remove(transactionPath)
	defer os.Remove(transaction.HealthPath)

	digest, _, err := hashFile(transaction.StagedPath, maxExecutableBytes)
	if err != nil || !strings.EqualFold(digest, transaction.ExpectedSHA) {
		return fmt.Errorf("staged executable failed its SHA-256 check")
	}
	candidatePath := transaction.TargetPath + ".update-new"
	if err := copyExecutable(transaction.StagedPath, candidatePath); err != nil {
		return fmt.Errorf("prepare replacement executable: %w", err)
	}
	defer os.Remove(candidatePath)
	_ = os.Remove(transaction.HealthPath)

	if err := waitAndBackupTarget(transaction.TargetPath, transaction.BackupPath, 45*time.Second); err != nil {
		return err
	}
	if err := os.Rename(candidatePath, transaction.TargetPath); err != nil {
		_ = os.Rename(transaction.BackupPath, transaction.TargetPath)
		return fmt.Errorf("activate replacement executable: %w", err)
	}
	if err := launchAndAwaitHealth(transaction); err != nil {
		rollbackErr := rollbackReplacement(transaction)
		if rollbackErr != nil {
			return fmt.Errorf("%v; rollback also failed: %w", err, rollbackErr)
		}
		return err
	}
	if err := clearPendingUpdate(transaction.StatePath, transaction.Build, ""); err != nil {
		return fmt.Errorf("finalize TrueDown update state: %w", err)
	}
	_ = os.Remove(transaction.StagedPath)
	return nil
}

func loadApplyTransaction(path string) (applyTransaction, error) {
	file, err := os.Open(path)
	if err != nil {
		return applyTransaction{}, fmt.Errorf("open update transaction: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024+1))
	decoder.DisallowUnknownFields()
	var transaction applyTransaction
	if err := decoder.Decode(&transaction); err != nil {
		return applyTransaction{}, fmt.Errorf("decode update transaction: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return applyTransaction{}, fmt.Errorf("update transaction must contain one JSON object")
	}
	if err := validateApplyTransaction(transaction, path); err != nil {
		return applyTransaction{}, err
	}
	return transaction, nil
}

func validateApplyTransaction(transaction applyTransaction, transactionPath string) error {
	if transaction.SchemaVersion != applySchemaVersion || transaction.Build <= 0 || normalizeSHA256(transaction.ExpectedSHA) == "" || !validToken(transaction.HealthToken) {
		return fmt.Errorf("invalid update transaction metadata")
	}
	for _, path := range []string{transaction.TargetPath, transaction.StagedPath, transaction.BackupPath, transaction.StatePath, transaction.HealthPath} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("update transaction contains an invalid path")
		}
	}
	updatesDir := filepath.Dir(transactionPath)
	if filepath.Dir(transaction.StagedPath) != updatesDir || filepath.Dir(transaction.StatePath) != filepath.Dir(updatesDir) || filepath.Dir(transaction.HealthPath) != updatesDir {
		return fmt.Errorf("update transaction paths are outside the managed update directory")
	}
	if transaction.BackupPath != transaction.TargetPath+".previous" || transaction.TargetPath == transaction.StagedPath {
		return fmt.Errorf("update transaction replacement paths are invalid")
	}
	if len(transaction.OriginalArgs) > 32 {
		return fmt.Errorf("update transaction contains too many process arguments")
	}
	for _, argument := range transaction.OriginalArgs {
		if len(argument) > 4096 || argument == applyArgument {
			return fmt.Errorf("update transaction contains an invalid process argument")
		}
	}
	return nil
}

func waitAndBackupTarget(targetPath, backupPath string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		_ = os.Remove(backupPath)
		if err := os.Rename(targetPath, backupPath); err == nil {
			return nil
		} else if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for the running TrueDown process to exit: %w", err)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func launchAndAwaitHealth(transaction applyTransaction) error {
	command := exec.Command(transaction.TargetPath, transaction.OriginalArgs...)
	command.Env = append(os.Environ(),
		updateHealthFileEnv+"="+transaction.HealthPath,
		updateHealthTokenEnv+"="+transaction.HealthToken,
	)
	configureHiddenProcess(command)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start updated TrueDown: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	for {
		select {
		case err := <-done:
			if err == nil {
				return fmt.Errorf("updated TrueDown exited before becoming healthy")
			}
			return fmt.Errorf("updated TrueDown exited before becoming healthy: %w", err)
		case <-ticker.C:
			data, err := os.ReadFile(transaction.HealthPath)
			if err == nil && strings.TrimSpace(string(data)) == transaction.HealthToken {
				return nil
			}
		case <-timer.C:
			_ = command.Process.Kill()
			<-done
			return fmt.Errorf("updated TrueDown did not report healthy startup")
		}
	}
}

func rollbackReplacement(transaction applyTransaction) error {
	_ = os.Remove(transaction.TargetPath)
	if err := os.Rename(transaction.BackupPath, transaction.TargetPath); err != nil {
		return err
	}
	_ = clearPendingUpdate(transaction.StatePath, transaction.Build, "updated TrueDown failed its startup health check and was rolled back")
	_ = os.Remove(transaction.StagedPath)
	command := exec.Command(transaction.TargetPath, transaction.OriginalArgs...)
	configureHiddenProcess(command)
	if err := command.Start(); err != nil {
		return fmt.Errorf("restart previous TrueDown: %w", err)
	}
	return command.Process.Release()
}

func clearPendingUpdate(statePath string, build int64, updateError string) error {
	file, err := os.Open(statePath)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(io.LimitReader(file, 256*1024+1))
	decoder.DisallowUnknownFields()
	var state persistedState
	err = decoder.Decode(&state)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if state.SchemaVersion != stateSchemaVersion {
		return fmt.Errorf("unsupported update settings schema %d", state.SchemaVersion)
	}
	if state.PendingUpdate != nil && state.PendingUpdate.Build == build {
		state.PendingUpdate = nil
	}
	state.LastUpdateError = truncate(updateError, 1024)
	data, err := json.MarshalIndent(state, "", "  ")
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

func sanitizeOriginalArgs(args []string) []string {
	result := make([]string, 0, len(args))
	for _, argument := range args {
		if argument == applyArgument || len(argument) > 4096 || len(result) >= 32 {
			continue
		}
		result = append(result, argument)
	}
	return result
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)) && !filepath.IsAbs(relative)
}
