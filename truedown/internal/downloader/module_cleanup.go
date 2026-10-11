package downloader

import (
	"crypto/ed25519"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"time"

	"truedown/internal/modulebundle"
	"truedown/internal/modulehost"
	"truedown/internal/safefile"
	"truedown/internal/updatecache"
)

var moduleTemporaryName = regexp.MustCompile(`^\.install-[0-9]+$`)
var moduleDownloadCopyName = regexp.MustCompile(`^\.download-[0-9]+\.tmp$`)

func moduleCacheFile(name string) bool {
	return name == "provider" && runtime.GOOS != "windows" || name == "provider.exe" && runtime.GOOS == "windows" || name == "manifest.json" || name == "manifest.sig"
}

func (m *Manager) moduleCleanupReceipt(id, version string) (modulehost.ExecutableManifest, error) {
	directory := filepath.Join(m.executableRoot(id), version)
	raw, err := safefile.ReadFile(filepath.Join(directory, "manifest.json"), 16*1024)
	if err != nil {
		return modulehost.ExecutableManifest{}, err
	}
	signature, err := safefile.ReadFile(filepath.Join(directory, "manifest.sig"), 64)
	if err != nil || !ed25519.Verify(modulePublicKey(), raw, signature) {
		return modulehost.ExecutableManifest{}, modulehost.ErrPackage
	}
	manifest, err := modulehost.DecodeManifest(raw, id)
	if err != nil || manifest.Version != version {
		return manifest, modulehost.ErrPackage
	}
	return manifest, nil
}

// Version removal runs before this manager admits any module process. Updating
// a module while downloads run only reclaims receipts, never executable paths
// captured by an existing artifact operation.
func (m *Manager) cleanupModuleCache(pruneVersions bool) {
	_, current, err := m.activeExecutable("mega")
	if err != nil {
		current = ""
	}
	m.cleanupModuleCacheForVersion(pruneVersions, current)
}

// current is supplied only after activeExecutable verifies the selected package.
func (m *Manager) cleanupModuleCacheForVersion(pruneVersions bool, current string) {
	const id = "mega"
	directory := m.executableRoot(id)
	if pruneVersions {
		if err := modulebundle.Cleanup(directory, id); err != nil {
			log.Printf("clean bundled module cache: %v", err)
		}
	}
	root, err := updatecache.Open(directory)
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		log.Printf("open module cache: %v", err)
		return
	}
	defer root.Close()
	entries, err := updatecache.Entries(root)
	if err != nil {
		log.Printf("list module cache: %v", err)
		return
	}
	previous := "0.0.0"
	if current != "" {
		for _, entry := range entries {
			if entry.IsDir() && modulehost.Newer(current, entry.Name()) && modulehost.Newer(entry.Name(), previous) {
				previous = entry.Name()
			}
		}
		if raw, err := safefile.ReadFile(filepath.Join(directory, "previous.json"), 4096); err == nil {
			var retained moduleActive
			if modulehost.Decode(raw, &retained) != nil {
				return
			}
			if modulehost.Newer(current, retained.Version) {
				previous = retained.Version
			}
		} else if !os.IsNotExist(err) {
			log.Printf("read module retention: %v", err)
			return
		}
	}
	for _, entry := range entries {
		name := entry.Name()
		info, err := root.Lstat(name)
		if err != nil {
			continue
		}
		if current != "" && (name == current || modulehost.Newer(current, name)) {
			if receipt, err := m.moduleCleanupReceipt(id, name); err == nil {
				if err := m.CleanupUpdateDownloads(filepath.Join(directory, "downloads"), "MEGA module "+name+".bin", receipt.SHA256, receipt.Size); err != nil {
					log.Printf("clean module download %s: %v", name, err)
					continue
				}
			}
			if pruneVersions && name != current && name != previous && time.Since(info.ModTime()) >= 24*time.Hour {
				if err := updatecache.RemoveFlat(root, name, moduleCacheFile); err != nil {
					log.Printf("clean old module %s: %v", name, err)
				}
			}
		} else if pruneVersions && moduleTemporaryName.MatchString(name) && time.Since(info.ModTime()) >= 24*time.Hour {
			if err := updatecache.RemoveFlat(root, name, moduleCacheFile); err != nil {
				log.Printf("clean module stage: %v", err)
			}
		}
	}
	if pruneVersions {
		downloads, err := updatecache.Open(filepath.Join(directory, "downloads"))
		if err == nil {
			defer downloads.Close()
			entries, err := updatecache.Entries(downloads)
			if err == nil {
				for _, entry := range entries {
					info, err := downloads.Lstat(entry.Name())
					if err == nil && info.Mode().IsRegular() && moduleDownloadCopyName.MatchString(entry.Name()) && time.Since(info.ModTime()) >= 24*time.Hour {
						if err := downloads.Remove(entry.Name()); err != nil {
							log.Printf("clean module copy: %v", err)
						}
					}
				}
			}
		}
	}
}
