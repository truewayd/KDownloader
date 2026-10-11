// TrueDown's MEGA adapter is built and shipped as its own executable.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"truedown/internal/modulehost"
	"truedown/modules/mega/internal/mega"
)

var version = "0.1.0"

type service struct {
	ctx    context.Context
	client *mega.Client
}

func publicError(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, mega.ErrSource):
		return "invalid_source"
	case errors.Is(err, mega.ErrIntegrity):
		return "integrity"
	case errors.Is(err, mega.ErrUnsupported):
		return "unsupported"
	case errors.Is(err, mega.ErrQuota):
		return "quota"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) || errors.Is(err, io.ErrShortWrite) {
		return "disk"
	}
	return "network"
}

func (s *service) handle(method string, body json.RawMessage) (any, string) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		return nil, "invalid_request"
	}
	switch method {
	case "hello":
		var request struct {
			Protocol int `json:"protocol"`
		}
		if modulehost.Decode(body, &request) != nil || request.Protocol != modulehost.ProtocolVersion {
			return nil, "unsupported"
		}
		return modulehost.Hello{Protocol: 1, ModuleID: "mega", Version: version, Capabilities: []string{"public-file", "aria2-artifact-v1"}}, ""
	case "transform":
		return transform(s.ctx, body)
	case "prepare", "resolve":
		var request struct {
			Source string  `json:"source"`
			Proxy  *string `json:"proxy,omitempty"`
		}
		if modulehost.Decode(body, &request) != nil {
			return nil, "invalid_request"
		}
		if request.Proxy != nil {
			if err := s.client.SetProxy(*request.Proxy); err != nil {
				return nil, "invalid_request"
			}
		}
		link, err := mega.ParseLink(request.Source)
		if err != nil {
			return nil, publicError(err)
		}
		metadata, err := s.client.Resolve(s.ctx, link)
		if err != nil {
			return nil, publicError(err)
		}
		if method == "resolve" {
			return metadata, ""
		}
		return modulehost.PreparedArtifact{Name: metadata.Name, Size: metadata.Size, URL: metadata.URL}, ""
	case "shutdown":
		var request struct{}
		if modulehost.Decode(body, &request) != nil {
			return nil, "invalid_request"
		}
		return struct{}{}, ""
	default:
		return nil, "unsupported"
	}
}

func run(input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithCancel(context.Background())
	readerDone := make(chan struct{})
	defer func() { close(readerDone); cancel() }()
	s := &service{ctx: ctx, client: mega.NewClient()}
	type incoming struct {
		request modulehost.Request
		err     error
	}
	requests := make(chan incoming, 1)
	// EOF cancels a currently running local transform even when the parent dies.
	go func() {
		for {
			var request modulehost.Request
			err := modulehost.ReadFrame(input, &request)
			if err != nil {
				cancel()
			}
			select {
			case requests <- incoming{request, err}:
			case <-readerDone:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	var session string
	var previous uint64
	for {
		message := <-requests
		if message.err != nil {
			if message.err == io.EOF {
				return nil
			}
			return modulehost.ErrProtocol
		}
		request := message.request
		if request.ID <= previous || len(request.Session) != 32 {
			return modulehost.ErrProtocol
		}
		for _, r := range request.Session {
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
				return modulehost.ErrProtocol
			}
		}
		if session == "" {
			if request.Method != "hello" {
				return modulehost.ErrProtocol
			}
			session = request.Session
		} else if request.Session != session || request.Method == "hello" {
			return modulehost.ErrProtocol
		}
		previous = request.ID
		value, code := s.handle(request.Method, request.Body)
		body, err := json.Marshal(value)
		if err != nil {
			return modulehost.ErrProtocol
		}
		if err := modulehost.WriteFrame(output, modulehost.Response{ID: request.ID, Session: session, Body: body, Error: code}); err != nil {
			return err
		}
		if request.Method == "shutdown" && code == "" {
			return nil
		}
	}
}

func main() {
	if len(os.Args) != 1 || run(os.Stdin, os.Stdout) != nil {
		os.Exit(2)
	}
}
