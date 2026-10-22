package downloader

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"truedown/internal/modulehost"
)

const MediaFireModuleID = "mediafire"

func executableModule(id string) bool { return id == "mega" || id == MediaFireModuleID }
func executableCapability(id string, info modulehost.Hello) bool {
	if id == "mega" {
		return moduleHasArtifactCapability(info)
	}
	return id == MediaFireModuleID && moduleCapability(info, "http-resolver-v1") && moduleCapability(info, "public-folder-v1")
}
func moduleDownloadName(id, version string) string {
	name := "MediaFire"
	if id == "mega" {
		name = "MEGA"
	}
	return name + " module " + version + ".bin"
}

// This adapter knows the host's network policy, not MediaFire's API or HTML.
// Provider changes are shipped in the signed executable without a core update.
type httpExecutableResolver struct{ version string }

func newHTTPExecutableResolver(pkg componentPackage) (resolverModule, error) {
	var config struct{}
	if modulehost.Decode(pkg.Config, &config) != nil {
		return nil, &ValidationError{Message: "executable module configuration is fixed by the host"}
	}
	return &httpExecutableResolver{version: pkg.Version}, nil
}
func (r *httpExecutableResolver) info() ModuleInfo {
	return ModuleInfo{ID: MediaFireModuleID, Name: "MediaFire", Version: r.version, BuiltIn: true, Description: "下载公开文件，或将公开目录展开为独立任务。受密码、登录或验证码保护的链接需手动处理。", Capabilities: []string{"file", "folder", "folder-filter", "resume", "executable"}}
}
func (*httpExecutableResolver) matches(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && len(raw) <= 8192 && u.Scheme == "https" && u.User == nil && u.Port() == "" && (strings.EqualFold(u.Host, "www.mediafire.com") || strings.EqualFold(u.Host, "mediafire.com"))
}
func (*httpExecutableResolver) supportsPartialResume(string) bool { return true }
func (*httpExecutableResolver) validateOptions(raw json.RawMessage) error {
	var options struct {
		ApplyFilter *bool `json:"applyFilter,omitempty"`
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) != 0 && (raw[0] != '{' || modulehost.Decode(raw, &options) != nil) {
		return &ValidationError{Message: "unsupported HTTP module options"}
	}
	return nil
}
func (m *Manager) httpModuleClient(ctx context.Context, opts Aria2Opts) (*modulehost.Client, string, error) {
	request, _ := http.NewRequest(http.MethodGet, "https://www.mediafire.com/", nil)
	proxy, err := m.proxyForTask(opts)(request)
	if err != nil {
		return nil, "", err
	}
	proxyURL := ""
	if proxy != nil {
		proxyURL = proxy.String()
	}
	executable, err := m.moduleExecutable(MediaFireModuleID)
	if err != nil {
		return nil, "", err
	}
	client, err := modulehost.Connect(ctx, exec.Command(executable), MediaFireModuleID)
	if err != nil {
		return nil, "", err
	}
	if !executableCapability(MediaFireModuleID, client.Info) {
		retireModule(client)
		return nil, "", fmt.Errorf("HTTP resolver module protocol is incompatible")
	}
	return client, proxyURL, nil
}
func (r *httpExecutableResolver) resolve(ctx context.Context, m *Manager, request moduleResolveRequest) (ModuleAddResult, bool, error) {
	result := ModuleAddResult{ModuleID: MediaFireModuleID}
	if err := r.validateOptions(request.Options); err != nil {
		return result, true, err
	}
	identity := normalizeRequest(request.Link, request.Name, request.Folder, m.defaultDir, nil, "", request.QueueID, request.Opts)
	identity.ModuleID = MediaFireModuleID
	if err := validateRequest(identity); err != nil {
		return result, true, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	client, proxy, err := m.httpModuleClient(ctx, request.Opts)
	if err != nil {
		return result, true, err
	}
	defer retireModule(client)
	var source modulehost.HTTPSource
	if err := client.Call(ctx, "resolve", map[string]any{"source": request.Link}, &source); err != nil {
		return result, true, err
	}
	if !r.matches(source.Source) {
		return result, true, fmt.Errorf("invalid module source")
	}
	if !source.Folder {
		task, duplicate, err := m.addTaskWithModule(source.Source, identity.Name, identity.Folder, nil, "", request.QueueID, request.Opts, MediaFireModuleID)
		if task != nil {
			result.Tasks = []*Task{task}
		}
		if duplicate {
			result.Duplicates = 1
		}
		return result, true, err
	}
	result.Collection = true
	collection, err := modulehost.ListCollection(ctx, client, source.Source, proxy)
	if err != nil {
		return result, true, err
	}
	options := struct {
		ApplyFilter *bool `json:"applyFilter,omitempty"`
	}{}
	if len(request.Options) != 0 {
		_ = modulehost.Decode(request.Options, &options)
	}
	excluded := m.folderSuffixFilter()
	if options.ApplyFilter != nil && !*options.ApplyFilter {
		excluded = nil
	}
	requests := []taskAddRequest{}
	for _, entry := range collection.Entries {
		if entry.Directory {
			continue
		}
		if !r.matches(entry.Source) {
			return result, true, fmt.Errorf("invalid folder source")
		}
		name := entry.Path[len(entry.Path)-1]
		if dropboxFileExcluded(name, entry.Source, excluded) {
			result.Filtered++
			continue
		}
		folder := filepath.Join(append([]string{identity.Folder, collection.Name}, entry.Path[:len(entry.Path)-1]...)...)
		requests = append(requests, taskAddRequest{Link: entry.Source, Name: name, Folder: folder, QueueID: request.QueueID, Opts: request.Opts, ModuleID: MediaFireModuleID})
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

var mediaFireCDN = regexp.MustCompile(`^download[0-9]+\.(mediafire\.com|mediafirecdn\.com)$`)

func validMediaFireTransport(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && len(raw) <= 16384 && u.Scheme == "https" && u.User == nil && u.Port() == "" && u.Fragment == "" && mediaFireCDN.MatchString(strings.ToLower(u.Host)) && validateDownloadURL(raw) == nil
}
func (r *httpExecutableResolver) prepare(ctx context.Context, m *Manager, task *Task) (modulePreparation, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	client, proxy, err := m.httpModuleClient(ctx, task.Opts)
	if err != nil {
		return modulePreparation{}, err
	}
	defer retireModule(client)
	var prepared modulehost.PreparedHTTP
	if err := client.Call(ctx, "prepare", map[string]any{"source": task.Link, "proxy": proxy}, &prepared); err != nil {
		return modulePreparation{}, err
	}
	if !modulehost.ValidCollectionName(prepared.Name) || prepared.Size < 0 || prepared.Size > 1<<50 || !validMediaFireTransport(prepared.URL) {
		return modulePreparation{}, fmt.Errorf("invalid HTTP module metadata or transport")
	}
	if task.RemoteDigest != "" && prepared.SHA256 == "" {
		return modulePreparation{}, fmt.Errorf("HTTP module remote digest is no longer available")
	}
	if prepared.SHA256 != "" {
		digest, err := hex.DecodeString(prepared.SHA256)
		if err != nil || len(digest) != 32 || hex.EncodeToString(digest) != prepared.SHA256 {
			return modulePreparation{}, fmt.Errorf("invalid HTTP module digest")
		}
	}
	return modulePreparation{Link: prepared.URL, Headers: map[string]string{}, ProxyURL: proxy, Metadata: remoteMetadata{NameSource: responseFilenameIdentity, Name: prepared.Name, Length: prepared.Size, LengthKnown: true, Digest: prepared.SHA256}}, nil
}
