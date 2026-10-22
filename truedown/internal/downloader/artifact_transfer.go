package downloader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"truedown/internal/modulehost"
	"truedown/internal/safefile"
)

type artifactPlan struct {
	Executable, Source, Proxy string
	Data                      json.RawMessage
	Collection                *modulehost.ArtifactCollection
}
type artifactJournal struct {
	Schema   int                          `json:"schema"`
	Identity string                       `json:"identity"`
	Output   string                       `json:"output"`
	Verified *modulehost.VerifiedArtifact `json:"verified,omitempty"`
}
type artifactJob struct {
	task      *Task
	plan      artifactPlan
	directory string
	journal   artifactJournal
	phase     string
	paused    bool
	failure   error
	cancel    context.CancelFunc
	done      chan struct{}
}
type artifactTransfers struct {
	mu         sync.Mutex
	jobs       map[string]*artifactJob
	ctx        context.Context
	wg         sync.WaitGroup
	closed     bool
	slots      chan struct{}
	transports *collectionTransports
}

func newArtifactTransfers(ctx context.Context) *artifactTransfers {
	return &artifactTransfers{jobs: map[string]*artifactJob{}, ctx: ctx, slots: make(chan struct{}, 2)}
}

func artifactIdentity(task *Task) string {
	sum := sha256.Sum256([]byte(task.ModuleID + "\x00" + task.Link))
	var identity requestIdentity
	if json.Unmarshal([]byte(task.RequestJSON), &identity) == nil && (len(identity.ModuleData) > 0 || identity.Collection != nil) {
		data, _ := json.Marshal(struct {
			Data       json.RawMessage
			Collection *modulehost.ArtifactCollection
		}{identity.ModuleData, identity.Collection})
		sum = sha256.Sum256(append([]byte(task.ModuleID+"\x00"+task.Link+"\x00"), data...))
	}
	return hex.EncodeToString(sum[:])
}
func artifactDirectory(task *Task) string {
	return filepath.Join(task.Folder, fmt.Sprintf(".truedown-artifact-%d-%s", task.ID, artifactIdentity(task)[:16]))
}

func (a *artifactTransfers) prepare(task *Task, plan artifactPlan) (*Task, error) {
	directory := artifactDirectory(task)
	if err := modulehost.MakeDirectory(task.Folder); err != nil {
		return nil, err
	}
	journal := artifactJournal{Schema: 1, Identity: artifactIdentity(task), Output: filepath.Join(task.Folder, task.OutputName)}
	err := os.Mkdir(directory, 0700)
	if err != nil && !os.IsExist(err) {
		return nil, err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("invalid artifact staging directory")
	}
	journalPath := filepath.Join(directory, "state.json")
	if raw, readErr := safefile.ReadFile(journalPath, 16*1024); readErr == nil {
		var previous artifactJournal
		if modulehost.Decode(raw, &previous) != nil || previous.Schema != 1 || previous.Identity != journal.Identity || previous.Output != journal.Output {
			return nil, fmt.Errorf("artifact ownership mismatch")
		}
		journal = previous
	} else if os.IsNotExist(readErr) {
		entries, err := os.ReadDir(directory)
		if err != nil || len(entries) != 0 {
			return nil, fmt.Errorf("unowned artifact staging directory")
		}
		raw, _ := json.Marshal(journal)
		if err := safefile.WriteFile(journalPath, raw, 0600); err != nil {
			return nil, err
		}
	} else {
		return nil, readErr
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil, context.Canceled
	}
	for _, old := range a.jobs {
		if old.task.ID == task.ID && old.done != nil {
			return nil, fmt.Errorf("previous artifact writer is still active")
		}
	}
	for gid, old := range a.jobs {
		if old.task.ID == task.ID {
			delete(a.jobs, gid)
		}
	}
	job := &artifactJob{task: cloneTask(task), plan: plan, directory: directory, journal: journal, phase: "transport", paused: task.Status == StatusPaused}
	a.jobs[task.GID] = job
	transport := cloneTask(task)
	transport.Folder = directory
	transport.OutputName = "ciphertext"
	if _, _, err := inspectHTTPOutput(transport); err != nil {
		delete(a.jobs, task.GID)
		return nil, err
	}
	return transport, nil
}

