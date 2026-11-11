package profile

import (
	"path/filepath"
	"strings"
)

// Read the XDG assignment as data, never as a shell program.
func parseDownloadDirectory(data, home string) string {
	for _, line := range strings.Split(data, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || strings.TrimSpace(key) != "XDG_DOWNLOAD_DIR" {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) < 2 || value[0] != '"' || value[len(value)-1] != '"' {
			continue
		}
		// XDG uses shell double-quote escapes, not Go escape sequences.
		value = value[1:len(value)-1]
		var out strings.Builder
		valid := true
		for i := 0; i < len(value); i++ {
			if value[i] == '\\' && i+1 < len(value) && strings.ContainsRune("$`\"\\", rune(value[i+1])) {
				i++
				out.WriteByte(value[i])
				continue
			}
			if value[i] == '$' && (value[i:] == "$HOME" || strings.HasPrefix(value[i:], "$HOME/")) {
				out.WriteString(home)
				i += 4
				continue
			}
			if value[i] == '$' || value[i] == '`' || value[i] == '"' {
				valid = false
				break
			}
			out.WriteByte(value[i])
		}
		if valid && filepath.IsAbs(out.String()) {
			return filepath.Clean(out.String())
		}
	}
	return filepath.Join(home, "Downloads")
}
