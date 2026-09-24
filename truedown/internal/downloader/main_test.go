package downloader

import (
	"fmt"
	"os"
	"testing"

	"truedown/internal/enginesignal"
)

func TestMain(m *testing.M) {
	if handled, err := enginesignal.RunHelper(os.Args[1:]); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
