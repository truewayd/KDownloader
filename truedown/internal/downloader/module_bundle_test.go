package downloader

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"truedown/internal/modulehost"
)

func TestBundledModuleStartsWithoutUserConfiguration(t *testing.T) {
	root := artifactTempDir(t)
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	path, err := m.moduleExecutable("mega")
	if err != nil {
		t.Skip("run desktop preparation to provide this platform's bundled executable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := modulehost.Connect(ctx, exec.Command(path), "mega")
	if err != nil {
		t.Fatal(err)
	}
	defer retireModule(client)
	if !moduleHasArtifactCapability(client.Info) {
		t.Fatal("bundled module cannot serve queue artifacts")
	}
}
