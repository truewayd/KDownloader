package downloader

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Follow only explicit next-page links for this exact public directory endpoint.
// Unknown pagination is an error rather than a successful partial collection.
func fetchGoogleDriveFolderPage(ctx context.Context, client *http.Client, endpoint string, profile googleDriveComponentConfig) ([]byte, error) {
	base, _ := url.Parse(endpoint)
	seen := map[string]bool{}
	var contents []byte
	for page := 0; page < 1000; page++ {
		if seen[endpoint] {
			return nil, fmt.Errorf("Google Drive folder pagination loop")
		}
		seen[endpoint] = true
		body, err := requestGoogleDriveFolderPage(ctx, client, endpoint, profile)
		if err != nil {
			return nil, err
		}
		if len(contents)+len(body) > 64<<20 {
			return nil, fmt.Errorf("Google Drive folder listing exceeds 64 MiB")
		}
		contents = append(contents, body...)
		next := ""
		for _, anchor := range googleHTMLAnchorPattern.FindAllStringSubmatch(string(body), -1) {
			attrs := parseHTMLAttributes(anchor[1])
			if !strings.Contains(" "+strings.ToLower(attrs["rel"])+" ", " next ") {
				continue
			}
			u, err := url.Parse(attrs["href"])
			if err != nil {
				return nil, fmt.Errorf("invalid Google Drive folder pagination")
			}
			u = base.ResolveReference(u)
			if u.Scheme != "https" || u.Host != base.Host || u.User != nil || u.Path != base.Path || u.Query().Get("id") != base.Query().Get("id") {
				return nil, fmt.Errorf("untrusted Google Drive folder pagination")
			}
			if next != "" {
				return nil, fmt.Errorf("ambiguous Google Drive folder pagination")
			}
			next = googleDriveResourceLink(u.String(), base.Query().Get("resourcekey"))
		}
		if next == "" {
			for _, marker := range []string{"\"nextPageToken\":\"", "data-next-page-token=\"", "data-next-page-token='"} {
				if strings.Contains(string(body), marker) {
					return nil, fmt.Errorf("Google Drive returned an incomplete listing with unsupported pagination")
				}
			}
			return contents, nil
		}
		endpoint = next
	}
	return nil, fmt.Errorf("Google Drive folder exceeds pagination limit")
}

func requestGoogleDriveFolderPage(ctx context.Context, client *http.Client, endpoint string, profile googleDriveComponentConfig) ([]byte, error) {
	for attempt := 0; attempt < 3; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
		request, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, endpoint, nil)
		if err != nil {
			cancel()
			return nil, err
		}
		request.Header.Set("User-Agent", profile.UserAgent)
		request.Header.Set("Accept-Encoding", "identity")
		response, err := client.Do(request)
		retry := err != nil
		var body []byte
		if err == nil {
			if response.StatusCode == http.StatusOK {
				body, err = readLimitedBody(response.Body, googleDriveFolderHTMLLimit)
				retry = err != nil && !strings.Contains(err.Error(), "response exceeds")
			} else {
				err = fmt.Errorf("Google Drive directory returned HTTP %d", response.StatusCode)
				retry = response.StatusCode == 429 || response.StatusCode >= 500
			}
			response.Body.Close()
		}
		cancel()
		if err == nil {
			return body, nil
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("Google Drive directory scan interrupted: %w", ctx.Err())
		}
		if !retry || attempt == 2 {
			log.Printf("Google Drive directory request failed after %d attempt(s)", attempt+1)
			return nil, err
		}
		timer := time.NewTimer(time.Duration(attempt+1) * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	panic("unreachable")
}

func googleDriveScanReason(err error) string {
	message := err.Error()
	for _, reason := range []string{"deadline exceeded", "canceled", "HTTP 429", "HTTP 403", "HTTP 404", "HTTP 500", "HTTP 502", "HTTP 503", "pagination", "exceeds", "page structure", "public name"} {
		if strings.Contains(message, reason) {
			return reason
		}
	}
	return "network or listing failure"
}
