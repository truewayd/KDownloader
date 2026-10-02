package downloader

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"strings"
)

const maxPreviewPixels = 16 * 1024 * 1024
const maxPreviewAnimationPixels = 64 * 1024 * 1024

func previewDimensions(width, height int64) bool {
	return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width*height <= maxPreviewPixels
}

// Inspect headers/containers only; allocate no decoded pixel buffers in the core.
func validatePreviewMedia(file *os.File, size int64, mime string) error {
	if mime == "text/plain" {
		return nil
	}
	header := make([]byte, min(size, 512))
	if _, err := file.ReadAt(header, 0); err != nil && err != io.EOF {
		return err
	}
	detected := http.DetectContentType(header)
	if mime == "audio/flac" && strings.HasPrefix(string(header), "fLaC") {
		return nil
	}
	if !(detected == mime || mime == "audio/wav" && detected == "audio/wave" || mime == "audio/ogg" && detected == "application/ogg" || mime == "audio/mp4" && detected == "video/mp4") {
		return fmt.Errorf("file signature does not match its preview type")
	}
	if !strings.HasPrefix(mime, "image/") {
		return nil
	}
	var width, height int64
	switch mime {
	case "image/png", "image/jpeg", "image/gif":
		config, _, err := image.DecodeConfig(io.NewSectionReader(file, 0, min(size, 1024*1024)))
		if err != nil {
			return fmt.Errorf("invalid or oversized image header")
		}
		width, height = int64(config.Width), int64(config.Height)
	case "image/bmp":
		if len(header) < 26 {
			return fmt.Errorf("invalid bitmap header")
		}
		dib := binary.LittleEndian.Uint32(header[14:18])
		if dib == 12 {
			width, height = int64(binary.LittleEndian.Uint16(header[18:20])), int64(binary.LittleEndian.Uint16(header[20:22]))
		} else if dib >= 40 {
			if len(header) < 54 {
				return fmt.Errorf("incomplete bitmap header")
			}
			compression := binary.LittleEndian.Uint32(header[30:34])
			if compression != 0 && compression != 3 && compression != 6 {
				return fmt.Errorf("embedded or compressed bitmap payload is unsupported")
			}
			width, height = int64(int32(binary.LittleEndian.Uint32(header[18:22]))), int64(int32(binary.LittleEndian.Uint32(header[22:26])))
			if height < 0 {
				height = -height
			}
		} else {
			return fmt.Errorf("unsupported bitmap header")
		}
	case "image/webp":
		return validatePreviewWebP(file, size)
	default:
		return fmt.Errorf("unsupported image format")
	}
	if !previewDimensions(width, height) {
		return fmt.Errorf("image exceeds the 8192px / 16 megapixel preview limit")
	}
	if mime == "image/png" {
		return validatePreviewPNG(file, size, width, height)
	}
	if mime == "image/gif" {
		return validatePreviewGIF(file, size, width, height)
	}
	return nil
}

func validatePreviewPNG(file *os.File, size, width, height int64) error {
	frames, declared := int64(0), int64(0)
	for offset, count := int64(8), 0; offset+12 <= size && count < 8192; count++ {
		var chunk [8]byte
		if _, err := file.ReadAt(chunk[:], offset); err != nil {
			return err
		}
		length := int64(binary.BigEndian.Uint32(chunk[:4]))
		if length > size-offset-12 {
			return fmt.Errorf("invalid PNG chunk")
		}
		switch string(chunk[4:]) {
		case "acTL":
			var value [8]byte
			if length != 8 || declared != 0 {
				return fmt.Errorf("invalid PNG animation")
			}
			if _, err := file.ReadAt(value[:], offset+8); err != nil {
				return err
			}
			declared = int64(binary.BigEndian.Uint32(value[:4]))
			if declared == 0 || declared > 200 || declared*width*height > maxPreviewAnimationPixels {
				return fmt.Errorf("animation exceeds the preview frame budget")
			}
		case "fcTL":
			var value [26]byte
			if length != 26 || declared == 0 {
				return fmt.Errorf("invalid PNG animation frame")
			}
			if _, err := file.ReadAt(value[:], offset+8); err != nil {
				return err
			}
			w, h := int64(binary.BigEndian.Uint32(value[4:8])), int64(binary.BigEndian.Uint32(value[8:12]))
			x, y := int64(binary.BigEndian.Uint32(value[12:16])), int64(binary.BigEndian.Uint32(value[16:20]))
			frames++
			if !previewDimensions(w, h) || x+w > width || y+h > height || frames > declared {
				return fmt.Errorf("invalid PNG animation bounds")
			}
		case "IEND":
			if length != 0 || frames != declared {
				return fmt.Errorf("invalid PNG end")
			}
			return nil
		}
		offset += length + 12
	}
	return fmt.Errorf("incomplete or overly complex PNG")
}

