// truedown-core is the console service entry point shared by external clients.
package main

import (
	"os"
	"truedown/internal/app"
)

var (
	version     = "dev"
	buildNumber = "0"
	commit      = "unknown"
)

func main() {
	os.Exit(app.Main(os.Args[1:], app.BuildInfo{Version: version, BuildNumber: buildNumber, Commit: commit}, "serve", false))
}
