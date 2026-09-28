// A hidden Windows GUI fixture; never opens an application window.
package main

import (
	"os"
	"path/filepath"
	"time"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		return
	}
	directory := filepath.Dir(executable)
	if os.WriteFile(filepath.Join(directory, "started"), []byte("ready"), 0600) != nil {
		return
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(directory, "parent-exited")); err == nil {
			_ = os.WriteFile(filepath.Join(directory, "survived"), []byte("ready"), 0600)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}
