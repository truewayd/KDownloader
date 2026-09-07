package profile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"truedown/internal/safefile"
)

const migrationFile = "truedown.profile.migration.json"
const maxMigrationFileBytes int64 = 2 << 30

var legacyFiles = []string{Database, AuthSettings, Token, RuntimeSettings, DownloadRules, TaskDefaults, Modules, TrackerState, UpdateState, ApplicationLog, AriaLog, AriaConsoleLog}
var legacyDirectories = []string{ModulePackages, Engines, ResumeState, StagedUpdates}

func legacyNames() []string {
	names := append([]string{}, legacyDirectories...)
	for _, name := range legacyFiles {
		names = append(names, name)
		if name != Database {
			names = append(names, name+".bak")
		}
		if strings.HasSuffix(name, ".log") {
			for index := 1; index <= 3; index++ {
				names = append(names, fmt.Sprintf("%s.%d", name, index))
			}
		}
	}
	return append(names, Database+"-wal", Database+"-shm")
}

func legacyName(name string) bool {
	for _, candidate := range legacyNames() {
		if candidate == name {
			return true
		}
	}
	return false
}

func legacyTarget(paths Paths, name string) string {
	for _, base := range legacyFiles {
		if name == base || name == base+".bak" || (strings.HasSuffix(base, ".log") && strings.HasPrefix(name, base+".")) {
			return paths.File(base) + strings.TrimPrefix(name, base)
		}
	}
	return paths.File(name)
}

// Initialize must run while the caller holds the profile's process lock, before
// opening SQLite, log writers, engines or configuration stores. A failed copy
// leaves v0 authoritative. The durable layout file is the only commit point.
func Initialize(ctx context.Context, location Location, checkpoint func(string) error) (Location, error) {
	root := location.DataDirectory
	if state, err := readLayout(root); err == nil {
		if err := finishArchive(root, &state); err != nil {
			return location, err
		}
		location.Paths, location.LayoutVersion, location.Source = state.Paths, state.Version, state.Source
		return location, nil
	} else if !os.IsNotExist(err) {
		return location, err
	}
	paths, err := planPaths(root, location.Source)
	if err != nil {
		return location, err
	}
	state := layoutState{Version: 1, Source: location.Source, Paths: paths}
	ledger, err := safefile.InspectFile(filepath.Join(root, migrationFile), 64<<10)
	if err == nil {
		// A prior interrupted attempt owns only its recorded destination roles.
		saved, err := decodeLayout(root, ledger)
		if err != nil || saved.Backup != "" || len(saved.Pending) > 0 {
			return location, fmt.Errorf("invalid profile migration journal")
		}
		state, paths = saved, saved.Paths
	} else if !os.IsNotExist(err) {
		return location, err
	} else {
		for _, directory := range []string{paths.Config, paths.Data, paths.State, paths.Logs} {
			if err := emptyDestination(directory); err != nil {
				return location, err
			}
		}
		data, _ := json.Marshal(state)
		if err := safefile.WriteFile(filepath.Join(root, migrationFile), data, 0600); err != nil {
			return location, err
		}
	}
	for _, directory := range []string{paths.Config, paths.Data, paths.State, paths.Logs, paths.Cache} {
		if err := managedDirectory(directory); err != nil {
			return location, err
		}
	}
	if info, err := os.Lstat(filepath.Join(root, Database)); err == nil {
		if !info.Mode().IsRegular() {
			return location, fmt.Errorf("legacy database must be a regular file")
		}
		if checkpoint == nil {
			return location, fmt.Errorf("SQLite checkpoint is required for profile migration")
		}
		if err := checkpoint(filepath.Join(root, Database)); err != nil {
			return location, fmt.Errorf("checkpoint legacy database: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return location, err
	}
	if info, err := os.Lstat(filepath.Join(root, Database+"-wal")); err == nil && info.Size() > 0 {
		return location, fmt.Errorf("legacy database still has uncheckpointed WAL data")
	} else if err != nil && !os.IsNotExist(err) {
		return location, err
	}
	count := 0
	for _, name := range legacyNames() {
		source := filepath.Join(root, name)
		info, err := os.Lstat(source)
		if os.IsNotExist(err) {
			// A user may have resumed the old core between failed attempts.
			// Do not resurrect a removed secret/module from an earlier copy.
			if name != Database+"-wal" && name != Database+"-shm" {
				if err := removeUncommitted(ctx, legacyTarget(paths, name), &count); err != nil {
					return location, err
				}
			}
			continue
		}
		if err != nil {
			return location, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return location, fmt.Errorf("legacy profile entries must not be symlinks")
		}
		state.Pending = append(state.Pending, name)
		if name == Database+"-wal" || name == Database+"-shm" {
			continue
		}
		if err := copyEntry(ctx, source, legacyTarget(paths, name), &count); err != nil {
			return location, fmt.Errorf("migrate %s: %w", name, err)
		}
	}
	if err := ctx.Err(); err != nil {
		return location, err
	}
	if len(state.Pending) > 0 {
		state.Backup = filepath.Join(root, "profile-backup-v0")
		if err := emptyDestination(state.Backup); err != nil {
			return location, err
		}
		if err := managedDirectory(state.Backup); err != nil {
			return location, err
		}
	}
	if err := writeLayout(root, state); err != nil {
		return location, err
	}
	if err := finishArchive(root, &state); err != nil {
		return location, err
	}
	location.Paths, location.LayoutVersion, location.Source = state.Paths, 1, state.Source
	return location, nil
}

func emptyDestination(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if os.IsNotExist(err) && path == root {
			return nil
		}
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			return fmt.Errorf("profile migration destination already contains data: %s", path)
		}
		return nil
	})
}

