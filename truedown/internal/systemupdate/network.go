package systemupdate

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	maxGitHubResponseBytes = 4 * 1024 * 1024
	maxManifestBytes       = 128 * 1024
	maxChecksumsBytes      = 256 * 1024
	maxReleaseArchiveBytes = 96 * 1024 * 1024
	maxArchiveEntries      = 64
	maxArchiveExpanded     = 160 * 1024 * 1024
)

type githubAsset struct {
	Name               string `json:"name"`
	Size               int64  `json:"size"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type githubRelease struct {
	TagName     string        `json:"tag_name"`
	HTMLURL     string        `json:"html_url"`
	Draft       bool          `json:"draft"`
	Prerelease  bool          `json:"prerelease"`
	PublishedAt time.Time     `json:"published_at"`
	Assets      []githubAsset `json:"assets"`
}

type updateManifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Product       string `json:"product"`
	Repository    string `json:"repository"`
	Version       string `json:"version"`
	Build         int64  `json:"build"`
	Asset         struct {
		Name   string `json:"name"`
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	} `json:"asset"`
}

func (m *Manager) UpdateTrueDown(ctx context.Context) (Snapshot, error) {
	if runtime.GOOS != "windows" || m.currentBuild <= 0 {
		return m.Snapshot(), fmt.Errorf("automatic TrueDown updates are available in packaged Windows builds")
	}
	if err := m.begin("truedown"); err != nil {
		return m.Snapshot(), err
	}
	err := m.updateTrueDown(ctx)
	m.finish(err)
	return m.Snapshot(), err
}

func (m *Manager) updateTrueDown(ctx context.Context) error {
	var releases []githubRelease
	if err := m.fetchJSON(ctx, m.trueDownReleasesURL, maxGitHubResponseBytes, &releases); err != nil {
		return fmt.Errorf("check TrueDown releases: %w", err)
	}
	available, err := selectTrueDownRelease(releases, m.currentBuild)
	if err != nil {
		return err
	}
	m.mu.Lock()
	next := m.state
	next.LastCheckedAt = m.now().UTC()
	next.LastUpdateError = ""
	if persistErr := m.persistStateLocked(next); persistErr != nil {
		m.mu.Unlock()
		return persistErr
	}
	m.availableApp = available
	m.mu.Unlock()
	if available == nil {
		return nil
	}
	if err := m.stageTrueDown(ctx, available); err != nil {
		return err
	}
	return nil
}

func selectTrueDownRelease(releases []githubRelease, currentBuild int64) (*availableAppUpdate, error) {
	candidates := make([]availableAppUpdate, 0, len(releases))
	for _, release := range releases {
		if release.Draft || release.Prerelease {
			continue
		}
		build, ok := parseBuild(release.TagName)
		if !ok || build <= currentBuild {
			continue
		}
		archiveName := fmt.Sprintf("TrueDown-build-%d.zip", build)
		manifestName := fmt.Sprintf("truedown-update-%d.json", build)
		archive, archiveOK := findAsset(release.Assets, archiveName)
		manifest, manifestOK := findAsset(release.Assets, manifestName)
		if !archiveOK || !manifestOK || archive.Size <= 0 || archive.Size > maxReleaseArchiveBytes || manifest.Size <= 0 || manifest.Size > maxManifestBytes {
			continue
		}
		candidates = append(candidates, availableAppUpdate{
			Version:      release.TagName,
			Build:        build,
			ManifestURL:  manifest.BrowserDownloadURL,
			ManifestSize: manifest.Size,
			ArchiveURL:   archive.BrowserDownloadURL,
			ArchiveSize:  archive.Size,
			ArchiveName:  archive.Name,
			ReleaseURL:   release.HTMLURL,
			PublishedAt:  release.PublishedAt,
		})
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Build > candidates[j].Build })
	return &candidates[0], nil
}

func (m *Manager) stageTrueDown(ctx context.Context, available *availableAppUpdate) error {
	var manifest updateManifest
	if err := m.fetchStrictJSON(ctx, available.ManifestURL, maxManifestBytes, available.ManifestSize, &manifest); err != nil {
		return fmt.Errorf("download TrueDown update manifest: %w", err)
	}
	if manifest.SchemaVersion != 1 || manifest.Product != "TrueDown" || manifest.Repository != "truewayd/KDownloader" ||
		manifest.Version != available.Version || manifest.Build != available.Build || manifest.Asset.Name != available.ArchiveName ||
		manifest.Asset.Size != available.ArchiveSize || normalizeSHA256(manifest.Asset.SHA256) == "" {
		return fmt.Errorf("TrueDown update manifest does not match its GitHub release")
	}
	updatesDir := filepath.Join(m.dataDir, "updates")
	archivePath, digest, size, err := m.downloadFile(ctx, available.ArchiveURL, updatesDir, maxReleaseArchiveBytes)
	if err != nil {
		return fmt.Errorf("download TrueDown update: %w", err)
	}
	defer os.Remove(archivePath)
	if size != manifest.Asset.Size || !strings.EqualFold(digest, manifest.Asset.SHA256) {
		return fmt.Errorf("TrueDown update archive failed its size or SHA-256 check")
	}
	stagedName := fmt.Sprintf("TrueDown-build-%d.exe", available.Build)
	stagedPath := filepath.Join(updatesDir, stagedName)
	executableDigest, err := extractTrueDownExecutable(archivePath, stagedPath)
	if err != nil {
		return fmt.Errorf("stage TrueDown update: %w", err)
	}
	m.mu.Lock()
	next := m.state
	next.PendingUpdate = &pendingAppUpdate{
		Version: available.Version,
		Build:   available.Build,
		File:    stagedName,
		SHA256:  executableDigest,
	}
	next.LastUpdateError = ""
	err = m.persistStateLocked(next)
	m.mu.Unlock()
	return err
}

func (m *Manager) InstallNext(ctx context.Context) (Snapshot, error) {
	if runtime.GOOS != "windows" {
		return m.Snapshot(), fmt.Errorf("Aria2 Next installation is available on Windows")
	}
	if err := m.begin("next-engine"); err != nil {
		return m.Snapshot(), err
	}
	err := m.installNext(ctx)
	m.finish(err)
	return m.Snapshot(), err
}

func (m *Manager) installNext(ctx context.Context) error {
	var release githubRelease
	if err := m.fetchJSON(ctx, m.nextReleaseURL, maxGitHubResponseBytes, &release); err != nil {
		return fmt.Errorf("check Aria2 Next release: %w", err)
	}
	available, err := selectNextRelease(release)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.availableNext = available
	m.mu.Unlock()
	var checksumText string
	if err := m.fetchText(ctx, available.ChecksumURL, maxChecksumsBytes, &checksumText); err != nil {
		return fmt.Errorf("download Aria2 Next checksums: %w", err)
	}
	expected, err := checksumForAsset(checksumText, available.BinaryName)
	if err != nil {
		return err
	}
	enginesDir := filepath.Join(m.dataDir, "engines")
	temporaryPath, digest, size, err := m.downloadFile(ctx, available.BinaryURL, enginesDir, maxEngineBytes)
	if err != nil {
		return fmt.Errorf("download Aria2 Next: %w", err)
	}
	defer os.Remove(temporaryPath)
	if available.BinarySize > 0 && size != available.BinarySize {
		return fmt.Errorf("Aria2 Next download size does not match its release metadata")
	}
	if !strings.EqualFold(digest, expected) {
		return fmt.Errorf("Aria2 Next download failed its published SHA-256 check")
	}
	if err := os.Chmod(temporaryPath, 0700); err != nil {
		return fmt.Errorf("prepare Aria2 Next executable: %w", err)
	}
	kind, version, err := m.inspectEngine(temporaryPath)
	if err != nil || kind != EngineNext || version != available.Version {
		return fmt.Errorf("Aria2 Next executable failed its version check")
	}
	finalPath := filepath.Join(enginesDir, available.BinaryName)
	if existingDigest, _, existingErr := hashFile(finalPath, maxEngineBytes); existingErr == nil {
		if !strings.EqualFold(existingDigest, digest) {
			return fmt.Errorf("managed Aria2 Next file already exists with an unexpected digest")
		}
	} else if os.IsNotExist(existingErr) {
		if err := os.Rename(temporaryPath, finalPath); err != nil {
			return fmt.Errorf("install Aria2 Next: %w", err)
		}
	} else {
		return fmt.Errorf("inspect installed Aria2 Next: %w", existingErr)
	}
	m.mu.Lock()
	next := m.state
	next.NextEngine = &installedEngine{
		Version: version,
		File:    available.BinaryName,
		SHA256:  strings.ToLower(digest),
	}
	next.LastUpdateError = ""
	err = m.persistStateLocked(next)
	m.mu.Unlock()
	return err
}

func selectNextRelease(release githubRelease) (*availableNextUpdate, error) {
	if release.Draft || release.Prerelease {
		return nil, fmt.Errorf("latest Aria2 Next release is not a stable release")
	}
	version := strings.TrimPrefix(strings.TrimSpace(release.TagName), "v")
	if !canonicalVersionPattern.MatchString(version) {
		return nil, fmt.Errorf("latest Aria2 Next tag is not a canonical version")
	}
	architecture := ""
	switch runtime.GOARCH {
	case "amd64":
		architecture = "x86_64"
	case "arm64":
		architecture = "arm64"
	default:
		return nil, fmt.Errorf("Aria2 Next has no supported Windows asset for %s", runtime.GOARCH)
	}
	binaryName := fmt.Sprintf("aria2-next-%s-windows-%s.exe", version, architecture)
	checksumName := fmt.Sprintf("aria2-next-%s-checksums.sha256", version)
	binary, binaryOK := findAsset(release.Assets, binaryName)
	checksum, checksumOK := findAsset(release.Assets, checksumName)
	if !binaryOK || !checksumOK || binary.Size <= 0 || binary.Size > maxEngineBytes || checksum.Size <= 0 || checksum.Size > maxChecksumsBytes {
		return nil, fmt.Errorf("Aria2 Next release is missing its Windows binary or checksum asset")
	}
	return &availableNextUpdate{
		Version:      version,
		BinaryName:   binaryName,
		BinaryURL:    binary.BrowserDownloadURL,
		BinarySize:   binary.Size,
		ChecksumName: checksumName,
		ChecksumURL:  checksum.BrowserDownloadURL,
	}, nil
}

func findAsset(assets []githubAsset, name string) (githubAsset, bool) {
	var match githubAsset
	found := false
	for _, asset := range assets {
		if asset.Name != name {
			continue
		}
		if found {
			return githubAsset{}, false
		}
		match, found = asset, true
	}
	return match, found
}

func checksumForAsset(checksums, name string) (string, error) {
	result := ""
	for _, line := range strings.Split(checksums, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) != 2 || strings.TrimPrefix(fields[1], "*") != name {
			continue
		}
		digest := normalizeSHA256(fields[0])
		if digest == "" || result != "" {
			return "", fmt.Errorf("Aria2 Next checksum file contains an invalid or duplicate entry")
		}
		result = digest
	}
	if result == "" {
		return "", fmt.Errorf("Aria2 Next checksum file does not cover %s", name)
	}
	return result, nil
}

func (m *Manager) RunAutomatic(ctx context.Context, canApply func() bool) <-chan struct{} {
	done := make(chan struct{})
	if runtime.GOOS != "windows" || m.currentBuild <= 0 {
		close(done)
		return done
	}
	go func() {
		defer close(done)
		initial := time.NewTimer(8 * time.Second)
		defer initial.Stop()
		select {
		case <-ctx.Done():
			return
		case <-initial.C:
		}
		m.cleanupOldUpdateHelpers()
		checkTicker := time.NewTicker(12 * time.Hour)
		applyTicker := time.NewTicker(30 * time.Second)
		defer checkTicker.Stop()
		defer applyTicker.Stop()
		m.runAutomaticCheck(ctx)
		m.tryAutomaticApply(canApply)
		for {
			select {
			case <-ctx.Done():
				return
			case <-checkTicker.C:
				m.runAutomaticCheck(ctx)
			case <-applyTicker.C:
				m.tryAutomaticApply(canApply)
			}
		}
	}()
	return done
}

func (m *Manager) runAutomaticCheck(ctx context.Context) {
	m.mu.RLock()
	enabled := m.state.AutoUpdateTrueDown
	pending := m.state.PendingUpdate != nil && m.state.PendingUpdate.Build > m.currentBuild
	m.mu.RUnlock()
	if !enabled || pending {
		return
	}
	_, _ = m.UpdateTrueDown(ctx)
}

func (m *Manager) tryAutomaticApply(canApply func() bool) {
	if !m.HasPendingUpdate() || canApply == nil || !canApply() {
		return
	}
	if err := m.requestRestart(true); err != nil {
		m.recordUpdateError(err)
	}
}

func (m *Manager) fetchJSON(ctx context.Context, rawURL string, maximum int64, target any) error {
	data, err := m.fetch(ctx, rawURL, maximum)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("response must contain one JSON value")
	}
	return nil
}

func (m *Manager) fetchStrictJSON(ctx context.Context, rawURL string, maximum, expected int64, target any) error {
	data, err := m.fetch(ctx, rawURL, maximum)
	if err != nil {
		return err
	}
	if expected <= 0 || int64(len(data)) != expected {
		return fmt.Errorf("response size does not match its release metadata")
	}
	data, err = requireJSONObject(data, "release manifest")
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("response must contain one JSON value")
	}
	return nil
}

func (m *Manager) fetchText(ctx context.Context, rawURL string, maximum int64, target *string) error {
	data, err := m.fetch(ctx, rawURL, maximum)
	if err != nil {
		return err
	}
	*target = string(data)
	return nil
}

func (m *Manager) fetch(ctx context.Context, rawURL string, maximum int64) ([]byte, error) {
	request, err := m.newRequest(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	response, err := m.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maximum {
		return nil, fmt.Errorf("response exceeds the allowed size")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, fmt.Errorf("response exceeds the allowed size")
	}
	return data, nil
}

func (m *Manager) downloadFile(ctx context.Context, rawURL, directory string, maximum int64) (string, string, int64, error) {
	request, err := m.newRequest(ctx, rawURL)
	if err != nil {
		return "", "", 0, err
	}
	response, err := m.client.Do(request)
	if err != nil {
		return "", "", 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", "", 0, fmt.Errorf("server returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maximum {
		return "", "", 0, fmt.Errorf("download exceeds the allowed size")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", "", 0, err
	}
	file, err := os.CreateTemp(directory, ".download-*.tmp")
	if err != nil {
		return "", "", 0, err
	}
	path := file.Name()
	remove := true
	defer func() {
		if remove {
			os.Remove(path)
		}
	}()
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return "", "", 0, err
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, maximum+1))
	if err != nil {
		file.Close()
		return "", "", 0, err
	}
	if written > maximum {
		file.Close()
		return "", "", 0, fmt.Errorf("download exceeds the allowed size")
	}
	if response.ContentLength >= 0 && response.ContentLength != written {
		file.Close()
		return "", "", 0, fmt.Errorf("download ended before its declared size")
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return "", "", 0, err
	}
	if err := file.Close(); err != nil {
		return "", "", 0, err
	}
	remove = false
	return path, hex.EncodeToString(hash.Sum(nil)), written, nil
}

func (m *Manager) newRequest(ctx context.Context, rawURL string) (*http.Request, error) {
	if err := m.validateURL(rawURL); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json, application/octet-stream;q=0.9")
	request.Header.Set("User-Agent", "TrueDown/"+m.currentVersion)
	return request, nil
}

func (m *Manager) checkRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= 8 {
		return fmt.Errorf("too many update redirects")
	}
	return m.validateURL(request.URL.String())
}

func (m *Manager) validateURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.Fragment != "" || parsed.Hostname() == "" {
		return fmt.Errorf("invalid update URL")
	}
	if parsed.Scheme == "http" && m.allowInsecureLoopback && isLoopbackURL(raw) {
		return nil
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("update URL must use HTTPS")
	}
	host := strings.ToLower(parsed.Hostname())
	switch host {
	case "api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com":
		return nil
	}
	for _, configured := range []string{m.trueDownReleasesURL, m.nextReleaseURL} {
		base, parseErr := url.Parse(configured)
		if parseErr == nil && strings.EqualFold(base.Scheme, parsed.Scheme) && strings.EqualFold(base.Host, parsed.Host) {
			return nil
		}
	}
	return fmt.Errorf("update URL host is not trusted")
}

func extractTrueDownExecutable(archivePath, destination string) (string, error) {
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", err
	}
	defer archive.Close()
	if len(archive.File) == 0 || len(archive.File) > maxArchiveEntries {
		return "", fmt.Errorf("release archive contains an invalid number of entries")
	}
	var executable *zip.File
	var expanded uint64
	for _, entry := range archive.File {
		if entry.UncompressedSize64 > maxArchiveExpanded-expanded {
			return "", fmt.Errorf("release archive expands beyond the allowed size")
		}
		expanded += entry.UncompressedSize64
		if strings.ReplaceAll(entry.Name, "\\", "/") == "TrueDown.exe" {
			if executable != nil {
				return "", fmt.Errorf("release archive contains duplicate TrueDown executables")
			}
			executable = entry
		}
	}
	if executable == nil || executable.UncompressedSize64 == 0 || executable.UncompressedSize64 > maxEngineBytes {
		return "", fmt.Errorf("release archive does not contain a bounded TrueDown.exe")
	}
	reader, err := executable.Open()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	directory := filepath.Dir(destination)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(directory, ".truedown-exe-*.tmp")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0700); err != nil {
		temporary.Close()
		return "", err
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(reader, maxEngineBytes+1))
	if err != nil {
		temporary.Close()
		return "", err
	}
	if written <= 2 || written > maxEngineBytes || uint64(written) != executable.UncompressedSize64 {
		temporary.Close()
		return "", fmt.Errorf("TrueDown.exe size does not match the release archive")
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	probe := make([]byte, 2)
	file, err := os.Open(temporaryPath)
	if err != nil {
		return "", err
	}
	_, readErr := io.ReadFull(file, probe)
	file.Close()
	if readErr != nil || string(probe) != "MZ" {
		return "", fmt.Errorf("staged TrueDown executable is not a Windows PE file")
	}
	if _, err := os.Stat(destination); err == nil {
		if err := os.Remove(destination); err != nil {
			return "", err
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func loopbackHost(host string) bool {
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
