package downloader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

const maxBrowserImportBytes = 1024 * 1024
const maxPendingBrowserImports = 64
const maxPendingBrowserImportBytes = 16 * maxBrowserImportBytes

var ErrBrowserImportBusy = errors.New("browser import queue is full or stopping")

// BrowserImportItem contains private credentials; it is never a task snapshot.
type BrowserImportItem struct {
	Link         string            `json:"link"`
	Name         string            `json:"name"`
	Headers      map[string]string `json:"headers"`
	DownloadPage string            `json:"downloadPage"`
	Media        *MediaOptions     `json:"media,omitempty"`
}

type browserImportRequest struct {
	Items  []BrowserImportItem `json:"items"`
	Paused bool                `json:"paused"`
}

type browserImport struct {
	id      int64
	next    int
	request browserImportRequest
}

// AcceptBrowserImport acknowledges only a committed inbox entry. Resolution
// belongs to the manager lifetime, not the extension's 500 ms HTTP request.
func (m *Manager) AcceptBrowserImport(ctx context.Context, items []BrowserImportItem, paused bool) error {
	if len(items) == 0 || len(items) > 256 {
		return &ValidationError{Message: "browser imports require 1 to 256 items"}
	}
	for _, item := range items {
		opts := Aria2Opts{Media: item.Media}
		if err := m.validateEngineOptions(opts); err != nil {
			return err
		}
		identity := normalizeRequest(item.Link, item.Name, "", m.defaultDir, item.Headers, item.DownloadPage, 0, opts)
		if err := validateRequest(identity); err != nil {
			return err
		}
	}
	data, err := json.Marshal(browserImportRequest{Items: items, Paused: paused})
	if err != nil {
		return err
	}
	if len(data) > maxBrowserImportBytes {
		return &ValidationError{Message: "browser import exceeds 1 MiB"}
	}
	m.importMu.Lock()
	defer m.importMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if m.lifecycleCtx.Err() != nil {
		return ErrBrowserImportBusy
	}
	if err := m.store.enqueueBrowserImport(data); err != nil {
		return err
	}
	m.wakeBrowserImports()
	return nil
}

func (m *Manager) wakeBrowserImports() {
	select {
	case m.importWake <- struct{}{}:
	default:
	}
}

func (m *Manager) browserImportWorker() {
	defer m.wg.Done()
	for {
		select {
		case <-m.done:
			return
		case <-m.importWake:
		}
		for m.lifecycleCtx.Err() == nil {
			entry, err := m.store.nextBrowserImport()
			if err == nil && entry == nil {
				break
			}
			if err == nil {
				err = m.processBrowserImport(entry)
			}
			if err != nil && m.lifecycleCtx.Err() == nil {
				// Never log serialized requests, URLs or resolver credentials.
				log.Printf("browser import persistence unavailable; retaining accepted request")
				select {
				case <-m.done:
					return
				case <-time.After(time.Second):
				}
			}
		}
	}
}

func (m *Manager) processBrowserImport(entry *browserImport) error {
	for index := entry.next; index < len(entry.request.Items); index++ {
		if err := m.lifecycleCtx.Err(); err != nil {
			return err
		}
		item := entry.request.Items[index]
		ctx, cancel := context.WithTimeout(m.lifecycleCtx, 6*time.Minute)
		opts := Aria2Opts{startPaused: entry.request.Paused, preserveExisting: true, Media: item.Media}
		result, handled, err := m.AddWithModules(ctx, item.Link, item.Name, "", item.Headers, item.DownloadPage, 0, opts, nil)
		if err == nil && !handled {
			var task *Task
			task, _, err = m.AddTask(item.Link, item.Name, "", item.Headers, item.DownloadPage, 0, opts)
			if task != nil {
				result.Tasks = []*Task{task}
			}
		}
		if m.lifecycleCtx.Err() != nil {
			cancel()
			return m.lifecycleCtx.Err()
		}
		if err != nil {
			if !handled {
				m.recordModuleIssue("")
			}
			log.Printf("browser import %d item %d failed; see download issue notification", entry.id, index+1)
		}
		if len(result.Tasks) > 0 {
			// Admissions use their normal writer. Do not retire the inbox source
			// until every resulting task has reached the record store.
			for {
				m.opMu.Lock()
				// A user's removal settles that output too; do not wait for or
				// recreate a task that has deliberately left the manager.
				var current []*Task
				m.mu.RLock()
				for _, task := range result.Tasks {
					if task != nil && m.tasks[task.ID] != nil {
						current = append(current, task)
					}
				}
				m.mu.RUnlock()
				persisted, persistErr := m.store.browserImportTasksPersisted(current)
				m.opMu.Unlock()
				if persistErr != nil {
					cancel()
					return persistErr
				}
				if persisted {
					break
				}
				select {
				case <-ctx.Done():
					cancel()
					return ctx.Err()
				case <-time.After(10 * time.Millisecond):
				}
			}
		}
		cancel()
		if err := m.lifecycleCtx.Err(); err != nil {
			return err
		}
		if err := m.store.advanceBrowserImport(entry.id, index+1, index+1 == len(entry.request.Items)); err != nil {
			return err
		}
	}
	return nil
}

