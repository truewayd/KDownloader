package downloader

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type recordStore struct {
	db *sqliteConn
	mu sync.Mutex
}

func openRecordStore(path string) (*recordStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	db, err := openSQLite(path)
	if err != nil {
		return nil, err
	}
	s := &recordStore{db: db}
	statements := []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA synchronous=NORMAL`,
		`PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS download_records (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			fingerprint TEXT NOT NULL UNIQUE,
			request_json TEXT NOT NULL,
			name TEXT NOT NULL,
			link TEXT NOT NULL,
			folder TEXT NOT NULL,
			queue_id INTEGER NOT NULL,
			headers_json TEXT NOT NULL,
			download_page TEXT NOT NULL,
			opts_json TEXT NOT NULL,
			output_name TEXT NOT NULL,
			gid TEXT NOT NULL,
			status TEXT NOT NULL,
			progress TEXT NOT NULL,
			error TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_download_records_status ON download_records(status)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("initialize download database: %w", err)
		}
	}
	if err := migrateRecordStore(db); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func migrateRecordStore(db *sqliteConn) error {
	rows, err := db.Query(`PRAGMA table_info(download_records)`)
	if err != nil {
		return fmt.Errorf("inspect download database: %w", err)
	}
	hasRevision := false
	for {
		hasRow, nextErr := rows.Next()
		if nextErr != nil {
			rows.Close()
			return fmt.Errorf("inspect download database: %w", nextErr)
		}
		if !hasRow {
			break
		}
		if rows.Text(1) == "revision" {
			hasRevision = true
		}
	}
	rows.Close()
	if !hasRevision {
		if _, err := db.Exec(`ALTER TABLE download_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("upgrade download database: %w", err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version=2`); err != nil {
		return fmt.Errorf("record download database version: %w", err)
	}
	return nil
}

func (s *recordStore) Close() error { return s.db.Close() }

func (s *recordStore) InsertBatch(tasks []*Task) error {
	if len(tasks) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`BEGIN IMMEDIATE`); err != nil {
		return err
	}
	for _, task := range tasks {
		if err := s.insert(task); err != nil {
			_, _ = s.db.Exec(`ROLLBACK`)
			return err
		}
	}
	if _, err := s.db.Exec(`COMMIT`); err != nil {
		_, _ = s.db.Exec(`ROLLBACK`)
		return err
	}
	return nil
}

func (s *recordStore) insert(t *Task) error {
	headers, err := json.Marshal(t.Headers)
	if err != nil {
		return err
	}
	opts, err := json.Marshal(t.Opts)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO download_records (
		id, fingerprint, request_json, name, link, folder, queue_id, headers_json,
		download_page, opts_json, output_name, gid, status, progress, error,
		created_at, updated_at, revision
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.Fingerprint, t.RequestJSON, t.Name, t.Link, t.Folder, t.QueueID,
		string(headers), t.DownloadPage, string(opts), t.OutputName, t.GID,
		string(t.Status), t.Progress, t.Error, formatDBTime(t.CreatedAt), formatDBTime(t.UpdatedAt), t.Revision,
	)
	return err
}

func (s *recordStore) Update(t *Task) error {
	return s.UpdateBatch([]*Task{t})
}

func (s *recordStore) UpdateBatch(tasks []*Task) error {
	if len(tasks) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`BEGIN IMMEDIATE`); err != nil {
		return err
	}
	for _, t := range tasks {
		if _, err := s.db.Exec(`UPDATE download_records SET
			name=?, output_name=?, gid=?, status=?, progress=?, error=?, updated_at=?, revision=?
			WHERE id=? AND revision<=?`,
			t.Name, t.OutputName, t.GID, string(t.Status), t.Progress, t.Error,
			formatDBTime(t.UpdatedAt), t.Revision, t.ID, t.Revision,
		); err != nil {
			_, _ = s.db.Exec(`ROLLBACK`)
			return err
		}
	}
	if _, err := s.db.Exec(`COMMIT`); err != nil {
		_, _ = s.db.Exec(`ROLLBACK`)
		return err
	}
	return nil
}

func (s *recordStore) Delete(id int64) error {
	return s.DeleteBatch([]int64{id})
}

func (s *recordStore) DeleteBatch(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`BEGIN IMMEDIATE`); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.db.Exec(`DELETE FROM download_records WHERE id=?`, id); err != nil {
			_, _ = s.db.Exec(`ROLLBACK`)
			return err
		}
	}
	if _, err := s.db.Exec(`COMMIT`); err != nil {
		_, _ = s.db.Exec(`ROLLBACK`)
		return err
	}
	return nil
}

func (s *recordStore) ClearDone() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM download_records WHERE status=?`, string(StatusDone))
	return err
}

func (s *recordStore) LoadAll() ([]*Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT
		id, fingerprint, request_json, name, link, folder, queue_id, headers_json,
		download_page, opts_json, output_name, gid, status, progress, error,
		created_at, updated_at, revision
		FROM download_records ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tasks []*Task
	for {
		hasRow, err := rows.Next()
		if err != nil {
			return nil, err
		}
		if !hasRow {
			break
		}
		t := &Task{
			ID:           rows.Int64(0),
			Fingerprint:  rows.Text(1),
			RequestJSON:  rows.Text(2),
			Name:         rows.Text(3),
			Link:         rows.Text(4),
			Folder:       rows.Text(5),
			QueueID:      int(rows.Int64(6)),
			DownloadPage: rows.Text(8),
			OutputName:   rows.Text(10),
			GID:          rows.Text(11),
			Status:       Status(rows.Text(12)),
			Progress:     rows.Text(13),
			Error:        rows.Text(14),
			CreatedAt:    parseDBTime(rows.Text(15)),
			UpdatedAt:    parseDBTime(rows.Text(16)),
			Revision:     rows.Int64(17),
		}
		if err := json.Unmarshal([]byte(rows.Text(7)), &t.Headers); err != nil {
			return nil, fmt.Errorf("decode headers for task %d: %w", t.ID, err)
		}
		if err := json.Unmarshal([]byte(rows.Text(9)), &t.Opts); err != nil {
			return nil, fmt.Errorf("decode options for task %d: %w", t.ID, err)
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}

func formatDBTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func parseDBTime(value string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Now()
	}
	return t
}
