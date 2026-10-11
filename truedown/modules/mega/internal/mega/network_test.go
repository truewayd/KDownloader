package mega

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func downloadFixture(data []byte, alter bool) (*Client, Link, Metadata) {
	link := testLink()
	mac := link.NewMAC()
	mac.Write(data)
	sum := mac.Sum()
	// Preserve the derived AES key while embedding the verified meta-MAC.
	for i := 0; i < 8; i++ {
		link.Key[i+8] ^= link.Key[i+24] ^ sum[i]
		link.Key[i+24] = sum[i]
	}
	encrypted := make([]byte, len(data))
	stream, _ := link.Stream(0)
	stream.XORKeyStream(encrypted, data)
	if alter && len(encrypted) > 0 {
		encrypted[len(encrypted)-1] ^= 1
	}
	c := NewClient()
	c.http.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(encrypted)), ContentLength: int64(len(encrypted))}, nil
	})
	return c, link, Metadata{Name: "test.bin", Size: int64(len(data)), URL: "https://fixture.userstorage.mega.co.nz/content"}
}

func TestDownloadAuthenticatesBeforeSuccess(t *testing.T) {
	data := bytes.Repeat([]byte("verified bytes\n"), 10000)
	for _, alter := range []bool{false, true} {
		c, link, metadata := downloadFixture(data, alter)
		var output bytes.Buffer
		err := c.Download(context.Background(), link, metadata, &output, nil)
		if alter {
			if err != ErrIntegrity {
				t.Fatalf("corruption accepted: %v", err)
			}
		} else if err != nil || !bytes.Equal(data, output.Bytes()) {
			t.Fatalf("download: %v", err)
		}
	}
}

func TestRejectUnsafeRemoteURLAndCloudRAID(t *testing.T) {
	for _, raw := range []string{"http://fixture.userstorage.mega.co.nz/x", "https://localhost/x", "https://127.0.0.1/x", "https://fixture.userstorage.mega.co.nz.evil.test/x", "https://user@fixture.userstorage.mega.co.nz/x"} {
		if allowedDownload(raw) {
			t.Fatal("unsafe download target accepted")
		}
	}
	c := NewClient()
	c.http.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.RawQuery != "id=1" || strings.Contains(r.URL.String(), "ak=") {
			t.Fatal("unexpected application identity")
		}
		var request []map[string]any
		json.NewDecoder(r.Body).Decode(&request)
		if len(request) != 1 || request[0]["ssl"] != float64(2) || len(request[0]) != 4 {
			t.Fatal("invalid public-link request")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[{"g":["raid-url"],"s":10,"at":""}]`))}, nil
	})
	if _, err := c.Resolve(context.Background(), testLink()); err != ErrUnsupported {
		t.Fatalf("unsupported RAID: %v", err)
	}
}

func TestDownloadRejectsIncompleteAndExcessBodies(t *testing.T) {
	for _, delta := range []int{-1, 1} {
		c, link, metadata := downloadFixture([]byte("integrity fixture"), false)
		original := c.http.Transport
		c.http.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
			response, err := original.RoundTrip(r)
			data, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if delta < 0 {
				data = data[:len(data)-1]
			} else {
				data = append(data, 0)
			}
			response.Body = io.NopCloser(bytes.NewReader(data))
			response.ContentLength = -1
			return response, err
		})
		if err := c.Download(context.Background(), link, metadata, io.Discard, nil); err != ErrIntegrity {
			t.Fatalf("body delta %d: %v", delta, err)
		}
	}
}

func TestQuotaAndCancelledTransport(t *testing.T) {
	c, link, metadata := downloadFixture([]byte("test"), false)
	c.http.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 509, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	if err := c.Download(context.Background(), link, metadata, io.Discard, nil); err != ErrQuota {
		t.Fatalf("quota: %v", err)
	}
	c.http.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Download(ctx, link, metadata, io.Discard, nil); err != context.Canceled {
		t.Fatalf("cancel: %v", err)
	}
}

func TestLivePublicFile(t *testing.T) {
	raw := os.Getenv("TRUEDOWN_MEGA_TEST_LINK")
	if raw == "" {
		t.Skip("explicit public fixture required")
	}
	link, err := ParseLink(raw)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	c := NewClient()
	metadata, err := c.Resolve(ctx, link)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Size > 20*1024*1024 {
		t.Fatal("public fixture exceeds 20 MiB budget")
	}
	hash := sha256.New()
	if err := c.Download(ctx, link, metadata, hash, nil); err != nil {
		t.Fatal(err)
	}
	t.Logf("authenticated bytes=%d sha256=%x", metadata.Size, hash.Sum(nil))
}

func TestLiveHTTPRangeCompatibility(t *testing.T) {
	raw := os.Getenv("TRUEDOWN_MEGA_TEST_LINK")
	if raw == "" {
		t.Skip("explicit public fixture required")
	}
	link, err := ParseLink(raw)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	c := NewClient()
	metadata, err := c.Resolve(ctx, link)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Size < 10 || metadata.Size > 20*1024*1024 {
		t.Fatal("fixture size outside range test budget")
	}
	for _, suffix := range []string{"", "/0-" + strconv.FormatInt(metadata.Size-1, 10)} {
		request, _ := http.NewRequestWithContext(ctx, "GET", metadata.URL+suffix, nil)
		request.Header.Set("Range", "bytes=3-7")
		response, err := c.http.Do(request)
		if err != nil {
			t.Fatal("range transport failed")
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, metadata.Size+1))
		response.Body.Close()
		if err != nil {
			t.Fatal("range body failed")
		}
		t.Logf("path-range=%v status=%d bytes=%d content-range=%s accept-ranges=%s", suffix != "", response.StatusCode, len(data), response.Header.Get("Content-Range"), response.Header.Get("Accept-Ranges"))
	}
}