func (s *recordStore) enqueueBrowserImport(data []byte) error {
	digest := sha256.Sum256(data)
	fingerprint := hex.EncodeToString(digest[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT id FROM browser_imports WHERE fingerprint=?`, fingerprint)
	if err != nil {
		return err
	}
	duplicate, err := rows.Next()
	rows.Close()
	if err != nil || duplicate {
		return err
	}
	rows, err = s.db.Query(`SELECT COUNT(*), COALESCE(SUM(length(CAST(request_json AS BLOB))),0) FROM browser_imports`)
	if err != nil {
		return err
	}
	ok, err := rows.Next()
	if err != nil || !ok {
		rows.Close()
		return fmt.Errorf("read browser import capacity: %v", err)
	}
	count, size := rows.Int64(0), rows.Int64(1)
	rows.Close()
	if count >= maxPendingBrowserImports || size+int64(len(data)) > maxPendingBrowserImportBytes {
		return ErrBrowserImportBusy
	}
	// Only the browser acknowledgement needs a synchronous WAL commit.
	if _, err := s.db.Exec(`PRAGMA synchronous=FULL`); err != nil {
		return err
	}
	defer s.db.Exec(`PRAGMA synchronous=NORMAL`)
	_, err = s.db.Exec(`INSERT INTO browser_imports(fingerprint,request_json) VALUES(?,?)`, fingerprint, string(data))
	return err
}

func (s *recordStore) nextBrowserImport() (*browserImport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT id,next_item,request_json FROM browser_imports ORDER BY id LIMIT 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ok, err := rows.Next()
	if err != nil || !ok {
		return nil, err
	}
	entry := &browserImport{id: rows.Int64(0), next: int(rows.Int64(1))}
	data := rows.Text(2)
	if len(data) > maxBrowserImportBytes {
		return nil, fmt.Errorf("browser import exceeds size limit")
	}
	if err := json.Unmarshal([]byte(data), &entry.request); err != nil {
		return nil, err
	}
	if len(entry.request.Items) == 0 || len(entry.request.Items) > 256 || entry.next < 0 || entry.next >= len(entry.request.Items) {
		return nil, fmt.Errorf("invalid browser import cursor")
	}
	return entry, nil
}

func (s *recordStore) advanceBrowserImport(id int64, next int, finished bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if finished {
		// Erase source credentials once all items have settled.
		_, err := s.db.Exec(`DELETE FROM browser_imports WHERE id=?`, id)
		return err
	}
	_, err := s.db.Exec(`UPDATE browser_imports SET next_item=? WHERE id=?`, next, id)
	return err
}

func (s *recordStore) browserImportTasksPersisted(tasks []*Task) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	unique := make([]*Task, 0, len(tasks))
	seen := make(map[int64]bool)
	for _, task := range tasks {
		if task != nil && !seen[task.ID] {
			seen[task.ID] = true
			unique = append(unique, task)
		}
	}
	tasks = unique
	for len(tasks) > 0 {
		count := min(len(tasks), 256)
		args := make([]any, count)
		for i, task := range tasks[:count] {
			args[i] = task.ID
		}
		rows, err := s.db.Query(`SELECT COUNT(*) FROM download_records WHERE id IN (`+strings.TrimSuffix(strings.Repeat("?,", count), ",")+`)`, args...)
		if err != nil {
			return false, err
		}
		ok, err := rows.Next()
		persisted := ok && rows.Int64(0) == int64(count)
		rows.Close()
		if err != nil || !persisted {
			return false, err
		}
		tasks = tasks[count:]
	}
	return true, nil
}
