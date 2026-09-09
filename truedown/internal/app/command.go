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
func Main(args []string, build BuildInfo) int {
	if handled, code := systemupdate.RunNativeHelperIfRequested(args); handled {
		return code
	}
	options, err := parseLaunchOptions(args)
	log.SetOutput(os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if options.help {
		fmt.Print(launchUsage)
		return 0
	}
	if options.version {
		fmt.Printf("TrueDown %s (build %s, commit %s)\n", build.Version, build.BuildNumber, build.Commit)
		return 0
	}
	if err := protectCoreProcess(); err != nil {
		log.Printf("cannot establish core process ownership: %v", err)
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	runtimeOptions := Options{DataDir: options.dataDir, Build: build, RelaunchArgs: append([]string(nil), args...), DesktopAttachOnly: options.attachOnly}
	run := func() error { return Run(ctx, runtimeOptions) }
	if options.desktop {
		input, err := desktopInput(os.Stdin)
		if err != nil {
			log.Printf("cannot prepare desktop transport: %v", err)
			return 1
		}
		defer input.Close()
		run = func() error { return RunDesktop(ctx, runtimeOptions, input, os.Stdout) }
	}
	if err := run(); err != nil {
		log.Printf("TrueDown stopped: %v", err)
		return 1
	}
	return 0
}
