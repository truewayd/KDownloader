package mega

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func testLink() Link {
	var link Link
	link.Handle = "AAAAAAAA"
	for i := range link.Key {
		link.Key[i] = byte(i)
	}
	return link
}

func TestPublicLinkValidation(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for _, raw := range []string{"https://mega.nz/file/AAAAAAAA#" + key, "https://mega.co.nz/#!AAAAAAAA!" + key} {
		if _, err := ParseLink(raw); err != nil {
			t.Fatal(err)
		}
	}
	for _, raw := range []string{"https://mega.nz.evil.test/file/AAAAAAAA#" + key, "https://user@mega.nz/file/AAAAAAAA#" + key, "http://mega.nz/file/AAAAAAAA#" + key, "https://mega.nz/file/AAAAAAAA#bad", "https://mega.nz/file/AAAAAAAA?ak=test#" + key, "https://mega.nz:443/file/AAAAAAAA#" + key} {
		if _, err := ParseLink(raw); err == nil {
			t.Fatal("accepted malformed source")
		}
	}
}

func TestMetadataCBCAndMalformedAttributes(t *testing.T) {
	link := testLink()
	plain := []byte(`MEGA{"n":"sample.txt"}`)
	plain = append(plain, make([]byte, (16-len(plain)%16)%16)...)
	var iv [16]byte
	cipher.NewCBCEncrypter(link.block(), iv[:]).CryptBlocks(plain, plain)
	encoded := base64.RawURLEncoding.EncodeToString(plain)
	if name, err := link.DecryptAttributes(encoded); err != nil || name != "sample.txt" {
		t.Fatalf("attributes: %q %v", name, err)
	}
	link.Key[0] ^= 1
	if _, err := link.DecryptAttributes(encoded); err == nil {
		t.Fatal("accepted wrong key")
	}
	for _, encoded := range []string{"", "A", "!!!!", base64.RawURLEncoding.EncodeToString(make([]byte, 17))} {
		if _, err := link.DecryptAttributes(encoded); err == nil {
			t.Fatal("accepted malformed attributes")
		}
	}
}

func TestCTRCanRestartOnlyAtAlignedOffset(t *testing.T) {
	link := testLink()
	plain := bytes.Repeat([]byte("abcdef0123456789"), 100)
	all := make([]byte, len(plain))
	stream, _ := link.Stream(0)
	stream.XORKeyStream(all, plain)
	part := make([]byte, len(plain)-48)
	stream, _ = link.Stream(48)
	stream.XORKeyStream(part, all[48:])
	if !bytes.Equal(part, plain[48:]) {
		t.Fatal("CTR offset mismatch")
	}
	if _, err := link.Stream(1); err == nil {
		t.Fatal("accepted unaligned offset")
	}
}

// Independent whole-chunk formulation checks streaming block/padding boundaries.
func referenceMAC(link Link, plain []byte) [8]byte {
	block := link.block()
	var accumulator [16]byte
	for chunk := 128 * 1024; len(plain) > 0; chunk = min(chunk+128*1024, 1024*1024) {
		size := min(chunk, len(plain))
		data := plain[:size]
		plain = plain[size:]
		padded := make([]byte, (len(data)+15)/16*16)
		copy(padded, data)
		var iv [16]byte
		copy(iv[:8], link.Key[16:24])
		copy(iv[8:], link.Key[16:24])
		cipher.NewCBCEncrypter(block, iv[:]).CryptBlocks(padded, padded)
		for i, v := range padded[len(padded)-aes.BlockSize:] {
			accumulator[i] ^= v
		}
		block.Encrypt(accumulator[:], accumulator[:])
	}
	var result [8]byte
	for i := 0; i < 4; i++ {
		result[i] = accumulator[i] ^ accumulator[i+4]
		result[i+4] = accumulator[i+8] ^ accumulator[i+12]
	}
	return result
}

func TestMACChunkPaddingAndStreamingBoundaries(t *testing.T) {
	for _, size := range []int{0, 1, 15, 16, 17, 131071, 131072, 131073, 393216, 4718592, 4718601} {
		link := testLink()
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(i*31 + 7)
		}
		want := referenceMAC(link, data)
		for _, step := range []int{1, 17, 4096, 65536} {
			mac := link.NewMAC()
			for pos := 0; pos < len(data); pos += step {
				mac.Write(data[pos:min(len(data), pos+step)])
			}
			if got := mac.Sum(); got != want {
				t.Fatalf("size=%d step=%d: %x != %x", size, step, got, want)
			}
		}
	}
}

func TestOfficialSDKMACVectors(t *testing.T) {
	// Generated with SDK 8775533 SymmCipher::ctr_crypt and its chunk MAC
	// aggregation. These include exact chunk boundaries and an empty file.
	vectors := map[int]string{0: "0000000000000000", 1: "f55714f538b32ea8", 16: "c7561fa2d5cdab22", 131071: "52f909a7bbbb80d9", 131072: "01ef7331db1f515d", 131073: "cf0edbc23ffb77ab", 393216: "16d950c6d388b678", 4718592: "15ac9acadd4ceba4"}
	for size, expected := range vectors {
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(i*31 + 7)
		}
		mac := testLink().NewMAC()
		mac.Write(data)
		got := mac.Sum()
		if hex.EncodeToString(got[:]) != expected {
			t.Fatalf("SDK MAC mismatch at size %d: %x", size, got)
		}
	}
}

// Published MEGAJS test vectors at 32e4fa1, independently generated upstream.
// Only the constants and data pattern are used; no JS runtime is needed.
func TestPublishedCryptoVector(t *testing.T) {
	key, _ := hex.DecodeString("b0b0909070707093e957d163217c2f3fd4dbe2e9f0f7fe0675f47bd299c3e9f2")
	var link Link
	copy(link.Key[:], key)
	data := make([]byte, 151511)
	for i := range data {
		data[i] = byte(i % 255)
	}
	mac := link.NewMAC()
	mac.Write(data)
	if err := link.Verify(mac); err != nil {
		t.Fatal("published MAC vector mismatch")
	}
	stream, _ := link.Stream(0)
	stream.XORKeyStream(data, data)
	hash := sha1.Sum(data)
	if hex.EncodeToString(hash[:]) != "addb96c07ac4e6b66316b81530256c911b0b49d1" {
		t.Fatal("published CTR vector mismatch")
	}
	data[0] ^= 1
	stream, _ = link.Stream(0)
	stream.XORKeyStream(data, data)
	mac = link.NewMAC()
	mac.Write(data)
	if link.Verify(mac) != ErrIntegrity {
		t.Fatal("corrupted vector accepted")
	}
}