func managedDirectory(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed profile directory is not a regular directory: %s", path)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(path, 0700)
}

func copyEntry(ctx context.Context, source, destination string, count *int) error {
	// Destination files are owned by the persisted, uncommitted journal.
	// Rebuild each subtree so deleted source children cannot survive a retry.
	if err := removeUncommitted(ctx, destination, count); err != nil {
		return err
	}
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		*count++
		if *count > 100000 {
			return fmt.Errorf("profile migration exceeds the file-count bound")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("profile migration does not follow symlinks")
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := destination
		if relative != "." {
			target = filepath.Join(destination, relative)
		}
		if entry.IsDir() {
			return managedDirectory(target)
		}
		return copyVerified(ctx, path, target)
	})
}

func removeUncommitted(ctx context.Context, root string, count *int) error {
	var paths []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if os.IsNotExist(err) && path == root {
			return nil
		}
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		*count++
		if *count > 100000 || entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !entry.Type().IsRegular()) {
			return fmt.Errorf("invalid uncommitted profile copy")
		}
		paths = append(paths, path)
		return nil
	})
	if err != nil {
		return err
	}
	for index := len(paths) - 1; index >= 0; index-- {
		if err := os.Remove(paths[index]); err != nil {
			return err
		}
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(data []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(data)
}

func copyVerified(ctx context.Context, source, destination string) (result error) {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > maxMigrationFileBytes {
		return fmt.Errorf("migration source is not a bounded regular file")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	opened, err := input.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return fmt.Errorf("migration source changed before copy")
	}
	if err := managedDirectory(filepath.Dir(destination)); err != nil {
		return err
	}
	output, err := os.CreateTemp(filepath.Dir(destination), ".profile-copy-*")
	if err != nil {
		return err
	}
	temporary := output.Name()
	defer func() { output.Close(); os.Remove(temporary) }()
	if err := output.Chmod(info.Mode().Perm() & 0700); err != nil {
		return err
	}
	digest := sha256.New()
	n, err := io.Copy(io.MultiWriter(output, digest), io.LimitReader(contextReader{ctx, input}, maxMigrationFileBytes+1))
	if err != nil {
		return err
	}
	after, err := input.Stat()
	if err != nil || n != info.Size() || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return fmt.Errorf("migration source changed during copy")
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	if existing, err := os.Lstat(destination); err == nil {
		if !existing.Mode().IsRegular() {
			return fmt.Errorf("migration destination must be a regular file")
		}
		// The journal was persisted before any copies; only uncommitted v1 files
		// are replaced. The old layout stays authoritative until all copies pass.
		if err := os.Remove(destination); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(temporary, destination); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		return err
	}
	verify, err := os.Open(destination)
	if err != nil {
		return err
	}
	defer verify.Close()
	actual := sha256.New()
	if _, err := io.Copy(actual, io.LimitReader(contextReader{ctx, verify}, maxMigrationFileBytes+1)); err != nil {
		return err
	}
	if hex.EncodeToString(actual.Sum(nil)) != hex.EncodeToString(digest.Sum(nil)) {
		return fmt.Errorf("profile migration checksum mismatch")
	}
	return nil
}

func finishArchive(root string, state *layoutState) error {
	if len(state.Pending) > 0 {
		if state.Backup != filepath.Join(root, "profile-backup-v0") {
			return fmt.Errorf("invalid profile backup directory")
		}
		if err := managedDirectory(state.Backup); err != nil {
			return err
		}
	}
	for _, name := range state.Pending {
		if !legacyName(name) || state.Backup != filepath.Join(root, "profile-backup-v0") {
			return fmt.Errorf("invalid profile archive")
		}
		source, destination := filepath.Join(root, name), filepath.Join(state.Backup, name)
		// Both paths are fixed descendants of the locked profile. Never move a
		// caller-supplied path or traverse a directory junction during cleanup.
		if err := contained(root, source); err != nil {
			return err
		}
		if err := contained(root, destination); err != nil {
			return err
		}
		info, err := os.Lstat(source)
		if os.IsNotExist(err) {
			if _, err := os.Lstat(destination); err != nil {
				return fmt.Errorf("profile backup is incomplete: %s", name)
			}
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("archive source became a symlink")
		}
		if _, err := os.Lstat(destination); !os.IsNotExist(err) {
			return fmt.Errorf("profile backup entry already exists: %s", name)
		}
		if err := os.Rename(source, destination); err != nil {
			return err
		}
	}
	if len(state.Pending) > 0 {
		if err := syncDirectory(state.Backup); err != nil {
			return err
		}
		if err := syncDirectory(root); err != nil {
			return err
		}
		state.Pending = nil
		if err := writeLayout(root, *state); err != nil {
			return err
		}
	}
	for _, name := range []string{migrationFile, migrationFile + ".bak"} {
		path := filepath.Join(root, name)
		if info, err := os.Lstat(path); err == nil {
			if !info.Mode().IsRegular() {
				return fmt.Errorf("migration journal must be regular")
			}
			if err := os.Remove(path); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func contained(root, path string) error {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("migration path escaped its profile")
	}
	return nil
}

func syncDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
