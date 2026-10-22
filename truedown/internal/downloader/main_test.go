package downloader

import (
	"fmt"
	"os"
	"testing"

	"truedown/internal/enginesignal"
)

func TestMain(m *testing.M) {
	if os.Getenv("TRUEDOWN_TEST_HTTP_MODULE_HELPER") == "1" {
		runHTTPModuleTestHelper()
		os.Exit(0)
	}
	if os.Getenv("TRUEDOWN_TEST_ARTIFACT_HELPER") == "1" {
		runArtifactTestHelper()
		os.Exit(0)
	}
	if handled, err := RunPathOpenHelper(os.Args[1:]); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if handled, err := enginesignal.RunHelper(os.Args[1:]); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if err := prepareDownloaderTestProcess(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}
