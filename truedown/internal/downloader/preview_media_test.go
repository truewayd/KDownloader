package downloader

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func checkPreviewMedia(t *testing.T, data []byte, mime string) error {
	t.Helper()
	path := filepath.Join(t.TempDir(), "media")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	return validatePreviewMedia(file, int64(len(data)), mime)
}

func TestPreviewMediaSignaturesAndPixelBudget(t *testing.T) {
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewNRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	valid := buffer.Bytes()
	if err := checkPreviewMedia(t, valid, "image/png"); err != nil {
		t.Fatal(err)
	}
	if err := checkPreviewMedia(t, valid, "image/jpeg"); err == nil {
		t.Fatal("mismatched extension accepted")
	}
	if err := checkPreviewMedia(t, []byte("<html><script>alert(1)</script></html>"), "image/png"); err == nil {
		t.Fatal("HTML accepted as an image")
	}
	bomb := bytes.Clone(valid)
	binary.BigEndian.PutUint32(bomb[16:20], 65535)
	binary.BigEndian.PutUint32(bomb[20:24], 65535)
	binary.BigEndian.PutUint32(bomb[29:33], crc32.ChecksumIEEE(bomb[12:29]))
	if err := checkPreviewMedia(t, bomb, "image/png"); err == nil {
		t.Fatal("pixel bomb accepted")
	}
	for _, pair := range [][2]int64{{0, 1}, {1, 0}, {-1, 2}, {8193, 1}, {8192, 8192}} {
		if previewDimensions(pair[0], pair[1]) {
			t.Fatalf("unsafe dimensions: %v", pair)
		}
	}
	if !previewDimensions(4096, 4096) {
		t.Fatal("ordinary large images should fit")
	}
	if err := checkPreviewMedia(t, valid[:len(valid)-12], "image/png"); err == nil {
		t.Fatal("truncated PNG accepted")
	}
}

func TestPreviewAnimationBudget(t *testing.T) {
	frame := image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.Black, color.White})
	animation := gif.GIF{}
	for i := 0; i < 201; i++ {
		animation.Image = append(animation.Image, frame)
		animation.Delay = append(animation.Delay, 1)
	}
	var buffer bytes.Buffer
	if err := gif.EncodeAll(&buffer, &animation); err != nil {
		t.Fatal(err)
	}
	if err := checkPreviewMedia(t, buffer.Bytes(), "image/gif"); err == nil {
		t.Fatal("too many animation frames accepted")
	}
	animation.Image, animation.Delay = animation.Image[:2], animation.Delay[:2]
	buffer.Reset()
	if err := gif.EncodeAll(&buffer, &animation); err != nil {
		t.Fatal(err)
	}
	if err := checkPreviewMedia(t, buffer.Bytes(), "image/gif"); err != nil {
		t.Fatal(err)
	}
}

func TestPreviewRejectsOversizedWebPAndEmbeddedBitmap(t *testing.T) {
	webp := make([]byte, 30)
	copy(webp, "RIFF")
	binary.LittleEndian.PutUint32(webp[4:8], uint32(len(webp)-8))
	copy(webp[8:], "WEBPVP8X")
	binary.LittleEndian.PutUint32(webp[16:20], 10)
	webp[25] = 32 // width = 8193, height = 1
	if err := checkPreviewMedia(t, webp, "image/webp"); err == nil {
		t.Fatal("oversized WebP canvas accepted")
	}
	webp[25], webp[20] = 0, 2 // animation flag
	if err := checkPreviewMedia(t, webp, "image/webp"); err == nil {
		t.Fatal("animated WebP accepted")
	}
	bmp := make([]byte, 54)
	copy(bmp, "BM")
	binary.LittleEndian.PutUint32(bmp[14:18], 40)
	binary.LittleEndian.PutUint32(bmp[18:22], 1)
	binary.LittleEndian.PutUint32(bmp[22:26], 1)
	binary.LittleEndian.PutUint32(bmp[30:34], 5) // BI_PNG can hide different image dimensions.
	if err := checkPreviewMedia(t, bmp, "image/bmp"); err == nil {
		t.Fatal("embedded image accepted inside BMP")
	}
}
