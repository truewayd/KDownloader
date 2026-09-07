package downloader

import (
	"fmt"
	"os"
)

// CheckpointForProfileMigration runs only with the application's profile lock
// held and no live manager. Never copy a database with unapplied WAL contents.
func CheckpointForProfileMigration(path string) (result error) {
	before, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return fmt.Errorf("database must be a regular file")
	}
	db, err := openSQLite(path)
	if err != nil {
		return err
	}
	defer func() {
		if err := db.Close(); result == nil {
			result = err
		}
	}()
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, after) {
		return fmt.Errorf("database changed before checkpoint")
	}
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return err
	}
	rows, err := db.Query("PRAGMA wal_checkpoint(TRUNCATE)")
	if err != nil {
		return err
	}
	ready, err := rows.Next()
	busy := int64(1)
	if ready && err == nil {
		busy = rows.Int64(0)
	}
	rows.Close()
	if err != nil {
		return err
	}
	if busy != 0 {
		return fmt.Errorf("database is busy; stop every owner before migrating")
	}
	rows, err = db.Query("PRAGMA quick_check(1)")
	if err != nil {
		return err
	}
	defer rows.Close()
	ready, err = rows.Next()
	if err != nil {
		return err
	}
	if !ready || rows.Text(0) != "ok" {
		return fmt.Errorf("database integrity check failed")
	}
	return nil
}