func (a *artifactTransfers) filter(states []ariaStatus) []ariaStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := range states {
		state := &states[i]
		job := a.jobs[state.GID]
		if job == nil {
			continue
		}
		// Engine completion is only ciphertext completion.
		if state.Status == "complete" && job.phase == "transport" && !a.closed {
			if job.paused {
				job.phase = "paused"
			} else {
				a.startLocked(job)
			}
		}
		switch job.phase {
		case "transform":
			state.Status = "active"
			state.DownloadSpeed = "0"
			state.CompletedLength = state.TotalLength
		case "paused":
			state.Status = "paused"
			state.DownloadSpeed = "0"
		case "complete":
			state.Status = "complete"
			if job.journal.Verified != nil {
				state.TotalLength = strconv.FormatInt(job.journal.Verified.Size, 10)
				state.CompletedLength = state.TotalLength
			}
		case "error":
			state.Status = "error"
			state.ErrorCode = "module"
			if job.failure != nil && job.failure.Error() == "module: integrity" {
				state.ErrorCode = "8"
			}
			state.ErrorMessage = "Module verification or publication failed; retry to verify the staged file"
		}
		// Never expose the private ciphertext path as a task output.
		for j := range state.Files {
			state.Files[j].Path = job.journal.Output
		}
	}
	return states
}

func (a *artifactTransfers) startLocked(job *artifactJob) {
	ctx, cancel := context.WithCancel(a.ctx)
	job.cancel = cancel
	job.done = make(chan struct{})
	job.phase = "transform"
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		var err error
		select {
		case a.slots <- struct{}{}:
			err = a.transform(ctx, job)
			<-a.slots
		case <-ctx.Done():
			err = ctx.Err()
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		job.failure = err
		if job.phase == "transform" {
			if err != nil {
				job.phase = "error"
			} else {
				job.phase = "complete"
			}
		}
		close(job.done)
		job.done = nil
		job.cancel = nil
	}()
}

