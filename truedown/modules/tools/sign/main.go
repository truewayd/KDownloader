// Command sign creates publisher keys and signed independent module manifests.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"truedown/internal/modulehost"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) == 3 && os.Args[1] == "keygen" {
		public, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		file, err := os.OpenFile(os.Args[2], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, err = file.WriteString(hex.EncodeToString(private.Seed()))
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		fmt.Println(hex.EncodeToString(public))
		return nil
	}
	if len(os.Args) != 8 || (os.Args[1] != "sign" && os.Args[1] != "verify") {
		return fmt.Errorf("usage: sign keygen PRIVATE_PATH | sign sign|verify BINARY ID VERSION OS ARCH MANIFEST_DIRECTORY")
	}
	file, err := os.Open(os.Args[2])
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(file, modulehost.MaxExecutableBytes+1))
	if err != nil {
		return err
	}
	if size <= 0 || size > modulehost.MaxExecutableBytes {
		return fmt.Errorf("invalid executable size")
	}
	if _, err := modulehost.Version(os.Args[4]); err != nil {
		return err
	}
	manifest := modulehost.ExecutableManifest{SchemaVersion: 1, ID: os.Args[3], Version: os.Args[4], OS: os.Args[5], Arch: os.Args[6], Protocol: modulehost.ProtocolVersion, Size: size, SHA256: hex.EncodeToString(hash.Sum(nil))}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if os.Args[1] == "verify" {
		existing, err := os.ReadFile(filepath.Join(os.Args[7], "executable.json"))
		if err != nil {
			return err
		}
		signature, err := os.ReadFile(filepath.Join(os.Args[7], "executable.sig"))
		if err != nil {
			return err
		}
		public, _ := hex.DecodeString(modulehost.PublisherPublicKey)
		return verifyManifest(existing, signature, raw, public)
	}
	seed, err := hex.DecodeString(os.Getenv("TRUEDOWN_MODULE_SIGNING_KEY"))
	if err != nil || len(seed) != ed25519.SeedSize {
		return fmt.Errorf("publisher signing key unavailable")
	}
	key := ed25519.NewKeyFromSeed(seed)
	if hex.EncodeToString(key.Public().(ed25519.PublicKey)) != modulehost.PublisherPublicKey {
		return fmt.Errorf("publisher signing key does not match the host trust root")
	}
	if err := os.MkdirAll(os.Args[7], 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(os.Args[7], "executable.json"), raw, 0644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(os.Args[7], "executable.sig"), ed25519.Sign(ed25519.NewKeyFromSeed(seed), raw), 0644)
}

// Compare the complete canonical manifest to the independently rebuilt binary
// and requested identity before accepting the publisher's signature.
func verifyManifest(raw, signature, expected []byte, public ed25519.PublicKey) error {
	if !bytes.Equal(raw, expected) || len(public) != ed25519.PublicKeySize || !ed25519.Verify(public, raw, signature) {
		return fmt.Errorf("publisher signature or reproducible build does not match")
	}
	return nil
}
