package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"truedown/internal/modulehost"
	"truedown/modules/mediafire/internal/mediafire"
)

var version = "0.1.0"

type service struct {
	ctx                       context.Context
	client                    *mediafire.Client
	listedSource, listedProxy string
	listed                    modulehost.ArtifactCollection
}

func publicError(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, mediafire.ErrSource):
		return "invalid_source"
	case errors.Is(err, mediafire.ErrUnavailable):
		return "unavailable"
	case errors.Is(err, mediafire.ErrResponse):
		return "unsupported"
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
		return modulehost.Hello{Protocol: modulehost.ProtocolVersion, ModuleID: "mediafire", Version: version, Capabilities: []string{"http-resolver-v1", "public-folder-v1"}}, ""
	case "resolve":
		var request struct {
			Source string `json:"source"`
		}
		if modulehost.Decode(body, &request) != nil {
			return nil, "invalid_request"
		}
		source, err := mediafire.ParseSource(request.Source)
		if err != nil {
			return nil, publicError(err)
		}
		return source, ""
	case "prepare":
		var request struct {
			Source string `json:"source"`
			Proxy  string `json:"proxy"`
		}
		if modulehost.Decode(body, &request) != nil || s.client.SetProxy(request.Proxy) != nil {
			return nil, "invalid_request"
		}
		prepared, err := s.client.Prepare(s.ctx, request.Source)
		if err != nil {
			return nil, publicError(err)
		}
		return prepared, ""
	case "list":
		var request struct {
			Source string `json:"source"`
			Proxy  string `json:"proxy"`
			Offset int    `json:"offset"`
			Limit  int    `json:"limit"`
		}
		if modulehost.Decode(body, &request) != nil || request.Offset < 0 || request.Limit < 1 || request.Limit > 100 {
			return nil, "invalid_request"
		}
		if s.listedSource != request.Source || s.listedProxy != request.Proxy {
			if request.Offset != 0 || s.client.SetProxy(request.Proxy) != nil {
				return nil, "invalid_request"
			}
			listed, err := s.client.List(s.ctx, request.Source)
			if err != nil {
				return nil, publicError(err)
			}
			s.listed, s.listedSource, s.listedProxy = listed, request.Source, request.Proxy
		}
		if request.Offset > len(s.listed.Entries) {
			return nil, "invalid_request"
		}
		end := min(request.Offset+request.Limit, len(s.listed.Entries))
		next := end
		if next == len(s.listed.Entries) {
			next = -1
		}
		return modulehost.CollectionPage{Name: s.listed.Name, Entries: s.listed.Entries[request.Offset:end], Total: len(s.listed.Entries), Next: next}, ""
	case "shutdown":
		var request struct{}
		if modulehost.Decode(body, &request) != nil {
			return nil, "invalid_request"
		}
		return struct{}{}, ""
	}
	return nil, "unsupported"
}
func run(input io.Reader, output io.Writer) error {
	return modulehost.Serve(input, output, func(ctx context.Context) modulehost.Handler {
		return (&service{ctx: ctx, client: mediafire.NewClient()}).handle
	})
}
func main() {
	if len(os.Args) != 1 || run(os.Stdin, os.Stdout) != nil {
		os.Exit(2)
	}
}
