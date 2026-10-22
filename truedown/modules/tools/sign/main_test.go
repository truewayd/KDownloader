package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

func TestVerifyRebuiltManifest(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"id":"mediafire","version":"0.1.2","sha256":"rebuilt digest"}`)
	signature := ed25519.Sign(private, raw)
	if err := verifyManifest(raw, signature, raw, public); err != nil {
		t.Fatal(err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	for name, test := range map[string]struct {
		raw, signature, expected []byte
		key                      ed25519.PublicKey
	}{
		"different build or identity": {raw, signature, []byte(`{"id":"mega"}`), public},
		"changed manifest":            {append(append([]byte{}, raw...), ' '), signature, raw, public},
		"wrong publisher":             {raw, signature, raw, other},
		"truncated signature":         {raw, signature[:63], raw, public},
		"missing trust root":          {raw, signature, raw, nil},
	} {
		t.Run(name, func(t *testing.T) {
			if verifyManifest(test.raw, test.signature, test.expected, test.key) == nil {
				t.Fatal("invalid package accepted")
			}
		})
	}
}
