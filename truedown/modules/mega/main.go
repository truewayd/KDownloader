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

var version = "0.2.0"

type service struct {
	ctx          context.Context
	client       *mega.Client
	listedSource string
	listed       modulehost.ArtifactCollection
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
		return modulehost.Hello{Protocol: 1, ModuleID: "mega", Version: version, Capabilities: []string{"public-file", "public-folder-v1", "folder-zip-v1", "aria2-artifact-v1"}}, ""
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
		if s.listedSource != request.Source {
			if request.Offset != 0 {
				return nil, "invalid_request"
			}
			if err := s.client.SetProxy(request.Proxy); err != nil {
				return nil, "invalid_request"
			}
			source, err := mega.ParseSource(request.Source)
			if err != nil {
				return nil, publicError(err)
			}
			s.listed, err = s.client.ListFolder(s.ctx, source)
			if err != nil {
				return nil, publicError(err)
			}
			s.listedSource = request.Source
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
	case "transform":
		return transform(s.ctx, body)
	case "prepare", "resolve":
		var request struct {
			Source string          `json:"source"`
			Proxy  *string         `json:"proxy,omitempty"`
			Data   json.RawMessage `json:"data,omitempty"`
		}
		if modulehost.Decode(body, &request) != nil {
			return nil, "invalid_request"
		}
		if request.Proxy != nil {
			if err := s.client.SetProxy(*request.Proxy); err != nil {
				return nil, "invalid_request"
			}
		}
		source, err := mega.ParseSource(request.Source)
		if err != nil {
			return nil, publicError(err)
		}
		metadata, data, err := s.client.ResolveFile(s.ctx, source, request.Data)
		if err != nil {
			return nil, publicError(err)
		}
		if method == "resolve" {
			return metadata, ""
		}
		return modulehost.PreparedArtifact{Name: metadata.Name, Size: metadata.Size, URL: metadata.URL, Data: data}, ""
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
	return modulehost.Serve(input, output, func(ctx context.Context) modulehost.Handler {
		return (&service{ctx: ctx, client: mega.NewClient()}).handle
	})
}

func main() {
	if len(os.Args) != 1 || run(os.Stdin, os.Stdout) != nil {
		os.Exit(2)
	}
}
