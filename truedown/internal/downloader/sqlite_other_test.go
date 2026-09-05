//go:build !windows

package downloader

import (
	"path/filepath"
	"testing"
)

func TestSQLiteScanMultipleRows(t *testing.T) {
	db, err := openSQLite(filepath.Join(t.TempDir(), "scan.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT 1, 'first', NULL UNION ALL SELECT 2, 'second', 'value'")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for index, expected := range []string{"first", "second"} {
		if more, err := rows.Next(); err != nil || !more {
			t.Fatalf("row %d: more=%v err=%v", index, more, err)
		}
		if rows.Int64(0) != int64(index+1) || rows.Text(1) != expected || rows.IsNull(2) != (index == 0) {
			t.Fatalf("row %d was not scanned correctly", index)
		}
	}
	if more, err := rows.Next(); err != nil || more {
		t.Fatalf("end of query: more=%v err=%v", more, err)
	}
	rows.Close()
	rows.Close()
	if more, err := rows.Next(); err != nil || more {
		t.Fatalf("closed query: more=%v err=%v", more, err)
	}
	if _, err := db.Exec("CREATE TABLE after_close (id INTEGER)"); err != nil {
		t.Fatalf("closed rows retained the connection: %v", err)
	}
}

func BenchmarkSQLiteScan10000Rows(b *testing.B) {
	db, err := openSQLite(filepath.Join(b.TempDir(), "scan.db"))
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		rows, err := db.Query(`WITH RECURSIVE records(id) AS (
			SELECT 1 UNION ALL SELECT id+1 FROM records WHERE id < 10000
		) SELECT id, 'filename', NULL FROM records`)
		if err != nil {
			b.Fatal(err)
		}
		count := 0
		for {
			more, err := rows.Next()
			if err != nil {
				rows.Close()
				b.Fatal(err)
			}
			if !more {
				break
			}
			count++
		}
		rows.Close()
		if count != 10000 {
			b.Fatalf("read %d rows", count)
		}
	}
}
