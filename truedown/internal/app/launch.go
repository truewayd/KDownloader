package app

import (
	"flag"
	"fmt"
	"io"
)

type launchOptions struct {
	mode    string
	dataDir string
	help    bool
	version bool
}

func parseLaunchOptions(args []string) (launchOptions, error) {
	options := launchOptions{mode: "ui"}
	if len(args) > 0 && (args[0] == "ui" || args[0] == "serve" || args[0] == "background") {
		options.mode, args = args[0], args[1:]
	}
	flags := flag.NewFlagSet("TrueDown", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&options.dataDir, "data-dir", "", "data directory")
	flags.BoolVar(&options.help, "help", false, "show usage")
	flags.BoolVar(&options.version, "version", false, "show version")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			options.help = true
		} else {
			return options, err
		}
	}
	if flags.NArg() != 0 {
		return options, fmt.Errorf("unknown command or argument %q; use --help", flags.Arg(0))
	}
	return options, nil
}

const launchUsage = `TrueDown [ui|serve|background] [--data-dir PATH]

  ui          Start the service and open its dashboard (default).
              If it is already running, open the existing dashboard.
  serve       Run the core HTTP service in the foreground, without a tray
              or browser. Stop with Ctrl+C or POST /system/exit.
  background  Run without opening a browser; use the Windows tray to open UI.
              On Linux/macOS this remains a foreground service.
  --data-dir  Use an explicit data directory (overrides TRUEDOWN_DATA_DIR).
  --version   Print version information.
  --help      Show this help.

All modes share the same download core, API and persistent task database.
The default endpoint is http://127.0.0.1:15151.
`