func artifactHash(path string, size int64) (string, error) {
	file, release, err := openArtifactFile(path)
	if err != nil {
		return "", err
	}
	defer release()
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		return "", fmt.Errorf("artifact length mismatch")
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, size+1))
	if err != nil || n != size {
		return "", fmt.Errorf("artifact read failed")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (a *artifactTransfers) transform(ctx context.Context, job *artifactJob) error {
	payload := filepath.Join(job.directory, "payload")
	// A journal committed before publication allows safe recovery of a crash
	// between publication and the manager's final SQLite status write.
	if verified := job.journal.Verified; verified != nil {
		// Link publication may have completed immediately before a crash.
		left, le := os.Lstat(payload)
		right, re := os.Lstat(job.journal.Output)
		if le == nil && re == nil && left.Mode().IsRegular() && right.Mode().IsRegular() && os.SameFile(left, right) {
			if err := os.Remove(payload); err != nil {
				return err
			}
		}
		if hash, err := artifactHash(job.journal.Output, verified.Size); err == nil && hash == verified.SHA256 {
			return nil
		}
	}
	if err := safefile.RemoveFile(payload); err != nil {
		return err
	}
	command := exec.Command(job.plan.Executable)
	command.Dir = job.directory
	client, err := modulehost.Connect(ctx, command, job.task.ModuleID)
	if err != nil {
		return err
	}
	var verified modulehost.VerifiedArtifact
	err = client.Call(ctx, "transform", map[string]any{"source": job.plan.Source, "size": job.task.TotalLength, "data": job.plan.Data, "collection": job.plan.Collection}, &verified)
	retireModule(client)
	if err != nil {
		return err
	}
	if verified.Size < 0 || (job.plan.Collection == nil && verified.Size != job.task.TotalLength) || (job.plan.Collection != nil && (verified.Size < job.task.TotalLength || verified.Size > job.task.TotalLength+64*1024*1024)) || len(verified.SHA256) != 64 {
		return fmt.Errorf("invalid verified artifact")
	}
	actual, err := artifactHash(payload, verified.Size)
	if err != nil || actual != verified.SHA256 {
		return fmt.Errorf("verified artifact was modified")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if ctx.Err() != nil || job.phase != "transform" {
		return context.Canceled
	}
	job.journal.Verified = &verified
	raw, _ := json.Marshal(job.journal)
	if err := safefile.WriteFile(filepath.Join(job.directory, "state.json"), raw, 0600); err != nil {
		return err
	}
	// Link is atomic and refuses an existing destination; no overwrite window.
	if err := os.Link(payload, job.journal.Output); err != nil {
		return err
	}
	if err := os.Remove(payload); err != nil {
		return err
	}
	return nil
}

// control returns true only when local verification owns the operation.
func (a *artifactTransfers) control(gid string, pause bool) (bool, error) {
	a.mu.Lock()
	job := a.jobs[gid]
	if job != nil {
		job.paused = pause
	}
	if job == nil || job.phase == "transport" || job.phase == "complete" || job.phase == "error" {
		a.mu.Unlock()
		return false, nil
	}
	if pause {
		job.phase = "paused"
		if job.cancel != nil {
			job.cancel()
		}
		done := job.done
		a.mu.Unlock()
		if done != nil {
			select {
			case <-done:
			case <-time.After(8 * time.Second):
				return true, fmt.Errorf("module writer did not stop")
			}
		}
		return true, nil
	}
	if job.done != nil {
		a.mu.Unlock()
		return true, fmt.Errorf("module writer is still stopping")
	}
	if job.phase == "paused" {
		a.startLocked(job)
	}
	a.mu.Unlock()
	return true, nil
}

func (a *artifactTransfers) close() {
	a.mu.Lock()
	a.closed = true
	for _, job := range a.jobs {
		if job.cancel != nil {
			job.cancel()
		}
	}
	a.mu.Unlock()
	a.wg.Wait()
}

func (a *artifactTransfers) transportTask(task *Task) *Task {
	a.mu.Lock()
	defer a.mu.Unlock()
	job := a.jobs[task.GID]
	if job == nil {
		return task
	}
	copy := cloneTask(task)
	copy.Folder = job.directory
	copy.OutputName = "ciphertext"
	return copy
}

func (a *artifactTransfers) progress(gid string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if job := a.jobs[gid]; job != nil && job.phase == "transform" {
		return "Verifying downloaded file (" + strconv.FormatInt(job.task.TotalLength, 10) + " bytes)"
	}
	return ""
}

func (a *artifactTransfers) retire(gid string) error {
	if a.transports != nil {
		if err := a.transports.retire(gid, true); err != nil {
			return err
		}
	}
	a.mu.Lock()
	job := a.jobs[gid]
	if job == nil {
		a.mu.Unlock()
		return nil
	}
	if job.cancel != nil {
		job.cancel()
	}
	if job.done != nil {
		job.phase = "paused"
	}
	done := job.done
	a.mu.Unlock()
	if done != nil {
		select {
		case <-done:
		case <-time.After(8 * time.Second):
			return fmt.Errorf("artifact writer did not retire")
		}
	}
	return nil
}

func (a *artifactTransfers) remove(task *Task) error {
	directory := artifactDirectory(task)
	raw, err := safefile.ReadFile(filepath.Join(directory, "state.json"), 16*1024)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var journal artifactJournal
	if modulehost.Decode(raw, &journal) != nil || journal.Identity != artifactIdentity(task) || journal.Output != filepath.Join(task.Folder, task.OutputName) {
		return fmt.Errorf("artifact ownership mismatch")
	}
	names := []string{"ciphertext", "ciphertext.aria2", "payload", "collection-progress.json", "state.json"}
	var identity requestIdentity
	if json.Unmarshal([]byte(task.RequestJSON), &identity) == nil && identity.Collection != nil {
		if _, err := modulehost.ValidateCollection(identity.Collection); err != nil {
			return err
		}
		for index, entry := range identity.Collection.Entries {
			if !entry.Directory {
				name := modulehost.CiphertextName(index)
				names = append(names, name, name+".aria2")
			}
		}
	}
	for _, name := range names {
		if err := safefile.RemoveFile(filepath.Join(directory, name)); err != nil {
			return err
		}
	}
	if err := os.Remove(directory); err != nil {
		return err
	}
	a.mu.Lock()
	for gid, job := range a.jobs {
		if job.task.ID == task.ID {
			delete(a.jobs, gid)
		}
	}
	a.mu.Unlock()
	return nil
}

func (m *Manager) isArtifactTask(task *Task) bool {
	if m.modules == nil {
		return false
	}
	_, ok := m.modules.module(task.ModuleID).(*executableResolver)
	return ok
}

func (a *artifactTransfers) completed(task *Task) {
	// Only the manager's successful durable completion authorizes reclamation.
	a.mu.Lock()
	job := a.jobs[task.GID]
	if job == nil || job.phase != "complete" {
		a.mu.Unlock()
		return
	}
	directory := job.directory
	a.mu.Unlock()
	names := []string{"ciphertext", "ciphertext.aria2", "collection-progress.json"}
	if job.plan.Collection != nil {
		for index, entry := range job.plan.Collection.Entries {
			if !entry.Directory {
				name := modulehost.CiphertextName(index)
				names = append(names, name, name+".aria2")
			}
		}
	}
	for _, name := range names {
		if err := safefile.RemoveFile(filepath.Join(directory, name)); err != nil {
			return
		}
	}
	a.mu.Lock()
	delete(a.jobs, task.GID)
	a.mu.Unlock()
	if a.transports != nil {
		a.transports.forget(task.GID)
	}
}
