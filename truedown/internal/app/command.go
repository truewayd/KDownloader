package app

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"truedown/internal/systemupdate"
)

// Main adapts command-line flags and OS signals to the reusable service.
// Only the legacy entry point enables the updater's executable-replacement helper.
func Main(args []string, build BuildInfo, defaultMode string, legacyUpdates bool) int {
	if legacyUpdates {
		if handled, code := systemupdate.RunHelperIfRequested(args); handled {
			return code
		}
	}
	options, err := parseLaunchOptions(args)
	if len(args) == 0 || (args[0] != "ui" && args[0] != "serve" && args[0] != "background") {
		options.mode = defaultMode
	}
	if err != nil || options.help || options.version || options.mode == "serve" {
		attachParentConsole()
		log.SetOutput(os.Stderr)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if options.help {
		fmt.Print(launchUsage)
		fmt.Printf("\nThis entry point defaults to %s.\n", defaultMode)
		return 0
	}
	if options.version {
		fmt.Printf("TrueDown %s (build %s, commit %s)\n", build.Version, build.BuildNumber, build.Commit)
		return 0
	}
	if !legacyUpdates && options.mode != "serve" {
		fmt.Fprintln(os.Stderr, "truedown-core supports serve only; use TrueDown ui for the browser/tray launcher")
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	runtimeOptions := Options{Mode: options.mode, DataDir: options.dataDir, Build: build, RelaunchArgs: append([]string(nil), args...), LegacyUpdates: legacyUpdates}
	run := func() error { return Run(ctx, runtimeOptions) }
	if options.desktop {
		if legacyUpdates || options.mode != "serve" {
			fmt.Fprintln(os.Stderr, "private desktop transport requires truedown-core serve")
			return 2
		}
		run = func() error { return RunDesktop(ctx, runtimeOptions, os.Stdin, os.Stdout) }
	}
	if err := run(); err != nil {
		log.Printf("TrueDown stopped: %v", err)
		if options.mode == "ui" {
			showFatalError(err)
		}
		return 1
	}
	return 0
}
