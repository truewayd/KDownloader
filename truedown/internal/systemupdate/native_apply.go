package systemupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"truedown/internal/safefile"
)

const nativeApplyArgument = "--truedown-apply-native-update"
const nativeMarkerName = "TrueDown.update.json"
const nativeBypassEnv = "TRUEDOWN_UPDATE_BYPASS"

type nativeReplacement struct {
	New nativeFile `json:"new"`
	Old nativeFile `json:"old"`
}

type nativeTransaction struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Build         int64               `json:"build"`
	Directory     string              `json:"directory"`
	Stage         string              `json:"stage"`
	StatePath     string              `json:"statePath"`
	HealthPath    string              `json:"healthPath"`
	Token         string              `json:"token"`
	Arguments     []string            `json:"arguments"`
	Files         []nativeReplacement `json:"files"`
}

type nativeMarker struct {
	SchemaVersion int    `json:"schemaVersion"`
	Transaction   string `json:"transaction"`
	Helper        string `json:"helper"`
	SHA256        string `json:"sha256"`
	Token         string `json:"token"`
}

func RunNativeHelperIfRequested(args []string) (bool, int) {
	if len(args) == 0 || args[0] != nativeApplyArgument {
		return false, 0
	}
	if len(args) != 3 || (args[2] != "apply" && args[2] != "recover") {
		return true, 2
	}
	if err := runNativeTransaction(args[1], args[2] == "recover"); err != nil {
		fmt.Fprintln(os.Stderr, "TrueDown native update failed:", err)
		return true, 1
	}
	return true, 0
}

func (m *Manager) launchNativeApply(arguments []string) error {
	release, busy, err := nativeUpdateLock(m.baseDir)
	if err != nil {
		return err
	}
	if busy {
		return fmt.Errorf("another native update is in progress")
	}
	defer release()
	markerPath := filepath.Join(m.baseDir, nativeMarkerName)
	if _, err := os.Lstat(markerPath); !os.IsNotExist(err) {
		return fmt.Errorf("another native update needs to finish before restarting")
	}
	m.mu.Lock()
	if m.applyLaunched {
		m.mu.Unlock()
		return fmt.Errorf("native update already in progress")
	}
	pending := m.state.PendingUpdate
	if pending == nil || pending.Build <= m.currentBuild || len(pending.NativeFiles) == 0 {
		m.mu.Unlock()
		return fmt.Errorf("no complete native update is staged")
	}
	stage, err := m.pendingUpdatePathLocked(pending)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	m.applyLaunched = true
	m.mu.Unlock()
	launched := false
	defer func() {
		if !launched {
			m.mu.Lock()
			m.applyLaunched = false
			m.mu.Unlock()
		}
	}()
	if err := validateNativeFiles(pending.NativeFiles); err != nil {
		return err
	}
	if err := nativeDirectory(stage); err != nil {
		return err
	}
	for _, file := range pending.NativeFiles {
		if err := verifyNativeFile(stage, file); err != nil {
			m.discardPendingUpdate(pending.Build, err)
			removeNativeStage(stage)
			return err
		}
	}
	token, err := randomToken()
	if err != nil {
		return err
	}
	transaction := nativeTransaction{SchemaVersion: 1, Build: pending.Build, Directory: m.baseDir,
		Stage: stage, StatePath: m.statePath, HealthPath: filepath.Join(m.updatesDir, "native-health-"+token), Token: token,
		Arguments: append([]string(nil), arguments...)}
	// Deterministic order: activate the shell last. Every target is replaced by
	// rename-over-existing, so the launch entry point is never temporarily absent.
	for _, name := range nativeNames {
		for _, file := range pending.NativeFiles {
			if file.Name != name {
				continue
			}
			digest, size, err := nativeHash(filepath.Join(m.baseDir, name), nativeLimit(name))
			if err != nil {
				return fmt.Errorf("inspect installed %s: %w", name, err)
			}
			transaction.Files = append(transaction.Files, nativeReplacement{New: file, Old: nativeFile{Name: name, Size: size, SHA256: digest}})
		}
	}
	transactionPath := filepath.Join(m.updatesDir, "native-apply-"+token+".json")
	if err := validateNativeTransaction(transactionPath, transaction); err != nil {
		return err
	}
	helperPath := filepath.Join(m.updatesDir, "TrueDown-native-updater-"+token+".exe")
	defer func() {
		if !launched {
			_ = os.Remove(helperPath)
			_ = os.Remove(transactionPath)
		}
	}()
	if err := copyExecutable(m.currentExe, helperPath); err != nil {
		return err
	}
	digest, _, err := nativeHash(helperPath, maxExecutableBytes)
	if err != nil {
		return err
	}
	if err := writeNativeJSON(transactionPath, transaction); err != nil {
		return err
	}
	marker := nativeMarker{1, transactionPath, helperPath, digest, token}
	// The installation mutex serializes profile writers; atomic persistence
	// keeps a crash during marker creation from publishing a partial journal.
	if _, err := os.Lstat(markerPath); !os.IsNotExist(err) {
		return fmt.Errorf("another native update needs to finish before restarting")
	}
	if err := writeNativeJSON(markerPath, marker); err != nil {
		return err
	}
	release()
	command := exec.Command(helperPath, nativeApplyArgument, transactionPath, "apply")
	configureNativeHelper(command)
	if err := command.Start(); err != nil {
		_ = os.Remove(markerPath)
		return fmt.Errorf("start native update helper: %w", err)
	}
	_ = command.Process.Release()
	launched = true
	return nil
}

func nativeDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("native update directories must be ordinary directories")
	}
	return nil
}

func validateNativeTransaction(path string, transaction nativeTransaction) error {
	if transaction.SchemaVersion != 1 || transaction.Build <= 0 || !validToken(transaction.Token) {
		return fmt.Errorf("invalid native update transaction")
	}
	for _, value := range []string{path, transaction.Directory, transaction.Stage, transaction.StatePath, transaction.HealthPath} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return fmt.Errorf("native update paths must be canonical and absolute")
		}
	}
	updates := filepath.Dir(path)
	if filepath.Base(path) != "native-apply-"+transaction.Token+".json" || filepath.Dir(transaction.Stage) != updates ||
		filepath.Dir(transaction.StatePath) != filepath.Dir(updates) || transaction.HealthPath != filepath.Join(updates, "native-health-"+transaction.Token) ||
		!strings.HasPrefix(filepath.Base(transaction.Stage), fmt.Sprintf("native-build-%d-", transaction.Build)) {
		return fmt.Errorf("native update paths escaped their managed location")
	}
	if filepath.Dir(transaction.Stage) == transaction.Directory || filepath.Base(transaction.StatePath) != "truedown.updates.json" {
		return fmt.Errorf("invalid native update state location")
	}
	if len(transaction.Arguments) != 3 || transaction.Arguments[0] != "--background" || transaction.Arguments[1] != "--data-dir" ||
		!filepath.IsAbs(transaction.Arguments[2]) || len(transaction.Arguments[2]) > 4096 || strings.ContainsRune(transaction.Arguments[2], 0) {
		return fmt.Errorf("native update restart requires one explicit profile")
	}
	old, next := []nativeFile{}, []nativeFile{}
	for index, file := range transaction.Files {
		if index >= len(nativeNames) || file.New.Name != nativeNames[index] || file.Old.Name != file.New.Name {
			return fmt.Errorf("invalid native replacement order")
		}
		old = append(old, file.Old)
		next = append(next, file.New)
	}
	if err := validateNativeFiles(old); err != nil {
		return err
	}
	return validateNativeFiles(next)
}

func writeNativeJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return safefile.WriteFile(path, append(data, '\n'), 0600)
}

func readNativeJSON(path string, value any) error {
	data, err := safefile.ReadFile(path, 64<<10)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return fmt.Errorf("native journal contains multiple values")
	} else if !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func nativeCandidate(transaction nativeTransaction, name string) string {
	return filepath.Join(transaction.Directory, name+".update-new")
}
func nativeBackup(transaction nativeTransaction, name string) string {
	return filepath.Join(transaction.Directory, name+".previous")
}

func prepareNativeFiles(transaction nativeTransaction) error {
	// All backups and candidates are complete and synchronized before the first
	// replacement. A crash during preparation can safely restart the old bundle.
	for _, file := range transaction.Files {
		if err := verifyNativeFile(transaction.Directory, file.Old); err != nil {
			return err
		}
		if err := verifyNativeFile(transaction.Stage, file.New); err != nil {
			return err
		}
		if err := copyVerifiedExecutable(filepath.Join(transaction.Directory, file.Old.Name), nativeBackup(transaction, file.Old.Name), file.Old.SHA256, file.Old.Size); err != nil {
			return err
		}
		if err := copyVerifiedExecutable(filepath.Join(transaction.Stage, file.New.Name), nativeCandidate(transaction, file.New.Name), file.New.SHA256, file.New.Size); err != nil {
			return err
		}
	}
	return nil
}

func replaceNativeFiles(transaction nativeTransaction) error {
	for _, file := range transaction.Files {
		if err := retryNativeReplace(nativeCandidate(transaction, file.New.Name), filepath.Join(transaction.Directory, file.New.Name), 45*time.Second); err != nil {
			return err
		}
	}
	return nil
}

