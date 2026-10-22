package modulehost

// HTTPSource is a provider-normalized durable identity. Resolve does no network
// I/O, so a paused file can be admitted without contacting its hosting service.
type HTTPSource struct {
	Source string `json:"source"`
	Folder bool   `json:"folder"`
}

// PreparedHTTP is ephemeral. Neither its URL nor transport credentials are
// written into the durable source. The host owns transfer, resume and output.
type PreparedHTTP struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256,omitempty"`
}
