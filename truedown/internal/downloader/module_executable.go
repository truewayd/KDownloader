package downloader

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"truedown/internal/modulebundle"
	"truedown/internal/modulehost"
)

// executableResolver is only a host adapter. Link semantics and cryptography
// live in the independently built process.
type executableResolver struct{ version string }

func newExecutableResolver(pkg componentPackage) (resolverModule, error) {
	var config struct{}
	if modulehost.Decode(pkg.Config, &config) != nil {
		return nil, &ValidationError{Message: "executable module configuration is fixed by the host"}
	}
	return &executableResolver{version: pkg.Version}, nil
}
func (r *executableResolver) info() ModuleInfo {
	return ModuleInfo{ID: "mega", Name: "MEGA", Version: r.version, BuiltIn: true, Description: "Public files via aria2, with independent Go decryption and verification.", Capabilities: []string{"file", "resume", "artifact"}}
}
func (*executableResolver) matches(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "mega.nz", "www.mega.nz", "mega.co.nz", "www.mega.co.nz":
		return true
	}
	return false
}
func (*executableResolver) supportsPartialResume(string) bool { return false }
func (*executableResolver) validateOptions(raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil
	}
	var options struct{}
	if modulehost.Decode(raw, &options) != nil {
		return &ValidationError{Message: "unsupported executable module options"}
	}
	return nil
}
func (r *executableResolver) resolve(ctx context.Context, m *Manager, request moduleResolveRequest) (ModuleAddResult, bool, error) {
	if err := r.validateOptions(request.Options); err != nil {
		return ModuleAddResult{}, true, err
	}
	// Durable admission precedes network resolution, preserving paused intent.
	task, duplicate, err := m.addTaskWithModule(request.Link, request.Name, request.Folder, nil, "", request.QueueID, request.Opts, "mega")
	result := ModuleAddResult{ModuleID: "mega"}
	if task != nil {
		result.Tasks = []*Task{task}
	}
	if duplicate {
		result.Duplicates = 1
	}
	return result, true, err
}
func (r *executableResolver) prepare(ctx context.Context, m *Manager, task *Task) (modulePreparation, error) {
	executable, err := m.moduleExecutable(task.ModuleID)
	if err != nil {
		return modulePreparation{}, err
	}
	command := exec.Command(executable)
	client, err := modulehost.Connect(ctx, command, task.ModuleID)
	if err != nil {
		return modulePreparation{}, fmt.Errorf("start download module: %w", err)
	}
	defer retireModule(client)
	if !moduleHasArtifactCapability(client.Info) {
		return modulePreparation{}, fmt.Errorf("download module protocol is incompatible")
	}
	request, _ := http.NewRequest(http.MethodGet, "https://g.api.mega.co.nz/", nil)
	proxy, err := taskProxy(task.Opts)(request)
	if err != nil {
		return modulePreparation{}, err
	}
	proxyURL := ""
	if proxy != nil {
		proxyURL = proxy.String()
	}
	var prepared modulehost.PreparedArtifact
	if err := client.Call(ctx, "prepare", map[string]any{"source": task.Link, "proxy": proxyURL}, &prepared); err != nil {
		return modulePreparation{}, err
	}
	if prepared.Size < 0 || prepared.Size > 1<<50 || prepared.Name == "" || len(prepared.Name) > 4096 {
		return modulePreparation{}, fmt.Errorf("invalid module metadata")
	}
	if err := validateDownloadURL(prepared.URL); err != nil {
		return modulePreparation{}, fmt.Errorf("invalid module transport")
	}
	return modulePreparation{Link: prepared.URL, Headers: map[string]string{}, ProxyURL: proxyURL, Metadata: remoteMetadata{Name: sanitizeModulePathComponent(prepared.Name), Length: prepared.Size, LengthKnown: true}, Artifact: &artifactPlan{Executable: executable, Source: task.Link}}, nil
}

func retireModule(client *modulehost.Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = client.CloseAndWait(ctx)
}

func moduleHasArtifactCapability(info modulehost.Hello) bool {
	for _, capability := range info.Capabilities {
		if capability == "aria2-artifact-v1" {
			return true
		}
	}
	return false
}

func (m *Manager) moduleExecutable(id string) (string, error) {
	if id != "mega" {
		return "", fmt.Errorf("unknown executable module")
	}
	root := m.moduleDirectory
	if path, _, err := m.activeExecutable(id); err == nil {
		return path, nil
	}
	if root == "" {
		return modulebundle.Ensure(m.executableRoot(id), id)
	}
	entry := "truedown-" + id
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	path := filepath.Join(root, id, entry)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("download module is unavailable; repair the TrueDown installation")
	}
	return path, nil
}
