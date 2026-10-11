package mega

import (
	"context"
	"crypto/cipher"
	"io"
	"net/http"
	"strconv"
)

// Download authenticates the complete plaintext. A successful return, not its
// progress callback or output length, authorizes publication by the host.
func (c *Client) Download(ctx context.Context, link Link, metadata Metadata, writer io.Writer, progress func(int64)) error {
	mac := link.NewMAC()
	if metadata.Size == 0 {
		return link.Verify(mac)
	}
	if !allowedDownload(metadata.URL) {
		return ErrNetwork
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, metadata.URL+"/0-"+strconv.FormatInt(metadata.Size-1, 10), nil)
	if err != nil {
		return ErrNetwork
	}
	request.Header.Set("Accept-Encoding", "identity")
	response, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrNetwork
	}
	defer response.Body.Close()
	if response.StatusCode == 509 || response.StatusCode == 429 {
		return ErrQuota
	}
	if response.StatusCode != 200 || (response.ContentLength >= 0 && response.ContentLength != metadata.Size) {
		return ErrNetwork
	}
	stream, _ := link.Stream(0)
	reader := &cipher.StreamReader{R: io.LimitReader(response.Body, metadata.Size+1), S: stream}
	buffer := make([]byte, 64*1024)
	var completed int64
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			if completed+int64(n) > metadata.Size {
				return ErrIntegrity
			}
			if _, err := mac.Write(buffer[:n]); err != nil {
				return err
			}
			written, err := writer.Write(buffer[:n])
			if err != nil {
				return err
			}
			if written != n {
				return io.ErrShortWrite
			}
			completed += int64(n)
			if progress != nil {
				progress(completed)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return ErrNetwork
		}
	}
	if completed != metadata.Size {
		return ErrIntegrity
	}
	return link.Verify(mac)
}
