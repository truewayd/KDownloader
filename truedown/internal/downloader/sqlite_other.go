//go:build !windows

package downloader

import (
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
	"sync"

	_ "modernc.org/sqlite"
)

// sqliteConn mirrors the small serialized interface used by the Windows
// winsqlite3 binding. One database/sql connection is retained so explicit
// BEGIN/COMMIT sequences cannot migrate between physical connections.
type sqliteConn struct {
	mu sync.Mutex
	db *sql.DB
}

type sqliteRows struct {
	conn   *sqliteConn
	rows   *sql.Rows
	values []any
	inputs []any
	closed bool
}

func openSQLite(path string) (*sqliteConn, error) {
	dsn := (&url.URL{Scheme: "file", Path: path}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite open: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("sqlite open: %w", err)
	}
	return &sqliteConn{db: db}, nil
}

func (c *sqliteConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db == nil {
		return nil
	}
	err := c.db.Close()
	c.db = nil
	return err
}

func (c *sqliteConn) Exec(query string, args ...any) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db == nil {
		return 0, fmt.Errorf("sqlite connection is closed")
	}
	if err := validateSQLiteArgs(args); err != nil {
		return 0, err
	}
	result, err := c.db.Exec(query, args...)
	if err != nil {
		return 0, fmt.Errorf("sqlite exec: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("sqlite last insert id: %w", err)
	}
	return id, nil
}

func (c *sqliteConn) Query(query string, args ...any) (*sqliteRows, error) {
	c.mu.Lock()
	if c.db == nil {
		c.mu.Unlock()
		return nil, fmt.Errorf("sqlite connection is closed")
	}
	if err := validateSQLiteArgs(args); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	rows, err := c.db.Query(query, args...)
	if err != nil {
		c.mu.Unlock()
		return nil, fmt.Errorf("sqlite query: %w", err)
	}
	columns, err := rows.Columns()
	if err != nil {
		_ = rows.Close()
		c.mu.Unlock()
		return nil, fmt.Errorf("sqlite columns: %w", err)
	}
	result := &sqliteRows{conn: c, rows: rows, values: make([]any, len(columns)), inputs: make([]any, len(columns))}
	for index := range result.values {
		result.inputs[index] = &result.values[index]
	}
	return result, nil
}

func validateSQLiteArgs(args []any) error {
	for _, value := range args {
		switch value.(type) {
		case nil, string, int, int64:
		default:
			return fmt.Errorf("unsupported sqlite argument %T", value)
		}
	}
	return nil
}

func (r *sqliteRows) Next() (bool, error) {
	if r == nil || r.closed || r.rows == nil {
		return false, nil
	}
	if !r.rows.Next() {
		return false, r.rows.Err()
	}
	if err := r.rows.Scan(r.inputs...); err != nil {
		return false, fmt.Errorf("sqlite scan: %w", err)
	}
	return true, nil
}

func (r *sqliteRows) Text(column int) string {
	if column < 0 || column >= len(r.values) || r.values[column] == nil {
		return ""
	}
	switch value := r.values[column].(type) {
	case string:
		return value
	case []byte:
		return string(value)
	default:
		return fmt.Sprint(value)
	}
}

func (r *sqliteRows) Int64(column int) int64 {
	if column < 0 || column >= len(r.values) || r.values[column] == nil {
		return 0
	}
	switch value := r.values[column].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case string:
		parsed, _ := strconv.ParseInt(value, 10, 64)
		return parsed
	case []byte:
		parsed, _ := strconv.ParseInt(string(value), 10, 64)
		return parsed
	default:
		return 0
	}
}

func (r *sqliteRows) IsNull(column int) bool {
	return column < 0 || column >= len(r.values) || r.values[column] == nil
}

func (r *sqliteRows) Close() {
	if r == nil || r.closed {
		return
	}
	r.closed = true
	if r.rows != nil {
		_ = r.rows.Close()
		r.rows = nil
	}
	r.values = nil
	r.inputs = nil
	r.conn.mu.Unlock()
}
