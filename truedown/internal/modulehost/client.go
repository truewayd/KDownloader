package modulehost

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"sync"
)

// Client serializes commands. An ambiguous/cancelled exchange closes the session;
// callers must reconcile durable state rather than replaying a start blindly.
// Launch/verification and process-tree ownership belong to the module installer.
type Client struct {
	input   io.WriteCloser
	output  io.ReadCloser
	command *exec.Cmd
	session string
	gate    chan struct{}
	closed  chan struct{}
	once    sync.Once
	wait    chan error
	next    uint64
	Info    Hello
}

// Connect starts an explicitly configured, caller-verified command. It never
// resolves a module name through PATH or accepts commands from frontend input.
func Connect(ctx context.Context, command *exec.Cmd, expectedID string) (*Client, error) {
	if expectedID == "" || command == nil || !filepath.IsAbs(command.Path) {
		return nil, ErrProtocol
	}
	input, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	// Upstream diagnostics can contain source keys. Do not forward raw stderr.
	command.Stderr = io.Discard
	configureProcess(command)
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		input.Close()
		output.Close()
		return nil, err
	}
	c := &Client{input: input, output: output, command: command,
		session: hex.EncodeToString(nonce[:]), gate: make(chan struct{}, 1),
		closed: make(chan struct{}), wait: make(chan error, 1)}
	if err := command.Start(); err != nil {
		input.Close()
		output.Close()
		return nil, err
	}
	// Wait only after the transport is closed, so it cannot close stdout while
	// the final response is still being read.
	go func() { <-c.closed; c.wait <- command.Wait() }()
	var hello Hello
	if err := c.Call(ctx, "hello", struct {
		Protocol int `json:"protocol"`
	}{ProtocolVersion}, &hello); err != nil {
		c.Close()
		return nil, err
	}
	if hello.Protocol != ProtocolVersion || hello.ModuleID != expectedID || hello.Version == "" || len(hello.Version) > 64 || len(hello.Capabilities) > 32 {
		c.Close()
		return nil, ErrProtocol
	}
	for _, capability := range hello.Capabilities {
		if len(capability) == 0 || len(capability) > 64 {
			c.Close()
			return nil, ErrProtocol
		}
	}
	c.Info = hello
	return c, nil
}

func (c *Client) Call(ctx context.Context, method string, body, result any) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	select {
	case c.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	case <-c.closed:
		return io.ErrClosedPipe
	}
	defer func() { <-c.gate }()
	select {
	case <-c.closed:
		return io.ErrClosedPipe
	default:
	}
	if !allowedMethod(method) {
		return ErrProtocol
	}
	data, err := json.Marshal(body)
	if err != nil || len(data) > MaxFrameBytes-1024 {
		return ErrProtocol
	}
	c.next++
	request := Request{ID: c.next, Session: c.session, Method: method, Body: data}
	type outcome struct {
		response Response
		err      error
	}
	done := make(chan outcome, 1)
	go func() {
		var response Response
		err := WriteFrame(c.input, request)
		if err == nil {
			err = ReadFrame(c.output, &response)
		}
		done <- outcome{response, err}
	}()
	select {
	case <-ctx.Done():
		c.Close()
		return ctx.Err()
	case <-c.closed:
		return io.ErrClosedPipe
	case out := <-done:
		if out.err != nil {
			c.Close()
			return ErrProtocol
		}
		r := out.response
		if r.ID != request.ID || r.Session != c.session {
			c.Close()
			return ErrProtocol
		}
		if r.Error != "" {
			// Only fixed public codes cross the diagnostics boundary.
			switch r.Error {
			case "invalid_source", "invalid_request", "unsupported", "unavailable", "network", "quota", "disk", "integrity", "busy", "cancelled", "timeout":
				return errors.New("module: " + r.Error)
			default:
				c.Close()
				return ErrProtocol
			}
		}
		if result != nil {
			if err := Decode(r.Body, result); err != nil {
				c.Close()
				return err
			}
		}
		return nil
	}
}

func allowedMethod(method string) bool {
	switch method {
	case "hello", "resolve", "prepare", "transform", "start", "snapshot", "pause", "resume", "cancel", "shutdown":
		return true
	default:
		return false
	}
}

func (c *Client) Close() error {
	c.once.Do(func() {
		close(c.closed)
		c.input.Close()
		c.output.Close()
		_ = c.command.Process.Kill()
	})
	return nil
}

// CloseAndWait retires the writer before its staging files may be reused.
func (c *Client) CloseAndWait(ctx context.Context) error {
	c.Close()
	select {
	case <-c.wait:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Shutdown requests graceful cleanup; the supplied deadline also bounds a peer
// that acknowledges shutdown but never exits.
func (c *Client) Shutdown(ctx context.Context) error {
	err := c.Call(ctx, "shutdown", struct{}{}, nil)
	if err != nil {
		c.Close()
		return err
	}
	c.once.Do(func() { c.input.Close(); c.output.Close(); close(c.closed) })
	select {
	case waitErr := <-c.wait:
		return waitErr
	case <-ctx.Done():
		_ = c.command.Process.Kill()
		return ctx.Err()
	}
}
