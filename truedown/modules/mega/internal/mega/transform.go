package mega

import (
	"context"
	"crypto/cipher"
	"io"
)

// Decrypt authenticates an aria2-staged ciphertext without making network calls.
// The caller must keep plaintext private until this function succeeds.
func Decrypt(ctx context.Context, link Link, size int64, input io.Reader, output io.Writer) error {
	if size < 0 || size > 1<<50 {
		return ErrSource
	}
	stream, err := link.Stream(0)
	if err != nil {
		return err
	}
	reader := &cipher.StreamReader{S: stream, R: io.LimitReader(input, size+1)}
	mac := link.NewMAC()
	buffer := make([]byte, 64*1024)
	var completed int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := reader.Read(buffer)
		if n > 0 {
			completed += int64(n)
			if completed > size {
				return ErrIntegrity
			}
			mac.Write(buffer[:n])
			written, err := output.Write(buffer[:n])
			if err != nil {
				return err
			}
			if written != n {
				return io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if completed != size {
		return ErrIntegrity
	}
	return link.Verify(mac)
}
