package downloader

import (
	"fmt"
	"reflect"
	"testing"
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
	for _, field := range []string{"", "id", "file", "status", "link", "progress", "unknown"} {
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
