package profile

import "golang.org/x/sys/windows"

// DefaultDownloadDirectory honors the current user's Known Folder redirection.
func DefaultDownloadDirectory() (string, error) {
	return windows.KnownFolderPath(windows.FOLDERID_Downloads, 0)
}
