package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"

	"truedown/internal/modulehost"
	"truedown/modules/mega/internal/mega"
)

// Both names belong to a private host-owned directory, never to remote metadata.
func transform(ctx context.Context, body json.RawMessage) (any, string) {
	var request struct {
		Source string `json:"source"`
		Size   int64  `json:"size"`
	}
	if modulehost.Decode(body, &request) != nil {
		return nil, "invalid_request"
	}
	link, err := mega.ParseLink(request.Source)
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
