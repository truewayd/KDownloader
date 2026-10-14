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
	return ModuleInfo{ID: "mega", Name: "MEGA", Version: r.version, BuiltIn: true, Description: "公开文件与目录：逐文件下载或生成 ZIP，并独立解密校验。", Capabilities: []string{"file", "folder", "folder-filter", "folder-zip", "resume", "artifact"}}
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
	var options struct {
		Mode        string `json:"mode"`
		ApplyFilter *bool  `json:"applyFilter,omitempty"`
	}
	if modulehost.Decode(raw, &options) != nil {
		return &ValidationError{Message: "unsupported executable module options"}
	}
	if options.Mode != "" && options.Mode != MegaModeArchive && options.Mode != MegaModeExpand {
		return &ValidationError{Message: "MEGA mode must be archive or expand"}
	}
	return nil
}
func (r *executableResolver) resolve(ctx context.Context, m *Manager, request moduleResolveRequest) (ModuleAddResult, bool, error) {
	if err := r.validateOptions(request.Options); err != nil {
		return ModuleAddResult{}, true, err
	}
	if megaFolderSource(request.Link) {
		return r.resolveFolder(ctx, m, request)
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
	proxyURL, err := m.megaTaskProxy(task.Opts)
	if err != nil {
		return modulePreparation{}, err
	}
	var identity requestIdentity
	if json.Unmarshal([]byte(task.RequestJSON), &identity) != nil {
		return modulePreparation{}, fmt.Errorf("invalid module request identity")
	}
	if identity.Collection != nil {
		size, err := modulehost.ValidateCollection(identity.Collection)
		if err != nil {
			return modulePreparation{}, err
		}
		if !moduleCapability(client.Info, "folder-zip-v1") {
			return modulePreparation{}, fmt.Errorf("MEGA module needs folder support; repair or update it")
		}
		return modulePreparation{Headers: map[string]string{}, ProxyURL: proxyURL, Metadata: remoteMetadata{Name: identity.Collection.Name + ".zip", Length: size, LengthKnown: true}, Artifact: &artifactPlan{Executable: executable, Source: task.Link, Collection: identity.Collection, Proxy: proxyURL}}, nil
	}
	var prepared modulehost.PreparedArtifact
	prepareRequest := map[string]any{"source": task.Link, "proxy": proxyURL}
	if len(identity.ModuleData) > 0 {
		prepareRequest["data"] = identity.ModuleData
	}
	if err := client.Call(ctx, "prepare", prepareRequest, &prepared); err != nil {
		return modulePreparation{}, err
	}
	if prepared.Size < 0 || prepared.Size > 1<<50 || prepared.Name == "" || len(prepared.Name) > 4096 {
		return modulePreparation{}, fmt.Errorf("invalid module metadata")
	}
	if err := validateDownloadURL(prepared.URL); err != nil {
		return modulePreparation{}, fmt.Errorf("invalid module transport")
	}
	return modulePreparation{Link: prepared.URL, Headers: map[string]string{}, ProxyURL: proxyURL, Metadata: remoteMetadata{Name: sanitizeModulePathComponent(prepared.Name), Length: prepared.Size, LengthKnown: true}, Artifact: &artifactPlan{Executable: executable, Source: task.Link, Data: prepared.Data}}, nil
}

func (m *Manager) megaTaskProxy(opts Aria2Opts) (string, error) {
	request, _ := http.NewRequest(http.MethodGet, "https://g.api.mega.co.nz/", nil)
	proxy, err := m.proxyForTask(opts)(request)
	if err != nil {
		return "", err
	}
	if proxy != nil {
		return proxy.String(), nil
	}
	return "", nil
}

func megaFolderSource(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (strings.HasPrefix(u.Path, "/folder/") && !strings.Contains(u.Fragment, "/file/")) || strings.HasPrefix(u.Fragment, "F!")
}

func (r *executableResolver) resolveFolder(ctx context.Context, m *Manager, request moduleResolveRequest) (ModuleAddResult, bool, error) {
	result := ModuleAddResult{ModuleID: "mega", Collection: true}
	identity := normalizeRequest(request.Link, request.Name, request.Folder, m.defaultDir, nil, "", request.QueueID, request.Opts)
	identity.ModuleID = "mega"
	if err := validateRequest(identity); err != nil {
		return result, true, err
	}
	defaults := m.DownloadRules()
	options := struct {
		Mode        string `json:"mode"`
		ApplyFilter *bool  `json:"applyFilter,omitempty"`
	}{Mode: defaults.MegaMode}
	if len(request.Options) != 0 {
		_ = modulehost.Decode(request.Options, &options)
	}
	if options.Mode == "" {
		options.Mode = defaults.MegaMode
	}
	executable, err := m.moduleExecutable("mega")
	if err != nil {
		return result, true, err
	}
	client, err := modulehost.Connect(ctx, exec.Command(executable), "mega")
	if err != nil {
		return result, true, err
	}
	defer retireModule(client)
	if !moduleCapability(client.Info, "public-folder-v1") {
		return result, true, fmt.Errorf("MEGA module needs folder support; repair or update it")
	}
	proxy, err := m.megaTaskProxy(request.Opts)
	if err != nil {
		return result, true, err
	}
	collection := &modulehost.ArtifactCollection{}
	total := -1
	for offset := 0; ; {
		var page modulehost.CollectionPage
		if err := client.Call(ctx, "list", map[string]any{"source": request.Link, "proxy": proxy, "offset": offset, "limit": 100}, &page); err != nil {
			return result, true, err
		}
		if page.Total < 0 || page.Total > 6000 || len(page.Entries) > 100 || (total >= 0 && (page.Total != total || page.Name != collection.Name)) || offset+len(page.Entries) > page.Total {
			return result, true, fmt.Errorf("invalid folder page")
		}
		if total < 0 {
			total, collection.Name = page.Total, page.Name
		}
		collection.Entries = append(collection.Entries, page.Entries...)
		if page.Next == -1 {
			if len(collection.Entries) != total {
				return result, true, fmt.Errorf("incomplete folder listing")
			}
			break
		}
		if page.Next != offset+len(page.Entries) || page.Next <= offset {
			return result, true, fmt.Errorf("invalid folder cursor")
		}
		offset = page.Next
	}
	if _, err := modulehost.ValidateCollection(collection); err != nil {
		return result, true, err
	}
	for _, entry := range collection.Entries {
		if !entry.Directory && !r.matches(entry.Source) {
			return result, true, fmt.Errorf("invalid folder file source")
		}
	}
	if options.Mode == MegaModeArchive {
		name := identity.Name
		if name == "" {
			name = collection.Name + ".zip"
		} else if !strings.HasSuffix(strings.ToLower(name), ".zip") {
			name += ".zip"
		}
		task, duplicate, err := m.addModuleTask(request.Link, name, identity.Folder, nil, "", request.QueueID, request.Opts, "mega", nil, collection)
		if task != nil {
			result.Tasks = []*Task{task}
		}
		if duplicate {
			result.Duplicates = 1
		}
		return result, true, err
	}
	excluded := m.folderSuffixFilter()
	if options.ApplyFilter != nil && !*options.ApplyFilter {
		excluded = nil
	}
	requests := make([]taskAddRequest, 0, len(collection.Entries))
	for _, entry := range collection.Entries {
		if entry.Directory {
			continue
		}
		name := entry.Path[len(entry.Path)-1]
		if dropboxFileExcluded(name, entry.Source, excluded) {
			result.Filtered++
			continue
		}
		folder := filepath.Join(append([]string{identity.Folder, collection.Name}, entry.Path[:len(entry.Path)-1]...)...)
		requests = append(requests, taskAddRequest{Link: entry.Source, Name: name, Folder: folder, QueueID: request.QueueID, Opts: request.Opts, ModuleID: "mega", ModuleData: entry.Data})
	}
	added, err := m.addTasksBatch(requests)
	if err != nil {
		return result, true, err
	}
	for _, item := range added {
		result.Tasks = append(result.Tasks, item.Task)
		if item.Duplicate {
			result.Duplicates++
		}
	}
	return result, true, nil
}

func moduleCapability(info modulehost.Hello, name string) bool {
	for _, value := range info.Capabilities {
		if value == name {
			return true
		}
	}
	return false
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
