package mega

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"testing"
)

func TestDecryptPublishedVectorRejectsDamageAndCancellation(t *testing.T) {
	key, _ := hex.DecodeString("b0b0909070707093e957d163217c2f3fd4dbe2e9f0f7fe0675f47bd299c3e9f2")
	var link Link
	copy(link.Key[:], key)
	plain := make([]byte, 151511)
	for i := range plain {
		plain[i] = byte(i % 255)
	}
	encrypted := make([]byte, len(plain))
	stream, _ := link.Stream(0)
	stream.XORKeyStream(encrypted, plain)
	var output bytes.Buffer
	if err := Decrypt(context.Background(), link, int64(len(plain)), bytes.NewReader(encrypted), &output); err != nil || !bytes.Equal(output.Bytes(), plain) {
		t.Fatalf("published vector: %v", err)
	}
	for _, input := range [][]byte{encrypted[:len(encrypted)-1], append(append([]byte(nil), encrypted...), 0)} {
		if err := Decrypt(context.Background(), link, int64(len(plain)), bytes.NewReader(input), io.Discard); err != ErrIntegrity {
			t.Fatal("invalid ciphertext length accepted")
		}
	}
	encrypted[1] ^= 1
	if err := Decrypt(context.Background(), link, int64(len(plain)), bytes.NewReader(encrypted), io.Discard); err != ErrIntegrity {
		t.Fatal("corruption accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Decrypt(ctx, link, int64(len(plain)), bytes.NewReader(encrypted), io.Discard); err != context.Canceled {
		t.Fatal("cancel ignored")
	}
}
