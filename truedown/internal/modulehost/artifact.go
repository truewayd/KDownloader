package modulehost

// PreparedArtifact is a temporary transport plan, never a durable task identity.
type PreparedArtifact struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	URL  string `json:"url"`
}

type VerifiedArtifact struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
