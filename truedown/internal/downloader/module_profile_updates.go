package downloader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
)

// Profiles are bounded declarative data from fixed repository releases. They
// cannot install executable code; executable modules retain signature checks.
func (m *Manager) updateResolverProfile(ctx context.Context, id string) (string, error) {
	client := moduleUpdateHTTPClient(m.ProxyForRequest)
	defer client.CloseIdleConnections()
	return m.updateResolverProfileWithClient(ctx, client, id)
}

func (m *Manager) updateResolverProfileWithClient(ctx context.Context, client *http.Client, id string) (string, error) {
	if id != GoogleDriveModuleID && id != DropboxModuleID {
		return "", &ValidationError{Message: "unknown resolver profile"}
	}
	m.modules.mu.RLock()
	current := m.modules.active[id]
	m.modules.mu.RUnlock()
	version, err := latestModuleVersion(ctx, client, id, current.packageInfo.Version)
	if err != nil || version == current.packageInfo.Version {
		return version, err
	}
	m.moduleUpdateMu.Lock()
	m.moduleUpdateState.Phase = "downloading"
	m.moduleUpdateMu.Unlock()
	base := moduleReleaseBase(id, version)
	raw, err := moduleFetch(ctx, client, base+id+".json", maxModulePackageBytes)
	if err != nil {
		return "", err
	}
	checksum, err := moduleFetch(ctx, client, base+id+".sha256", 128)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(raw)
	if strings.TrimSpace(string(checksum)) != hex.EncodeToString(hash[:]) {
		return "", fmt.Errorf("resolver profile checksum mismatch")
	}
	decoded, err := decodeComponent(m.modules.factories[id], raw, "updated")
	if err != nil {
		return "", err
	}
	if decoded.packageInfo.Version != version {
		return "", fmt.Errorf("resolver profile version differs from its release")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	m.moduleUpdateMu.Lock()
	m.moduleUpdateState.Phase = "installing"
	m.moduleUpdateMu.Unlock()
	installed, err := m.modules.installPackageAt(raw, current.digest)
	if err != nil {
		return "", err
	}
	return installed.Version, nil
}
