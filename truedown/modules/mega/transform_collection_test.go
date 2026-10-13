package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"testing"

	"truedown/internal/modulehost"
	"truedown/modules/mega/internal/mega"
)

func TestZIPVerifiesEveryMACBeforeReportingSuccess(t *testing.T) {
	for _, damage := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "corrupt"}[damage], func(t *testing.T) {
			t.Chdir(t.TempDir())
			key, _ := hex.DecodeString("b0b0909070707093e957d163217c2f3fd4dbe2e9f0f7fe0675f47bd299c3e9f2")
			var link mega.Link
			copy(link.Key[:], key)
			plain := make([]byte, 151511)
			for i := range plain {
				plain[i] = byte(i % 255)
			}
			ciphertext := make([]byte, len(plain))
			stream, _ := link.Stream(0)
			stream.XORKeyStream(ciphertext, plain)
			if damage {
				ciphertext[100] ^= 1
			}
			if err := os.WriteFile(modulehost.CiphertextName(1), ciphertext, 0600); err != nil {
				t.Fatal(err)
			}
			data, _ := json.Marshal(mega.FileData{Node: "FILEAAAA", Key: base64.RawURLEncoding.EncodeToString(key), Name: "a.bin", Size: int64(len(plain))})
			collection := &modulehost.ArtifactCollection{Name: "root", Entries: []modulehost.ArtifactEntry{{Path: []string{"empty"}, Directory: true}, {Path: []string{"nested", "a.bin"}, Source: "https://mega.nz/folder/SHAREAAA#" + base64.RawURLEncoding.EncodeToString(make([]byte, 16)) + "/file/FILEAAAA", Size: int64(len(plain)), Data: data}}}
			body, _ := json.Marshal(map[string]any{"size": len(plain), "collection": collection})
			value, code := transform(context.Background(), body)
			if damage {
				if code != "integrity" || value != nil {
					t.Fatal("corrupt member reported a verified ZIP", code)
				}
				return
			}
			if code != "" {
				t.Fatal(code)
			}
			verified := value.(modulehost.VerifiedArtifact)
			payload, err := os.ReadFile("payload")
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256(payload)
			if verified.Size != int64(len(payload)) || verified.SHA256 != hex.EncodeToString(hash[:]) {
				t.Fatal("ZIP digest or size mismatch")
			}
			reader, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
			if err != nil || len(reader.File) != 2 {
				t.Fatal("invalid ZIP", err)
			}
			input, err := reader.File[1].Open()
			if err != nil {
				t.Fatal(err)
			}
			output, err := io.ReadAll(input)
			input.Close()
			if err != nil || !bytes.Equal(output, plain) || reader.File[0].Name != "empty/" || reader.File[1].Name != "nested/a.bin" {
				t.Fatal("wrong ZIP contents", err)
			}
		})
	}
}
