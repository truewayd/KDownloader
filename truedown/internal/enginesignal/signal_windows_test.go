//go:build windows

package enginesignal

import (
	"os"
	"strconv"
	"testing"
)

func TestHelperRejectsInvalidTargets(t *testing.T) {
	for _, args := range [][]string{
		{helperFlag}, {helperFlag, "0"}, {helperFlag, "-1"},
		{helperFlag, "4294967296"}, {helperFlag, strconv.Itoa(os.Getpid())},
		{helperFlag, "1", "extra"},
	} {
		if handled, err := RunHelper(args); !handled || err == nil {
			t.Fatalf("RunHelper(%q) = %v, %v", args, handled, err)
		}
	}
	if handled, err := RunHelper([]string{"--version"}); handled || err != nil {
		t.Fatalf("ordinary launch was intercepted: %v, %v", handled, err)
	}
	if err := Interrupt(nil); err == nil {
		t.Fatal("missing process was accepted")
	}
}
