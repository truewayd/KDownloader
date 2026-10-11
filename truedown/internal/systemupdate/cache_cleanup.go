package systemupdate

import (
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"truedown/internal/updatecache"
)

var abandonedStageName = regexp.MustCompile(`^native-build-[1-9][0-9]*-[0-9]+$`)
var abandonedCopyName = regexp.MustCompile(`^\.download-[0-9]+\.tmp$`)
var abandonedTransactionName = regexp.MustCompile(`^(native-apply-[0-9a-f]{48}\.json|native-health-[0-9a-f]{48})$`)

// Hold the update gate throughout pruning so a new stage/switch cannot race
// the retention snapshot. Transaction recovery always takes precedence.
func (m *Manager) cleanupUpdateCache() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.busy != "" || m.applyLaunched {
		return
	}
	if _, err := os.Lstat(filepath.Join(m.baseDir, nativeMarkerName)); !os.IsNotExist(err) {
		return
	}
	keep := map[string]bool{m.active.File: true}
	for _, engine := range []*installedEngine{m.state.NextEngine, m.state.PreviousNextEngine} {
		if engine != nil {
			keep[engine.File] = true
		}
	}
	// Unfinished download receipts must remain verifiable on the next pass.
	// This method is called only after cleanupUpdateDownloads releases its gate.
	entries, err := m.readUpdateDownloads()
	if err != nil {
		log.Printf("read update cache receipts: %v", err)
		return
	}
	for _, entry := range entries {
		if entry.Build == 0 {
			keep[entry.Name] = true
		}
	}
	for _, directory := range []string{m.updatesDir, m.enginesDir} {
		root, err := updatecache.Open(directory)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			log.Printf("open update cache: %v", err)
			continue
		}
		listing, err := updatecache.Entries(root)
		if err != nil {
			root.Close()
			log.Printf("list update cache: %v", err)
			continue
		}
		for _, entry := range listing {
			info, err := root.Lstat(entry.Name())
			if err != nil || m.now().Sub(info.ModTime()) < 24*time.Hour {
				continue
			}
			name := entry.Name()
			ownedHelper := directory == m.updatesDir && (updateHelperPattern.MatchString(name) || nativeHelperPattern.MatchString(name) || abandonedTransactionName.MatchString(name))
			if info.Mode().IsRegular() && (abandonedCopyName.MatchString(name) || ownedHelper || (directory == m.enginesDir && nextDownloadName.MatchString(name) && !keep[name])) {
				err = root.Remove(name)
			} else if directory == m.updatesDir && abandonedStageName.MatchString(name) && (m.state.PendingUpdate == nil || !strings.EqualFold(m.state.PendingUpdate.File, name)) {
				err = updatecache.RemoveFlat(root, name, func(file string) bool {
					for _, expected := range nativeNames {
						if file == expected {
							return true
						}
					}
					return false
				})
			}
			if err != nil {
				log.Printf("clean update cache %s: %v", name, err)
			}
		}
		root.Close()
	}
}
