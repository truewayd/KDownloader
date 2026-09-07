package app

import "testing"

func TestCoreLaunchOptions(t *testing.T) {
	for _, tc := range []struct {
		args []string
		dir  string
	}{
		{nil, ""},
		{[]string{"serve"}, ""},
		{[]string{"serve", "--data-dir", "C:\\Download Data"}, "C:\\Download Data"},
		{[]string{"--data-dir", "/tmp/download data"}, "/tmp/download data"},
	} {
		t.Run(tc.dir, func(t *testing.T) {
			options, err := parseLaunchOptions(tc.args)
			if err != nil || options.dataDir != tc.dir {
				t.Fatalf("options = %+v, error = %v", options, err)
			}
		})
	}
	for _, args := range [][]string{{"ui"}, {"background"}, {"unknown"}, {"serve", "unexpected"}, {"--data-dir"}, {"--unknown"}, {"--desktop-attach-only"}} {
		if _, err := parseLaunchOptions(args); err == nil {
			t.Fatalf("accepted invalid arguments %q", args)
		}
	}
	if options, err := parseLaunchOptions([]string{"--desktop-stdio", "--desktop-attach-only"}); err != nil || !options.attachOnly || !options.desktop {
		t.Fatal("private reconnect flags", options, err)
	}
	for _, arg := range []string{"-h", "--help"} {
		options, err := parseLaunchOptions([]string{arg})
		if err != nil || !options.help {
			t.Fatalf("help %s: %+v, %v", arg, options, err)
		}
	}
}
