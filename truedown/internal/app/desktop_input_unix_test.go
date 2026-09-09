//go:build !windows

package app

import (
	"context"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"truedown/internal/desktopbridge"
)

type observedDesktopInput struct {
	*os.File
	reads chan struct{}
}

func (input observedDesktopInput) Read(buffer []byte) (int, error) {
	input.reads <- struct{}{}
	return input.File.Read(buffer)
}

func TestDesktopInputCancellationInterruptsInheritedBlockingPipe(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reader.Close(); writer.Close() })
	// A child receives a blocking descriptor, unlike a Go-created pollable pipe.
	fd, err := unix.Dup(int(reader.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	inherited := os.NewFile(uintptr(fd), "inherited-desktop-input")
	t.Cleanup(func() { inherited.Close() })
	input, err := desktopInput(inherited)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { input.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reads := make(chan struct{}, 4)
	done := make(chan error, 1)
	go func() {
		done <- desktopbridge.New(io.Discard, true).Serve(ctx, observedDesktopInput{input, reads},
			http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	}()
	if _, err := io.WriteString(writer, "{\"id\":1,\"method\":\"GET\",\"path\":\"/tasks\"}\n"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case <-reads:
		case <-time.After(3 * time.Second):
			t.Fatal("bridge did not return to reading its inherited pipe")
		}
	}
	// Leave the parent writer open, as the native shell does until the core exits.
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		writer.Close()
		<-done
		t.Fatal("cancellation waited for the native parent to close stdin")
	}
}
