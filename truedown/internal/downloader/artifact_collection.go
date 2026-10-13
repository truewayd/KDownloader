package downloader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"truedown/internal/modulehost"
)

// A ZIP occupies one manager admission and at most one native aria2 transfer.
// The module only resolves metadata and transforms files already on disk.
type collectionTransports struct {
	mu        sync.Mutex
	ctx       context.Context
	rpc       *ariaClient
	artifacts *artifactTransfers
	jobs      map[string]*collectionTransport
	children  map[string]bool
	wg        sync.WaitGroup
	closed    bool
}

type collectionTransport struct {
	mu        sync.Mutex
	task      *Task
	plan      artifactPlan
	directory string
	options   map[string]any
	state     ariaStatus
	finished  int64
	paused    bool
	child     string
	cancel    context.CancelFunc
	done      chan struct{}
}

func newCollectionTransports(ctx context.Context, rpc *ariaClient, artifacts *artifactTransfers) *collectionTransports {
	return &collectionTransports{ctx: ctx, rpc: rpc, artifacts: artifacts, jobs: map[string]*collectionTransport{}, children: map[string]bool{}}
}

func (c *collectionTransports) job(gid string) *collectionTransport {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.jobs[gid]
}

func (c *collectionTransports) add(task *Task, options map[string]any) (bool, error) {
	c.artifacts.mu.Lock()
	artifact := c.artifacts.jobs[task.GID]
	if artifact == nil || artifact.plan.Collection == nil {
		c.artifacts.mu.Unlock()
		return false, nil
	}
	job := &collectionTransport{task: cloneTask(artifact.task), plan: artifact.plan, directory: artifact.directory, options: map[string]any{}, paused: artifact.paused, done: make(chan struct{})}
	verified := artifact.journal.Verified != nil
	c.artifacts.mu.Unlock()
	for key, value := range options {
		job.options[key] = value
	}
	job.state = ariaStatus{GID: task.GID, Status: "waiting", TotalLength: strconv.FormatInt(job.task.TotalLength, 10), CompletedLength: "0", DownloadSpeed: "0"}
	if job.paused {
		job.state.Status = "paused"
	}
	ctx, cancel := context.WithCancel(c.ctx)
	job.cancel = cancel
	c.mu.Lock()
	if c.closed || c.jobs[task.GID] != nil {
		c.mu.Unlock()
		cancel()
		return true, fmt.Errorf("collection transport already exists or stopped")
	}
	c.jobs[task.GID] = job
	c.wg.Add(1)
	c.mu.Unlock()
	go func() {
		defer c.wg.Done()
		defer close(job.done)
		var err error
		if !verified {
			err = c.run(ctx, job)
		}
		job.mu.Lock()
		defer job.mu.Unlock()
		job.state.DownloadSpeed = "0"
		if job.state.Status == "removed" {
			return
		}
		if err != nil {
			job.state.Status, job.state.ErrorCode, job.state.ErrorMessage = "error", "module", "MEGA folder transport failed; retry to resume or check the public share"
		} else {
			job.state.Status = "complete"
			job.state.CompletedLength = job.state.TotalLength
		}
	}()
	return true, nil
}

