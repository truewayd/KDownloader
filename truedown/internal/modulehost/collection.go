package modulehost

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Flat private ciphertext names never derive from a remote filename.
func CiphertextName(index int) string { return fmt.Sprintf("ciphertext-%06d", index) }

func ValidCollectionName(name string) bool {
	if name == "" || len(name) > 255 || !utf8.ValidString(name) || name == "." || name == ".." || strings.TrimRight(name, ". ") != name {
		return false
	}
	for _, r := range name {
		if r < 32 || r == 127 || strings.ContainsRune(`/\\<>:"|?*`, r) {
			return false
		}
	}
	stem := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" {
		return false
	}
	if len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && stem[3] >= '1' && stem[3] <= '9' {
		return false
	}
	return true
}

// Validate paths before admitting any transfer or opening an archive writer.
// Case-insensitive collisions are rejected on every platform.
func ValidateCollection(collection *ArtifactCollection) (int64, error) {
	if collection == nil || !ValidCollectionName(collection.Name) || len(collection.Entries) > 6000 {
		return 0, fmt.Errorf("invalid collection")
	}
	paths, explicit := map[string]bool{}, map[string]bool{}
	var total int64
	files, directories := 0, 0
	for _, entry := range collection.Entries {
		if len(entry.Path) == 0 || len(entry.Path) > 64 || entry.Size < 0 || entry.Size > 1<<50 {
			return 0, fmt.Errorf("invalid collection entry")
		}
		for _, component := range entry.Path {
			if !ValidCollectionName(component) {
				return 0, fmt.Errorf("unsafe collection path")
			}
		}
		path := strings.ToLower(strings.Join(entry.Path, "/"))
		if len(path) > 4096 || explicit[path] {
			return 0, fmt.Errorf("duplicate collection path")
		}
		if kind, found := paths[path]; found && (!kind || !entry.Directory) {
			return 0, fmt.Errorf("collection path collision")
		}
		explicit[path], paths[path] = true, entry.Directory
		for length := 1; length < len(entry.Path); length++ {
			parent := strings.ToLower(strings.Join(entry.Path[:length], "/"))
			if kind, found := paths[parent]; found && !kind {
				return 0, fmt.Errorf("collection file is a parent directory")
			}
			paths[parent] = true
		}
		if entry.Directory {
			directories++
			if entry.Size != 0 || entry.Source != "" || len(entry.Data) != 0 {
				return 0, fmt.Errorf("invalid directory entry")
			}
		} else {
			files++
			if entry.Source == "" || len(entry.Source) > 16384 || len(entry.Data) == 0 || len(entry.Data) > 16384 || !json.Valid(entry.Data) {
				return 0, fmt.Errorf("invalid file entry")
			}
			total += entry.Size
			if total > 1<<50 {
				return 0, fmt.Errorf("collection exceeds size limit")
			}
		}
	}
	if files > 5000 || directories > 1000 {
		return 0, fmt.Errorf("collection exceeds entry limit")
	}
	encoded, err := json.Marshal(collection)
	if err != nil || len(encoded) > 768*1024 {
		return 0, fmt.Errorf("collection exceeds protocol limit")
	}
	return total, nil
}
