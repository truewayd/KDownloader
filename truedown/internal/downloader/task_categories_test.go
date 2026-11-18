package downloader

import (
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestCategoryPagesPreserveGlobalOrderAndPagination(t *testing.T) {
	m := benchmarkPageManager(245)
	for _, id := range m.orderedIDs {
		task := m.tasks[id]
		task.Name = fmt.Sprintf("file-%02d.png", id%7)
		task.Link = fmt.Sprintf("https://example.test/%02d", id%11)
		task.Progress = fmt.Sprintf("%d%%", id%100)
		if id%3 == 0 {
			task.Name = "other.zip"
		}
		if id%5 == 0 {
			task.Status = StatusPaused
			m.statusCounts[StatusDone]--
			m.statusCounts[StatusPaused]++
		}
		m.indexTaskOverviewLocked(task)
	}
	for _, field := range []string{"", "id", "file", "status", "link", "progress", "size", "speed", "remaining", "created", "unknown"} {
		for _, order := range []string{"asc", "desc"} {
			for _, filter := range []struct {
				status Status
				search string
			}{{}, {StatusPaused, ""}, {"", "FILE-01"}} {
				t.Run(fmt.Sprintf("%s/%s/%s/%s", field, order, filter.status, filter.search), func(t *testing.T) {
					all := m.PageTaskSnapshotsSorted(0, 300, filter.status, filter.search, field, order)
					want := []int64{}
					for _, task := range all.Tasks {
						if m.classifyTask(m.tasks[task.ID]) == "image" {
							want = append(want, task.ID)
						}
					}
					for _, offset := range []int{0, 3, 100, len(want), len(want) + 10} {
						page, hit := m.PageTaskSnapshotsFilteredIfChanged(offset, 17, filter.status, filter.search, field, order, "image", "")
						got := []int64{}
						for _, task := range page.Tasks {
							got = append(got, task.ID)
						}
						if hit || page.Total != len(want) || !reflect.DeepEqual(got, want[min(offset, len(want)):min(offset+17, len(want))]) {
							t.Fatalf("offset %d: total=%d, ids=%v, expected full order=%v", offset, page.Total, got, want)
						}
						if _, hit := m.PageTaskSnapshotsFilteredIfChanged(offset, 17, filter.status, filter.search, field, order, "image", page.Version); !hit {
							t.Fatal("unchanged category page missed its validator")
						}
					}
					if page, _ := m.PageTaskSnapshotsFilteredIfChanged(0, 17, filter.status, filter.search, field, order, "missing", ""); page.Total != 0 || len(page.Tasks) != 0 {
						t.Fatal("unknown category returned tasks")
					}
				})
			}
		}
	}
}

func TestTaskPageTransferAndDateSort(t *testing.T) {
	m := benchmarkPageManager(3)
	for i, id := range m.orderedIDs {
		task := m.tasks[id]
		task.Status = StatusDownloading
		task.TotalLength = []int64{200, 100, 0}[i]
		task.DownloadSpeed = []int64{50, 10, 20}[i]
		task.CreatedAt = time.Unix([]int64{1, 3, 2}[i], 0)
	}
	for _, test := range []struct {
		field, order string
		indices      []int
	}{
		{"size", "asc", []int{1, 0, 2}},
		{"size", "desc", []int{0, 1, 2}},
		{"speed", "asc", []int{1, 2, 0}},
		{"remaining", "asc", []int{0, 1, 2}},
		{"remaining", "desc", []int{1, 0, 2}},
		{"created", "desc", []int{1, 2, 0}},
	} {
		page := m.PageTaskSnapshotsSorted(0, 3, "", "", test.field, test.order)
		for i, index := range test.indices {
			if page.Tasks[i].ID != m.orderedIDs[index] {
				t.Fatalf("%s %s position %d: got %d, want %d", test.field, test.order, i, page.Tasks[i].ID, m.orderedIDs[index])
			}
		}
	}
}

func BenchmarkCategoryPage100Of10000(b *testing.B) {
	for _, field := range []string{"", "id", "status", "file"} {
		b.Run("sort="+field, func(b *testing.B) {
			m := benchmarkPageManager(10_000)
			// Production managers populate overview/category indexes at load time.
			for _, task := range m.tasks {
				m.indexTaskOverviewLocked(task)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				page, _ := m.PageTaskSnapshotsFilteredIfChanged(100, 100, "", "", field, "desc", "other", "")
				if len(page.Tasks) != 100 || page.Total != 10_000 {
					b.Fatal("incorrect category page")
				}
			}
		})
	}
}
