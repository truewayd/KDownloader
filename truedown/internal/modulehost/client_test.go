package modulehost

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestFrameRejectsAmbiguousAndOversizedInput(t *testing.T) {
	for _, raw := range []string{
		`{"id":1,"id":2}`, `{"body":{"key":1,"key":2}}`,
		`{"id":1,"ID":2}`,
		`{"unknown":true}`, `{} {}`, strings.Repeat("[", 35) + strings.Repeat("]", 35),
	} {
		t.Run(raw[:min(len(raw), 24)], func(t *testing.T) {
			var response Response
			if err := Decode([]byte(raw), &response); err == nil {
				t.Fatal("accepted ambiguous JSON")
			}
		})
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], MaxFrameBytes+1)
	var response Response
	if !errors.Is(ReadFrame(bytes.NewReader(header[:]), &response), ErrProtocol) {
		t.Fatal("accepted oversized frame")
	}
	binary.BigEndian.PutUint32(header[:], 20)
	if !errors.Is(ReadFrame(bytes.NewReader(header[:]), &response), io.EOF) {
		t.Fatal("accepted truncated frame")
	}
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) { return w.Buffer.Write(p[:min(3, len(p))]) }

func TestFrameHandlesPartialWrites(t *testing.T) {
	var wire shortWriter
	want := Request{ID: 12, Session: "test", Method: "resolve", Body: json.RawMessage(`{"source":"https://example.org/#private"}`)}
	if err := WriteFrame(&wire, want); err != nil {
		t.Fatal(err)
	}
	var got Request
	if err := ReadFrame(&wire, &got); err != nil {
		t.Fatal(err)
	}
	if got.ID != want.ID || !bytes.Equal(got.Body, want.Body) {
		t.Fatalf("bad round trip: %+v", got)
	}
}

func helperClient(t *testing.T, mode string) (*Client, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestModuleProcess$")
	command.Env = append(os.Environ(), "TRUEDOWN_MODULE_TEST="+mode)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return Connect(ctx, command, "fixture")
}

func TestClientHandshakeControlAndShutdown(t *testing.T) {
	c, err := helperClient(t, "normal")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var value struct {
		State string `json:"state"`
	}
	if err := c.Call(ctx, "snapshot", struct{}{}, &value); err != nil || value.State != "idle" {
		t.Fatalf("snapshot: %v, %+v", err, value)
	}
	if err := c.Call(ctx, "execute-shell", struct{}{}, nil); !errors.Is(err, ErrProtocol) {
		t.Fatal("accepted arbitrary method")
	}
	if err := c.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestClientRejectsWrongHandshakeAndSession(t *testing.T) {
	for _, mode := range []string{"wrong-version", "wrong-module", "wrong-session", "wrong-id"} {
		t.Run(mode, func(t *testing.T) {
			c, err := helperClient(t, mode)
			if c != nil {
				c.Close()
			}
			if !errors.Is(err, ErrProtocol) {
				t.Fatalf("accepted peer: %v", err)
			}
		})
	}
}

func TestClientTimeoutKillsAmbiguousPeer(t *testing.T) {
	c, err := helperClient(t, "hang")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if err := c.Call(ctx, "start", struct{}{}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout: %v", err)
	}
	select {
	case <-c.wait:
	case <-time.After(3 * time.Second):
		t.Fatal("peer survived cancelled operation")
	}
	if err := c.Call(context.Background(), "start", struct{}{}, nil); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("ambiguous start was replayable: %v", err)
	}
}

func TestClientDoesNotExposeProviderDiagnostics(t *testing.T) {
	c, err := helperClient(t, "secret-error")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = c.Call(ctx, "start", struct{}{}, nil)
	if !errors.Is(err, ErrProtocol) || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatalf("unsafe error: %v", err)
	}
}

func TestClientShutdownDeadlineKillsPeer(t *testing.T) {
	c, err := helperClient(t, "hang-exit")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if err := c.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown: %v", err)
	}
	select {
	case <-c.wait:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown left peer running")
	}
}

func TestModuleProcess(t *testing.T) {
	mode := os.Getenv("TRUEDOWN_MODULE_TEST")
	if mode == "" {
		return
	}
	for {
		var request Request
		if ReadFrame(os.Stdin, &request) != nil {
			os.Exit(0)
		}
		response := Response{ID: request.ID, Session: request.Session, Body: json.RawMessage(`{}`)}
		if request.Method == "hello" {
			hello := Hello{Protocol: ProtocolVersion, ModuleID: "fixture", Version: "0.1.0", Capabilities: []string{"snapshot"}}
			switch mode {
			case "wrong-version":
				hello.Protocol++
			case "wrong-module":
				hello.ModuleID = "unexpected"
			case "wrong-session":
				response.Session = "other-session"
			case "wrong-id":
				response.ID++
			}
			response.Body, _ = json.Marshal(hello)
		} else {
			if mode == "hang" {
				time.Sleep(time.Minute)
			}
			if mode == "secret-error" {
				response.Error = "PRIVATE SOURCE KEY"
			}
			if request.Method == "snapshot" {
				response.Body = json.RawMessage(`{"state":"idle"}`)
			}
		}
		if WriteFrame(os.Stdout, response) != nil {
			os.Exit(2)
		}
		if request.Method == "shutdown" {
			if mode == "hang-exit" {
				time.Sleep(time.Minute)
			}
			os.Exit(0)
		}
	}
}
