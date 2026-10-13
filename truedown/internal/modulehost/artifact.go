package modulehost

import "encoding/json"

// PreparedArtifact is a temporary transport plan, never a durable task identity.
type PreparedArtifact struct {
	Name string          `json:"name"`
	Size int64           `json:"size"`
	URL  string          `json:"url"`
	Data json.RawMessage `json:"data,omitempty"`
}

// Collection sources and opaque provider data stay in the private request.
// Names are relative, host-validated archive paths, never local input paths.
type ArtifactEntry struct {
	Source    string          `json:"source,omitempty"`
	Path      []string        `json:"path"`
	Size      int64           `json:"size"`
	Data      json.RawMessage `json:"data,omitempty"`
	Directory bool            `json:"directory,omitempty"`
}

type ArtifactCollection struct {
	Name    string          `json:"name"`
	Entries []ArtifactEntry `json:"entries"`
}

type CollectionPage struct {
	Name    string          `json:"name"`
	Entries []ArtifactEntry `json:"entries"`
	Total   int             `json:"total"`
	Next    int             `json:"next"`
}

type VerifiedArtifact struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
