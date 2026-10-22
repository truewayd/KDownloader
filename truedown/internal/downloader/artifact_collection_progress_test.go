package downloader

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCollectionProgressSurvivesRestartAndFailedWrite(t *testing.T) {
	job := &collectionTransport{directory: t.TempDir(), task: &Task{ModuleID: "mega", Link: "https://example.test/folder"}, plan: artifactPlan{Collection: artifactHelperCollection()}}
	if err := job.loadProgress(); err != nil || job.completed != 0 {
		t.Fatal("legacy missing receipt must start unconfirmed", err)
	}
	// A sparse/full-length member is never a substitute for a receipt.
	if err := os.WriteFile(filepath.Join(job.directory, "ciphertext-000002"), make([]byte, 1024), 0600); err != nil {
		t.Fatal(err)
	}
	if err := job.loadProgress(); err != nil || job.completed != 0 {
		t.Fatal("file length advanced progress", err)
	}
	if err := job.saveProgress(2); err != nil {
		t.Fatal(err)
	}
	reopened := &collectionTransport{directory: job.directory, task: job.task, plan: job.plan}
	if err := reopened.loadProgress(); err != nil || reopened.completed != 2 {
		t.Fatal("lost confirmed completion", err)
	}
	// A replacement directory must fail closed without advancing in memory.
	path := filepath.Join(job.directory, "collection-progress.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := job.saveProgress(3); err == nil || job.completed != 2 {
		t.Fatal("failed commit advanced progress", err)
	}
}

func TestCollectionProgressRejectsUnboundOrInvalidReceipts(t *testing.T) {
	job := &collectionTransport{directory: t.TempDir(), task: &Task{ModuleID: "mega", Link: "https://example.test/folder"}, plan: artifactPlan{Collection: artifactHelperCollection()}}
	for _, tc := range []struct {
		name         string
		schema, next int
		identity     string
	}{
		{"foreign identity", 1, 2, strings.Repeat("f", 64)},
		{"unknown schema", 2, 2, artifactIdentity(job.task)},
		{"negative cursor", 1, -1, artifactIdentity(job.task)},
		{"past manifest", 1, 4, artifactIdentity(job.task)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(collectionProgress{Schema: tc.schema, Identity: tc.identity, Next: tc.next})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(job.directory, "collection-progress.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := job.loadProgress(); err == nil || job.completed != 0 {
				t.Fatal("accepted invalid receipt", err)
			}
		})
	}
}
