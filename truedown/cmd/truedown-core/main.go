// truedown-core is the console service entry point shared by external clients.
package main

import (
	"os"
	"truedown/internal/app"
	"truedown/internal/buildinfo"
)

func main() {
	os.Exit(app.Main(os.Args[1:], app.BuildInfo{Version: buildinfo.Version, BuildNumber: buildinfo.BuildNumber, Commit: buildinfo.Commit}))
}
