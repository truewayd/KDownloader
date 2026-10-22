package modulehost

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSignedModuleInstallationRejectsTamperingAndRollback(t *testing.T) {
	for _, id := range []string{"mega", "mediafire"} {
		t.Run(id, func(t *testing.T) { testSignedModuleInstallation(t, id) })
	}
}
func testSignedModuleInstallation(t *testing.T, id string) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	data := []byte("signed module fixture")
	hash := sha256.Sum256(data)
	manifest := ExecutableManifest{SchemaVersion: 1, ID: id, Version: "0.2.0", OS: runtime.GOOS, Arch: runtime.GOARCH, Protocol: 1, Size: int64(len(data)), SHA256: hex.EncodeToString(hash[:])}
	raw, _ := json.Marshal(manifest)
	signature := ed25519.Sign(private, raw)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name                   string
		raw, signature, binary []byte
		current                string
	}{
		{"signature", raw, make([]byte, 64), data, "0.1.0"},
		{"payload", raw, signature, []byte("modified"), "0.1.0"},
		{"truncated", raw, signature, data[:len(data)-1], "0.1.0"},
		{"excess", raw, signature, append(append([]byte{}, data...), 0), "0.1.0"},
		{"rollback", raw, signature, data, "0.3.0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := InstallSigned(root, id, test.current, test.raw, test.signature, public, bytes.NewReader(test.binary)); err == nil {
				t.Fatal("invalid update installed")
			}
			entries, _ := os.ReadDir(root)
			if len(entries) != 0 {
				t.Fatal("failed update left install candidate")
			}
		})
	}
	path, err := InstallSigned(root, id, "0.1.0", raw, signature, public, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(actual, data) {
		t.Fatal("binary changed")
	}
	if filepath.Dir(path) != filepath.Join(root, "0.2.0") {
		t.Fatal("version directory mismatch")
	}
	if recovered, err := InstallSigned(root, id, "0.1.0", raw, signature, public, bytes.NewReader(data)); err != nil || recovered != path {
		t.Fatal("identical interrupted activation was not recoverable")
	}
	if err := os.WriteFile(path, []byte("tampered"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallSigned(root, id, "0.1.0", raw, signature, public, bytes.NewReader(data)); err == nil {
		t.Fatal("tampered immutable version accepted")
	}
}