func validatePreviewGIF(file *os.File, size, width, height int64) error {
	r := bufio.NewReader(io.NewSectionReader(file, 0, size))
	header := make([]byte, 13)
	if _, err := io.ReadFull(r, header); err != nil {
		return err
	}
	skip := func(n int64) error { _, err := io.CopyN(io.Discard, r, n); return err }
	if header[10]&128 != 0 {
		if err := skip(int64(3 << ((header[10] & 7) + 1))); err != nil {
			return err
		}
	}
	subBlocks := func() error {
		for {
			n, err := r.ReadByte()
			if err != nil {
				return err
			}
			if n == 0 {
				return nil
			}
			if err := skip(int64(n)); err != nil {
				return err
			}
		}
	}
	frames := int64(0)
	for blocks := 0; blocks < 8192; blocks++ {
		kind, err := r.ReadByte()
		if err != nil {
			return err
		}
		switch kind {
		case 0x3b:
			if frames == 0 {
				return fmt.Errorf("empty GIF")
			}
			return nil
		case 0x21:
			if _, err := r.ReadByte(); err != nil {
				return err
			}
			if err := subBlocks(); err != nil {
				return err
			}
		case 0x2c:
			var frame [9]byte
			if _, err := io.ReadFull(r, frame[:]); err != nil {
				return err
			}
			x, y := int64(binary.LittleEndian.Uint16(frame[:2])), int64(binary.LittleEndian.Uint16(frame[2:4]))
			w, h := int64(binary.LittleEndian.Uint16(frame[4:6])), int64(binary.LittleEndian.Uint16(frame[6:8]))
			frames++
			if !previewDimensions(w, h) || x+w > width || y+h > height || frames > 200 || frames*width*height > maxPreviewAnimationPixels {
				return fmt.Errorf("animation exceeds the preview frame budget")
			}
			if frame[8]&128 != 0 {
				if err := skip(int64(3 << ((frame[8] & 7) + 1))); err != nil {
					return err
				}
			}
			code, err := r.ReadByte()
			if err != nil || code < 2 || code > 8 {
				return fmt.Errorf("invalid GIF code size")
			}
			if err := subBlocks(); err != nil {
				return err
			}
		default:
			return fmt.Errorf("invalid GIF block")
		}
	}
	return fmt.Errorf("overly complex GIF")
}

func validatePreviewWebP(file *os.File, size int64) error {
	var header [12]byte
	if _, err := file.ReadAt(header[:], 0); err != nil {
		return err
	}
	if int64(binary.LittleEndian.Uint32(header[4:8]))+8 != size {
		return fmt.Errorf("invalid WebP size")
	}
	pixels := 0
	canvasWidth, canvasHeight := int64(0), int64(0)
	u24 := func(b []byte) int64 { return int64(b[0]) | int64(b[1])<<8 | int64(b[2])<<16 }
	for offset, count := int64(12), 0; offset+8 <= size && count < 8192; count++ {
		var chunk [8]byte
		if _, err := file.ReadAt(chunk[:], offset); err != nil {
			return err
		}
		length := int64(binary.LittleEndian.Uint32(chunk[4:]))
		if length > size-offset-8 {
			return fmt.Errorf("invalid WebP chunk")
		}
		var value [10]byte
		var width, height int64
		switch string(chunk[:4]) {
		case "ANIM", "ANMF":
			return fmt.Errorf("animated WebP is not supported in preview")
		case "VP8X", "VP8 ", "VP8L":
			n := min(int64(len(value)), length)
			if _, err := file.ReadAt(value[:n], offset+8); err != nil {
				return err
			}
			switch string(chunk[:4]) {
			case "VP8X":
				if n != 10 || value[0]&2 != 0 || canvasWidth != 0 {
					return fmt.Errorf("unsupported WebP canvas")
				}
				width, height = u24(value[4:7])+1, u24(value[7:10])+1
				canvasWidth, canvasHeight = width, height
			case "VP8 ":
				if n < 10 || string(value[3:6]) != "\x9d\x01\x2a" {
					return fmt.Errorf("invalid WebP frame")
				}
				width, height = int64(binary.LittleEndian.Uint16(value[6:8])&0x3fff), int64(binary.LittleEndian.Uint16(value[8:10])&0x3fff)
				pixels++
			case "VP8L":
				if n < 5 || value[0] != 0x2f {
					return fmt.Errorf("invalid lossless WebP frame")
				}
				bits := binary.LittleEndian.Uint32(value[1:5])
				width, height = int64(bits&0x3fff)+1, int64((bits>>14)&0x3fff)+1
				pixels++
			}
			if !previewDimensions(width, height) || pixels > 1 || (pixels == 1 && canvasWidth != 0 && (width != canvasWidth || height != canvasHeight)) {
				return fmt.Errorf("image exceeds the preview dimension limit")
			}
		}
		offset += 8 + length + (length & 1)
		if offset == size && pixels == 1 {
			return nil
		}
	}
	return fmt.Errorf("incomplete or overly complex WebP")
}
