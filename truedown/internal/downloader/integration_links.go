package downloader

import (
	"context"
	"net/url"
)

// ResolveIntegrationLink never falls back to downloading a sharing page.
func (m *Manager) ResolveIntegrationLink(ctx context.Context, link string) (ModuleAddResult, string) {
	parsed, err := url.Parse(link)
	if err != nil || len(link) > 8192 || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" {
		return ModuleAddResult{}, "unsupported"
	}
	module, err := m.modules.selectModule(link, nil)
	if err != nil {
		return ModuleAddResult{}, "unavailable"
	}
	if module == nil {
		for _, id := range []string{DropboxModuleID, GoogleDriveModuleID, MediaFireModuleID} {
			if candidate := m.modules.module(id); candidate != nil && candidate.matches(link) {
				m.recordModuleIssue(id)
				return ModuleAddResult{ModuleID: id}, "disabled"
			}
		}
		return ModuleAddResult{}, "unsupported"
	}
	id := module.info().ID
	if id != DropboxModuleID && id != GoogleDriveModuleID && id != MediaFireModuleID {
		return ModuleAddResult{}, "unsupported"
	}
	// Keep the immutable module selected above across concurrent enablement changes.
	result, handled, err := module.resolve(ctx, m, moduleResolveRequest{Link: link})
	result.ModuleID = id
	if err != nil || !handled || (len(result.Tasks) == 0 && result.Filtered == 0) {
		if ctx.Err() == nil || ctx.Err() == context.DeadlineExceeded {
			m.recordModuleIssue(id)
		}
		return result, "failed"
	}
	return result, ""
}
