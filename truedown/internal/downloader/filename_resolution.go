package downloader

import (
	"context"
	"time"
)

// Resolver metadata is transient. Keep the existing local parser as the
// fallback for stable engines, older NEXT and unavailable optional RPCs.
func (m *Manager) resolveMetadataFilename(ctx context.Context, metadata *remoteMetadata) {
	resolver, ok := m.rpc.(interface {
		resolveFilename(context.Context, string, string) (string, error)
	})
	if !ok || metadata.ContentDisposition == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	name, err := resolver.resolveFilename(ctx, metadata.URL, metadata.ContentDisposition)
	if err == nil && name != "" {
		if safe := sanitizeModulePathComponent(name); safe != "" {
			metadata.Name = safe
		}
	}
}
