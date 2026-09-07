package app

import (
	"flag"
	"fmt"
	"io"
)

type launchOptions struct {
	dataDir    string
	help       bool
	version    bool
	desktop    bool
	attachOnly bool
}

func parseLaunchOptions(args []string) (launchOptions, error) {
	options := launchOptions{}
	if len(args) > 0 && args[0] == "serve" {
		args = args[1:]
	}
	flags := flag.NewFlagSet("truedown-core", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&options.dataDir, "data-dir", "", "data directory")
	flags.BoolVar(&options.help, "help", false, "show usage")
	flags.BoolVar(&options.version, "version", false, "show version")
	flags.BoolVar(&options.desktop, "desktop-stdio", false, "private desktop transport")
	flags.BoolVar(&options.attachOnly, "desktop-attach-only", false, "reconnect an independent core only")
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
	if options.attachOnly && !options.desktop {
		return options, fmt.Errorf("desktop attachment requires the private desktop transport")
	}
	return options, nil
}

const launchUsage = `truedown-core [serve] [--data-dir PATH]

  serve       Run the core HTTP service in the foreground (default).
              Stop with Ctrl+C or truedown-cli exit.
  --data-dir  Use an explicit data directory (overrides TRUEDOWN_DATA_DIR).
  --version   Print version information.
  --help      Show this help.

Open TrueDown for the native desktop interface, or use truedown-cli --help
to manage downloads from the command line. Both share this service and database.
The default endpoint is http://127.0.0.1:15151.
`
