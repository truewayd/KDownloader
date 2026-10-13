package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"

	"truedown/internal/modulehost"
	"truedown/modules/mega/internal/mega"
)

// Both names belong to a private host-owned directory, never to remote metadata.
func transform(ctx context.Context, body json.RawMessage) (any, string) {
	var request struct {
		Source     string                         `json:"source"`
		Size       int64                          `json:"size"`
		Data       json.RawMessage                `json:"data,omitempty"`
		Collection *modulehost.ArtifactCollection `json:"collection,omitempty"`
	}
	if modulehost.Decode(body, &request) != nil {
		return nil, "invalid_request"
	}
	if request.Collection != nil {
		if size, err := modulehost.ValidateCollection(request.Collection); err != nil || size != request.Size {
			return nil, "invalid_request"
		}
		return transformCollection(ctx, request.Collection)
	}
	source, err := mega.ParseSource(request.Source)
	if err != nil {
		return nil, publicError(err)
	}
	link, _, err := mega.FileLink(source, request.Data)
	if err != nil {
		return nil, publicError(err)
	}
	before, err := os.Lstat("ciphertext")
	if err != nil || !before.Mode().IsRegular() || before.Size() != request.Size {
		return nil, "integrity"
	}
	input, err := os.Open("ciphertext")
	if err != nil {
		return nil, "disk"
	}
	defer input.Close()
	opened, err := input.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return nil, "integrity"
	}
	output, err := os.OpenFile("payload", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, "disk"
	}
	hash := sha256.New()
	err = mega.Decrypt(ctx, link, request.Size, input, io.MultiWriter(output, hash))
	if err == nil {
		err = output.Sync()
	}
	if closeErr := output.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, publicError(err)
	}
	return struct {
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	}{request.Size, hex.EncodeToString(hash.Sum(nil))}, ""
}

func transformCollection(ctx context.Context, collection *modulehost.ArtifactCollection) (any, string) {
	output, err := os.OpenFile("payload", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, "disk"
	}
	defer output.Close()
	hash := sha256.New()
	writer := zip.NewWriter(io.MultiWriter(output, hash))
	for index, entry := range collection.Entries {
		if ctx.Err() != nil {
			return nil, publicError(ctx.Err())
		}
		name := strings.Join(entry.Path, "/")
		header := &zip.FileHeader{Name: name, Method: zip.Store, Modified: time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)}
		header.SetMode(0600)
		if entry.Directory {
			header.Name += "/"
			header.SetMode(os.ModeDir | 0700)
		}
		destination, err := writer.CreateHeader(header)
		if err != nil {
			return nil, "disk"
		}
		if entry.Directory {
			continue
		}
		source, err := mega.ParseSource(entry.Source)
		if err != nil {
			return nil, publicError(err)
		}
		link, file, err := mega.FileLink(source, entry.Data)
		if err != nil || file.Size != entry.Size || file.Name != entry.Path[len(entry.Path)-1] {
			return nil, "invalid_source"
		}
		name = modulehost.CiphertextName(index)
		before, err := os.Lstat(name)
		if err != nil || !before.Mode().IsRegular() || before.Size() != entry.Size {
			return nil, "integrity"
		}
		input, err := os.Open(name)
		if err != nil {
			return nil, "disk"
		}
		opened, err := input.Stat()
		if err == nil && os.SameFile(before, opened) {
			err = mega.Decrypt(ctx, link, entry.Size, input, destination)
		} else {
			err = mega.ErrIntegrity
		}
		input.Close()
		if err != nil {
			return nil, publicError(err)
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "disk"
	}
	if err := output.Sync(); err != nil {
		return nil, "disk"
	}
	info, err := output.Stat()
	if err != nil {
		return nil, "disk"
	}
	if err := output.Close(); err != nil {
		return nil, "disk"
	}
	return modulehost.VerifiedArtifact{Size: info.Size(), SHA256: hex.EncodeToString(hash.Sum(nil))}, ""
}
