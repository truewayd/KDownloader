package downloader

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
)

const fileGroupsSchemaVersion = 2
const maxFileGroupsRevision uint64 = 1<<53 - 1

// Disk data has one identity key and one ordering authority. UI icon catalogs
// and derived suffix indexes belong only to runtime snapshots.
type fileGroupDefinition struct {
	Name       string   `json:"name"`
	Icon       string   `json:"icon"`
	Directory  string   `json:"directory"`
	Extensions []string `json:"extensions"`
}

type fileGroupsDocument struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Revision      uint64               `json:"revision"`
	Order         []string             `json:"order"`
	GroupsByID    fileGroupDefinitions `json:"groupsById"`
}

type fileGroupDefinitions map[string]fileGroupDefinition

func (groups *fileGroupDefinitions) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return fmt.Errorf("file group definitions must be an object")
	}
	definitions := make(fileGroupDefinitions)
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return err
		}
		id, ok := key.(string)
		if !ok {
			return fmt.Errorf("invalid file group ID")
		}
		if _, exists := definitions[id]; exists {
			return fmt.Errorf("duplicate file group ID %q", id)
		}
		var definition fileGroupDefinition
		if err := decoder.Decode(&definition); err != nil {
			return err
		}
		definitions[id] = definition
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	*groups = definitions
	return nil
}

func encodeFileGroups(state FileGroupsSnapshot) ([]byte, error) {
	if state.Revision > maxFileGroupsRevision {
		return nil, &ValidationError{Message: "file group revision is out of range"}
	}
	groups, err := normalizeFileGroups(state.Groups)
	if err != nil {
		return nil, err
	}
	document := fileGroupsDocument{
		SchemaVersion: fileGroupsSchemaVersion, Revision: state.Revision,
		Order: make([]string, 0, len(groups)), GroupsByID: make(map[string]fileGroupDefinition, len(groups)),
	}
	for _, group := range groups {
		document.Order = append(document.Order, group.ID)
		document.GroupsByID[group.ID] = fileGroupDefinition{group.Name, group.Icon, group.Directory, group.Extensions}
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(data) >= maxFileGroupsBytes {
		return nil, &ValidationError{Message: "file group configuration is too large"}
	}
	return append(data, '\n'), nil
}

func readFileGroups(path string) (FileGroupsSnapshot, error) {
	var document fileGroupsDocument
	err := readStrictJSONFile(path, maxFileGroupsBytes, &document)
	if os.IsNotExist(err) {
		state := defaultFileGroups()
		data, err := encodeFileGroups(state)
		if err == nil {
			err = writeConfigFile(path, data)
		}
		return state, err
	}
	if err != nil {
		return FileGroupsSnapshot{}, fmt.Errorf("read file groups: %w", err)
	}
	if document.SchemaVersion != fileGroupsSchemaVersion || document.Revision > maxFileGroupsRevision {
		return FileGroupsSnapshot{}, fmt.Errorf("unsupported file group schema or revision")
	}
	if len(document.Order) < 1 || len(document.Order) > 32 || len(document.GroupsByID) != len(document.Order) {
		return FileGroupsSnapshot{}, fmt.Errorf("file group order must include every group exactly once")
	}
	state := FileGroupsSnapshot{Revision: document.Revision}
	seen := make(map[string]bool, len(document.Order))
	for _, id := range document.Order {
		group, exists := document.GroupsByID[id]
		if !exists || seen[id] {
			return FileGroupsSnapshot{}, fmt.Errorf("file group order contains an unknown or repeated ID")
		}
		if group.Icon == "" || group.Directory == "" || group.Extensions == nil {
			return FileGroupsSnapshot{}, fmt.Errorf("file group definition requires icon, directory and extensions")
		}
		seen[id] = true
		state.Groups = append(state.Groups, FileGroup{id, group.Name, group.Extensions, group.Icon, group.Directory})
	}
	state.Groups, err = normalizeFileGroups(state.Groups)
	return state, err
}
