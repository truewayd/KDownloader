package app

import "testing"

func TestLaunchModes(t *testing.T) {
	for _, tc := range []struct {
		args []string
		mode string
		dir  string
	}{
		{nil, "ui", ""},
		{[]string{"ui"}, "ui", ""},
		{[]string{"serve", "--data-dir", "C:\\Download Data"}, "serve", "C:\\Download Data"},
		{[]string{"background", "--data-dir", "/tmp/download data"}, "background", "/tmp/download data"},
	} {
		t.Run(tc.mode+tc.dir, func(t *testing.T) {
			options, err := parseLaunchOptions(tc.args)
			if err != nil || options.mode != tc.mode || options.dataDir != tc.dir {
				t.Fatalf("options = %+v, error = %v", options, err)
			}
		})
	}
	for _, args := range [][]string{{"unknown"}, {"serve", "unexpected"}, {"--data-dir"}, {"--unknown"}} {
		if _, err := parseLaunchOptions(args); err == nil {
			t.Fatalf("accepted invalid arguments %q", args)
		}
	}
	for _, arg := range []string{"-h", "--help"} {
		options, err := parseLaunchOptions([]string{arg})
		if err != nil || !options.help {
			t.Fatalf("help %s: %+v, %v", arg, options, err)
		}
	}
}
