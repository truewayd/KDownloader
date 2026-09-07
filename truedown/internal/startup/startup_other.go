//go:build !windows

package startup

func New(dataDir string) *Manager {
	return &Manager{reason: "Automatic login startup is available on Windows. Use a user service to run TrueDown serve on this platform."}
}
