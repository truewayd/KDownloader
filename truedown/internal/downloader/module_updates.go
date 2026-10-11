package downloader

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"truedown/internal/modulehost"
	"truedown/internal/safefile"
)

type ModuleUpdateState struct {
	Running bool   `json:"running"`
	Version string `json:"version"`
	Error   string `json:"error,omitempty"`
}
type moduleActive struct {
	Version string `json:"version"`
}

func modulePublicKey() ed25519.PublicKey {
	key, _ := hex.DecodeString(modulehost.PublisherPublicKey)
	return key
}
func (m *Manager) executableRoot(id string) string {
	return filepath.Join(m.modules.packagesDir, "executables", id)
}

func (m *Manager) activeExecutable(id string) (string, string, error) {
	root := m.executableRoot(id)
	raw, err := safefile.ReadFile(filepath.Join(root, "active.json"), 4096)
	if err != nil {
		return "", "", err
	}
	var active moduleActive
	if modulehost.Decode(raw, &active) != nil || !modulehost.Newer(active.Version, "0.1.0") {
		return "", "", modulehost.ErrPackage
	}
	directory := filepath.Join(root, active.Version)
	raw, err = safefile.ReadFile(filepath.Join(directory, "manifest.json"), 16*1024)
	if err != nil {
		return "", "", err
	}
	signature, err := safefile.ReadFile(filepath.Join(directory, "manifest.sig"), 64)
	if err != nil || !ed25519.Verify(modulePublicKey(), raw, signature) {
		return "", "", modulehost.ErrPackage
	}
	manifest, err := modulehost.DecodeManifest(raw, id)
	if err != nil || manifest.Version != active.Version {
		return "", "", modulehost.ErrPackage
	}
	entry := "provider"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	path := filepath.Join(directory, entry)
	hash, err := artifactHash(path, manifest.Size)
	if err != nil || hash != manifest.SHA256 {
		return "", "", modulehost.ErrPackage
	}
	return path, manifest.Version, nil
}

func (m *Manager) ModuleUpdateStatus() ModuleUpdateState {
	m.moduleUpdateMu.Lock()
	defer m.moduleUpdateMu.Unlock()
	return m.moduleUpdateState
}
func (m *Manager) StartModuleUpdate(id string) error {
	if id != "mega" {
		return &ValidationError{Message: "unknown executable module"}
	}
	m.moduleUpdateMu.Lock()
	defer m.moduleUpdateMu.Unlock()
	if m.moduleUpdateState.Running {
		return nil
	}
	if m.lifecycleCtx.Err() != nil {
		return fmt.Errorf("application is stopping")
	}
	m.moduleUpdateState = ModuleUpdateState{Running: true}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		version, err := m.updateExecutable(m.lifecycleCtx, id)
		state := ModuleUpdateState{Version: version}
		if err != nil {
			state.Error = "Module update failed; the previous version remains available"
		}
		m.moduleUpdateMu.Lock()
		m.moduleUpdateState = state
		m.moduleUpdateMu.Unlock()
	}()
	return nil
}

func moduleUpdateHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = systemProxyFunc()
	return &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(request *http.Request, previous []*http.Request) error {
		if len(previous) > 5 || request.URL.Scheme != "https" || request.URL.User != nil {
			return modulehost.ErrPackage
		}
		switch request.URL.Hostname() {
		case "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
			return nil
		}
		return modulehost.ErrPackage
	}}
}
func moduleFetch(ctx context.Context, client *http.Client, raw string, maximum int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("module release server unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("module release unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil || int64(len(data)) > maximum {
		return nil, modulehost.ErrPackage
	}
	return data, nil
}

func (m *Manager) updateExecutable(ctx context.Context, id string) (string, error) {
	current := "0.1.0"
	if _, version, err := m.activeExecutable(id); err == nil {
		current = version
	}
	client := moduleUpdateHTTPClient()
	defer client.CloseIdleConnections()
	version := current
	prefix := "truedown-module-" + id + "-v"
	for page := 1; page <= 10; page++ {
		raw, err := moduleFetch(ctx, client, fmt.Sprintf("https://api.github.com/repos/truewayd/KDownloader/releases?per_page=100&page=%d", page), 2*1024*1024)
		if err != nil {
			return "", err
		}
		var releases []struct {
			Tag        string `json:"tag_name"`
			Draft      bool   `json:"draft"`
			Prerelease bool   `json:"prerelease"`
		}
		if json.Unmarshal(raw, &releases) != nil {
			return "", modulehost.ErrPackage
		}
		for _, release := range releases {
			if !release.Draft && !release.Prerelease && strings.HasPrefix(release.Tag, prefix) {
				candidate := strings.TrimPrefix(release.Tag, prefix)
				if modulehost.Newer(candidate, version) {
					version = candidate
				}
			}
		}
		if len(releases) < 100 {
			break
		}
		if page == 10 {
			return "", fmt.Errorf("module release history exceeds discovery bound")
		}
	}
	if version == current {
		m.cleanupModuleCache(false)
		return current, nil
	}
	base := "https://github.com/truewayd/KDownloader/releases/download/" + url.PathEscape(prefix+version) + "/"
	stem := id + "-" + runtime.GOOS + "-" + runtime.GOARCH
	raw, err := moduleFetch(ctx, client, base+stem+".json", 16*1024)
	if err != nil {
		return "", err
	}
	signature, err := moduleFetch(ctx, client, base+stem+".sig", 64)
	if err != nil {
		return "", err
	}
	if !ed25519.Verify(modulePublicKey(), raw, signature) {
		return "", modulehost.ErrPackage
	}
	manifest, err := modulehost.DecodeManifest(raw, id)
	if err != nil || manifest.Version != version {
		return "", modulehost.ErrPackage
	}
	root := m.executableRoot(id)
	path, err := m.DownloadUpdate(ctx, base+stem+".bin", "MEGA module "+version+".bin", filepath.Join(root, "downloads"), manifest.Size, Aria2Opts{})
	if err != nil {
		return "", err
	}
	defer os.Remove(path)
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	installed, err := modulehost.InstallSigned(root, id, current, raw, signature, modulePublicKey(), file)
	if err != nil {
		return "", err
	}
	if err := m.activateExecutable(ctx, id, installed, version); err != nil {
		return "", err
	}
	m.cleanupModuleCache(false)
	return version, nil
}

func (m *Manager) activateExecutable(ctx context.Context, id, installed, version string) error {
	healthCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	process, err := modulehost.Connect(healthCtx, exec.Command(installed), id)
	if err != nil {
		return err
	}
	healthy := process.Info.Version == version && moduleHasArtifactCapability(process.Info)
	retireModule(process)
	if !healthy {
		return modulehost.ErrPackage
	}
	// Keep rollback retention separate so older hosts can still decode active.json.
	root := m.executableRoot(id)
	if raw, err := safefile.ReadFile(filepath.Join(root, "active.json"), 4096); err == nil {
		var previous moduleActive
		if modulehost.Decode(raw, &previous) != nil || !modulehost.Newer(version, previous.Version) {
			return modulehost.ErrPackage
		}
		if err := safefile.WriteFile(filepath.Join(root, "previous.json"), raw, 0600); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	pointer, _ := json.Marshal(moduleActive{Version: version})
	if err := safefile.WriteFile(filepath.Join(m.executableRoot(id), "active.json"), pointer, 0600); err != nil {
		return err
	}
	return nil
}