func retryNativeReplace(source, target string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if err := os.Rename(source, target); err == nil {
			return nil
		} else if time.Now().After(deadline) {
			return fmt.Errorf("cannot replace %s after waiting for running processes to exit: %w", filepath.Base(target), err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func restoreNativeFiles(transaction nativeTransaction) error {
	// Keep the backups while restoring, so an interrupted rollback is retryable.
	for _, file := range transaction.Files {
		if verifyNativeFile(transaction.Directory, file.Old) == nil {
			continue
		}
		backup := nativeBackup(transaction, file.Old.Name)
		digest, size, err := nativeHash(backup, nativeLimit(file.Old.Name))
		if err != nil || digest != file.Old.SHA256 || size != file.Old.Size {
			return fmt.Errorf("rollback backup for %s is unavailable", file.Old.Name)
		}
		candidate := nativeCandidate(transaction, file.Old.Name)
		if err := copyVerifiedExecutable(backup, candidate, file.Old.SHA256, file.Old.Size); err != nil {
			return err
		}
		if err := retryNativeReplace(candidate, filepath.Join(transaction.Directory, file.Old.Name), 45*time.Second); err != nil {
			return err
		}
	}
	return nil
}

func runNativeTransaction(path string, recoverOnly bool) error {
	var transaction nativeTransaction
	if err := readNativeJSON(path, &transaction); err != nil {
		return err
	}
	if err := validateNativeTransaction(path, transaction); err != nil {
		return err
	}
	for _, directory := range []string{transaction.Directory, transaction.Stage, filepath.Dir(path)} {
		if err := nativeDirectory(directory); err != nil {
			return err
		}
	}
	release, busy, err := nativeUpdateLock(transaction.Directory)
	if err != nil || busy {
		return err
	}
	defer release()
	markerPath := filepath.Join(transaction.Directory, nativeMarkerName)
	var marker nativeMarker
	if err := readNativeJSON(markerPath, &marker); err != nil {
		return err
	}
	if marker.SchemaVersion != 1 || marker.Transaction != path || marker.Token != transaction.Token ||
		marker.Helper != filepath.Join(filepath.Dir(path), "TrueDown-native-updater-"+transaction.Token+".exe") || normalizeSHA256(marker.SHA256) != marker.SHA256 {
		return fmt.Errorf("native update marker does not match its transaction")
	}
	digest, _, err := nativeHash(marker.Helper, maxExecutableBytes)
	if err != nil || digest != marker.SHA256 {
		return fmt.Errorf("native update helper failed its SHA-256 check")
	}
	// A committed health token survives helper interruption. Verify all new
	// files before finalizing; otherwise recovery always restores the old set.
	healthy := healthTokenMatches(transaction.HealthPath, transaction.Token)
	if healthy {
		for _, file := range transaction.Files {
			if err := verifyNativeFile(transaction.Directory, file.New); err != nil {
				healthy = false
				break
			}
		}
	}
	var updateErr error
	if !recoverOnly && !healthy {
		updateErr = prepareNativeFiles(transaction)
		if updateErr == nil {
			updateErr = replaceNativeFiles(transaction)
		}
		if updateErr == nil {
			updateErr = launchAndAwaitHealth(transaction)
		}
		healthy = updateErr == nil
	}
	if !healthy {
		if err := restoreNativeFiles(transaction); err != nil {
			return fmt.Errorf("%v; native rollback: %w", updateErr, err)
		}
		if err := clearPendingUpdate(transaction.StatePath, transaction.Build, "native update did not finish its startup health check; restored the complete previous version"); err != nil {
			return err
		}
	}
	// Commit before launching the rollback process: its first startup must not
	// delegate back to this recovery helper. The new healthy process already
	// owns configuration persistence; the helper never overwrites its settings.
	if err := os.Remove(markerPath); err != nil {
		return err
	}
	for _, file := range transaction.Files {
		_ = os.Remove(nativeCandidate(transaction, file.New.Name))
	}
	removeNativeStage(transaction.Stage)
	_ = os.Remove(path)
	_ = os.Remove(transaction.HealthPath)
	if !healthy || recoverOnly {
		command := exec.Command(filepath.Join(transaction.Directory, "TrueDown.exe"), transaction.Arguments...)
		configureHiddenProcess(command)
		command.Env = withoutUpdateEnvironment(os.Environ())
		if err := command.Start(); err != nil {
			return err
		}
		_ = command.Process.Release()
	}
	return updateErr
}

func withoutUpdateEnvironment(env []string) []string {
	result := make([]string, 0, len(env))
	for _, value := range env {
		name := strings.SplitN(value, "=", 2)[0]
		if strings.EqualFold(name, updateHealthFileEnv) || strings.EqualFold(name, updateHealthTokenEnv) || strings.EqualFold(name, nativeBypassEnv) || strings.EqualFold(name, "TRUEDOWN_UPDATE_EXPECTED_BUILD") {
			continue
		}
		result = append(result, value)
	}
	return result
}