func (c *collectionTransports) run(ctx context.Context, job *collectionTransport) error {
	client, err := modulehost.Connect(ctx, exec.Command(job.plan.Executable), job.task.ModuleID)
	if err != nil {
		return err
	}
	defer retireModule(client)
	for index, entry := range job.plan.Collection.Entries {
		if entry.Directory {
			continue
		}
		for {
			if err := job.wait(ctx); err != nil {
				return err
			}
			var prepared modulehost.PreparedArtifact
			callCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
			err := client.Call(callCtx, "prepare", map[string]any{"source": entry.Source, "data": entry.Data, "proxy": job.plan.Proxy}, &prepared)
			cancel()
			if err != nil {
				return err
			}
			if prepared.Size != entry.Size || prepared.Name != entry.Path[len(entry.Path)-1] || validateDownloadURL(prepared.URL) != nil {
				return fmt.Errorf("collection member metadata changed")
			}
			child := cloneTask(job.task)
			child.Folder, child.OutputName, child.Link = job.directory, modulehost.CiphertextName(index), prepared.URL
			digest := sha256.Sum256([]byte(job.task.GID + ":" + strconv.Itoa(index)))
			child.GID = hex.EncodeToString(digest[:8])
			outputExists, controlExists, err := inspectHTTPOutput(child)
			if err != nil {
				return err
			}
			options := map[string]any{}
			job.mu.Lock()
			for key, value := range job.options {
				options[key] = value
			}
			job.mu.Unlock()
			options["dir"], options["out"], options["gid"], options["pause"] = child.Folder, child.OutputName, child.GID, "true"
			if err := applyDownloadProxy(options, child.Link, child.Opts); err != nil {
				return err
			}
			if job.plan.Proxy != "" && child.Opts.ProxyMode == "" {
				options["https-proxy"] = job.plan.Proxy
			}
			job.mu.Lock()
			if ctx.Err() != nil {
				job.mu.Unlock()
				return ctx.Err()
			}
			if job.paused {
				job.mu.Unlock()
				continue
			}
			if outputExists && !controlExists {
				info, err := os.Lstat(filepath.Join(child.Folder, child.OutputName))
				if err != nil || !info.Mode().IsRegular() {
					job.mu.Unlock()
					return fmt.Errorf("collection member output changed")
				}
				if info.Size() == entry.Size {
					// The private journal binds this completed ciphertext to the
					// immutable collection. NEXT refuses re-admitting an existing
					// file without a control file. Reuse it; every member still
					// passes module MAC verification before ZIP publication.
					job.mu.Unlock()
					break
				}
			}
			if entry.Size == 0 {
				file, err := os.OpenFile(filepath.Join(child.Folder, child.OutputName), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if err == nil {
					err = file.Close()
				} else if os.IsExist(err) {
					info, statErr := os.Lstat(filepath.Join(child.Folder, child.OutputName))
					if statErr == nil && info.Mode().IsRegular() && info.Size() == 0 {
						err = nil
					}
				}
				job.mu.Unlock()
				if err != nil {
					return err
				}
				break
			}
			c.mu.Lock()
			c.children[child.GID] = true
			c.mu.Unlock()
			if err := c.rpc.nativeAddURI(child, options); err != nil {
				job.mu.Unlock()
				return err
			}
			job.child = child.GID
			if err := c.rpc.nativeUnpause(child.GID); err != nil {
				job.mu.Unlock()
				return err
			}
			job.state.Status = "active"
			job.mu.Unlock()
			for {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				state, err := c.rpc.nativeStatus(child.GID)
				if err != nil {
					return err
				}
				job.mu.Lock()
				job.state.CompletedLength = strconv.FormatInt(job.finished+min(entry.Size, transferNumber(state.CompletedLength)), 10)
				job.state.DownloadSpeed, job.state.Connections = state.DownloadSpeed, state.Connections
				if job.paused {
					job.state.Status = "paused"
					job.state.DownloadSpeed = "0"
				} else {
					job.state.Status = state.Status
					if state.Status == "complete" {
						job.state.Status = "active"
					}
				}
				job.mu.Unlock()
				if state.Status == "complete" {
					break
				}
				if state.Status == "error" || state.Status == "removed" {
					return fmt.Errorf("aria2 member transfer failed")
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(250 * time.Millisecond):
				}
			}
			job.mu.Lock()
			job.child = ""
			job.mu.Unlock()
			if err := c.rpc.nativeRemoveResult(child.GID); err != nil && !isGIDNotFound(err) {
				return err
			}
			break
		}
		job.mu.Lock()
		job.finished += entry.Size
		job.state.CompletedLength = strconv.FormatInt(job.finished, 10)
		job.mu.Unlock()
	}
	return nil
}

func (job *collectionTransport) wait(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		job.mu.Lock()
		paused := job.paused
		job.mu.Unlock()
		if !paused {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (c *collectionTransports) state(gid string) (ariaStatus, bool) {
	job := c.job(gid)
	if job == nil {
		return ariaStatus{}, false
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	return job.state, true
}

func (c *collectionTransports) merge(states []ariaStatus) []ariaStatus {
	c.mu.Lock()
	jobs := make([]*collectionTransport, 0, len(c.jobs))
	result := make([]ariaStatus, 0, len(states)+len(c.jobs))
	for _, state := range states {
		if !c.children[state.GID] {
			result = append(result, state)
		}
	}
	for _, job := range c.jobs {
		jobs = append(jobs, job)
	}
	c.mu.Unlock()
	for _, job := range jobs {
		job.mu.Lock()
		if job.state.Status != "removed" {
			result = append(result, job.state)
		}
		job.mu.Unlock()
	}
	return result
}

func (c *collectionTransports) control(gid string, pause bool) (bool, error) {
	job := c.job(gid)
	if job == nil {
		return false, nil
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.child != "" {
		var err error
		if pause {
			err = c.rpc.nativePause(job.child)
		} else {
			err = c.rpc.nativeUnpause(job.child)
		}
		if err != nil {
			state, readErr := c.rpc.nativeStatus(job.child)
			if readErr != nil || state.Status != "complete" {
				return true, err
			}
		}
	}
	job.paused = pause
	if job.state.Status != "complete" && job.state.Status != "error" && job.state.Status != "removed" {
		if pause {
			job.state.Status = "paused"
			job.state.DownloadSpeed = "0"
		} else {
			job.state.Status = "waiting"
		}
	}
	return true, nil
}

func (c *collectionTransports) controlAll(pause bool) error {
	c.mu.Lock()
	gids := make([]string, 0, len(c.jobs))
	for gid := range c.jobs {
		gids = append(gids, gid)
	}
	c.mu.Unlock()
	for _, gid := range gids {
		if _, err := c.control(gid, pause); err != nil {
			return err
		}
	}
	return nil
}

func (c *collectionTransports) retire(gid string, remove bool) error {
	job := c.job(gid)
	if job == nil {
		return nil
	}
	job.mu.Lock()
	job.cancel()
	child := job.child
	if remove {
		job.state.Status = "removed"
	}
	job.mu.Unlock()
	if remove && child != "" {
		if err := c.rpc.nativeForceRemove(child); err != nil && !isGIDNotFound(err) {
			state, readErr := c.rpc.nativeStatus(child)
			if readErr != nil || (state.Status != "complete" && state.Status != "error" && state.Status != "removed") {
				return err
			}
		}
		deadline := time.Now().Add(8 * time.Second)
		for {
			state, err := c.rpc.nativeStatus(child)
			if isGIDNotFound(err) || (err == nil && state.Status != "active" && state.Status != "waiting" && state.Status != "paused") {
				break
			}
			if err != nil {
				return err
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("collection transport did not stop")
			}
			time.Sleep(25 * time.Millisecond)
		}
		if err := c.rpc.nativeRemoveResult(child); err != nil && !isGIDNotFound(err) {
			return err
		}
	}
	select {
	case <-job.done:
		return nil
	case <-time.After(10 * time.Second):
		return fmt.Errorf("collection worker did not stop")
	}
}

func (c *collectionTransports) forget(gid string) {
	job := c.job(gid)
	if job == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.jobs, gid)
	for index, entry := range job.plan.Collection.Entries {
		if !entry.Directory {
			digest := sha256.Sum256([]byte(gid + ":" + strconv.Itoa(index)))
			delete(c.children, hex.EncodeToString(digest[:8]))
		}
	}
}

func (c *collectionTransports) close() {
	c.mu.Lock()
	c.closed = true
	jobs := make([]*collectionTransport, 0, len(c.jobs))
	for _, job := range c.jobs {
		jobs = append(jobs, job)
	}
	c.mu.Unlock()
	for _, job := range jobs {
		job.cancel()
	}
	c.wg.Wait()
}
