package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"truedown/internal/api"
	"truedown/internal/downloader"
)

//go:embed web
var webFS embed.FS

// exeDir returns the directory that contains the running executable,
// so paths like aria2c.exe are resolved correctly regardless of cwd.
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

func main() {
	base := exeDir()
	aria2 := filepath.Join(base, "aria2c.exe")
	if _, err := os.Stat(aria2); os.IsNotExist(err) {
		aria2 = filepath.Join("aria2", "aria2c.exe")
	}
	aria2, err := filepath.Abs(aria2)
	if err != nil {
		log.Fatal(err)
	}
	dataDir := os.Getenv("TRUEDOWN_DATA_DIR")
	if dataDir == "" {
		dataDir = base
	}
	downloads := filepath.Join(dataDir, "downloads")
	database := filepath.Join(dataDir, "truedown.db")
	auth, err := newAuthController(
		dataDir,
		os.Getenv("TRUEDOWN_REQUIRE_TOKEN") == "1",
		os.Getenv("TRUEDOWN_API_TOKEN"),
	)
	if err != nil {
		log.Fatal(err)
	}
	dm, err := downloader.NewManager(aria2, downloads, database)
	if err != nil {
		log.Fatal(err)
	}
	if err := dm.Start(); err != nil {
		dm.Stop()
		log.Fatal(err)
	}
	defer dm.Stop()

	mux := http.NewServeMux()
	api.Register(mux, dm, auth)

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))

	tlsCert := strings.TrimSpace(os.Getenv("TRUEDOWN_TLS_CERT"))
	tlsKey := strings.TrimSpace(os.Getenv("TRUEDOWN_TLS_KEY"))
	if (tlsCert == "") != (tlsKey == "") {
		log.Fatal("TRUEDOWN_TLS_CERT and TRUEDOWN_TLS_KEY must be configured together")
	}
	tlsEnabled := tlsCert != ""
	authEnabled, _, _ := auth.Snapshot()
	addr, err := validateListenAddress(
		os.Getenv("TRUEDOWN_ADDR"),
		os.Getenv("TRUEDOWN_ALLOW_REMOTE") == "1",
		tlsEnabled,
		authEnabled,
	)
	if err != nil {
		log.Fatal(err)
	}
	if !loopbackListener([]string{addr}) {
		auth.LockEnabled()
	}
	browserURL := browserURLForAddress(addr, tlsEnabled)
	log.Printf("TrueDown listening on %s", addr)
	if tokenPath := auth.TokenPath(); tokenPath != "" && authEnabled {
		log.Printf("TrueDown API Key is available from the dashboard and stored in %s", tokenPath)
	} else if !authEnabled {
		log.Printf("API Key authentication is disabled; enable it from the dashboard when needed")
	}
	if os.Getenv("TRUEDOWN_NO_BROWSER") == "" {
		go openBrowser(browserURL)
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           secureHandler(mux, auth, addr),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 * 1024,
	}
	serverErr := make(chan error, 1)
	go func() {
		if tlsEnabled {
			serverErr <- server.ListenAndServeTLS(tlsCert, tlsKey)
			return
		}
		serverErr <- server.ListenAndServe()
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("HTTP server: %v", err)
		}
	case <-stop:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("HTTP shutdown: %v", err)
		}
	}
}

func validateListenAddress(value string, allowRemote bool, tlsEnabled ...bool) (string, error) {
	addr := strings.TrimSpace(value)
	if addr == "" {
		addr = "127.0.0.1:15151"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return "", fmt.Errorf("invalid TRUEDOWN_ADDR %q", addr)
	}
	if _, err := net.LookupPort("tcp", port); err != nil {
		return "", fmt.Errorf("invalid TRUEDOWN_ADDR port %q", port)
	}
	plainHost := strings.Trim(host, "[]")
	if plainHost == "" {
		return "", fmt.Errorf("TRUEDOWN_ADDR must name a specific interface")
	}
	isLoopback := strings.EqualFold(plainHost, "localhost")
	if ip := net.ParseIP(plainHost); ip != nil {
		if ip.IsUnspecified() {
			return "", fmt.Errorf("TRUEDOWN_ADDR must name a specific interface, not %q", plainHost)
		}
		isLoopback = ip.IsLoopback()
	} else if !isLoopback {
		return "", fmt.Errorf("TRUEDOWN_ADDR must use an IP literal or localhost")
	}
	if !isLoopback && !allowRemote {
		return "", fmt.Errorf("TRUEDOWN_ADDR must use a loopback host unless TRUEDOWN_ALLOW_REMOTE=1")
	}
	if !isLoopback && (len(tlsEnabled) == 0 || !tlsEnabled[0]) {
		return "", fmt.Errorf("remote TRUEDOWN_ADDR requires TRUEDOWN_TLS_CERT and TRUEDOWN_TLS_KEY")
	}
	if !isLoopback && (len(tlsEnabled) < 2 || !tlsEnabled[1]) {
		return "", fmt.Errorf("remote TRUEDOWN_ADDR requires API Key authentication")
	}
	return addr, nil
}

func browserURLForAddress(addr string, tlsEnabled ...bool) string {
	scheme := "http"
	if len(tlsEnabled) > 0 && tlsEnabled[0] {
		scheme = "https"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return scheme + "://127.0.0.1:15151"
	}
	plainHost := strings.Trim(host, "[]")
	if plainHost == "" || plainHost == "0.0.0.0" || plainHost == "::" {
		plainHost = "127.0.0.1"
	}
	return scheme + "://" + net.JoinHostPort(plainHost, port)
}

const apiSessionCookie = api.SessionCookieName

type authState interface {
	Snapshot() (enabled bool, token string, managed bool)
}

func secureHandler(next http.Handler, auth authState, listenAddresses ...string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		if !allowedRequestHost(r.Host, listenAddresses...) {
			http.Error(w, "unrecognized request host", http.StatusForbidden)
			return
		}
		authEnabled, apiToken, _ := auth.Snapshot()
		isDashboard := (r.URL.Path == "/" || r.URL.Path == "/index.html") && r.Method == http.MethodGet
		if authEnabled && isDashboard {
			w.Header().Set("Cache-Control", "no-store")
		}
		if authEnabled && isDashboard && isDashboardNavigation(r) && loopbackListener(listenAddresses) {
			http.SetCookie(w, &http.Cookie{
				Name:     apiSessionCookie,
				Value:    apiToken,
				Path:     "/",
				HttpOnly: true,
				Secure:   r.TLS != nil,
				SameSite: http.SameSiteStrictMode,
			})
		}
		if authEnabled && isAPIPath(r.URL.Path) {
			w.Header().Set("Cache-Control", "no-store")
			if !authorizedAPIRequest(r, apiToken) {
				http.Error(w, "TrueDown API Key is required", http.StatusUnauthorized)
				return
			}
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !allowedRequestOrigin(r) {
			http.Error(w, "cross-origin request rejected", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func loopbackListener(listenAddresses []string) bool {
	if len(listenAddresses) == 0 {
		return false
	}
	for _, address := range listenAddresses {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return false
		}
		plainHost := strings.Trim(host, "[]")
		if strings.EqualFold(plainHost, "localhost") {
			continue
		}
		ip := net.ParseIP(plainHost)
		if ip == nil || !ip.IsLoopback() {
			return false
		}
	}
	return true
}

func isDashboardNavigation(r *http.Request) bool {
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Mode")), "navigate") {
		fetchSite := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")))
		return fetchSite == "" || fetchSite == "none" || fetchSite == "same-origin"
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return r.Header.Get("Sec-Fetch-Mode") == ""
	}
	parsed, err := url.Parse(origin)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && strings.EqualFold(parsed.Host, r.Host)
}

func isAPIPath(path string) bool {
	return path == "/ping" || path == "/add" || path == "/start-headless-download" ||
		path == "/settings/download-rules" || path == "/tasks" ||
		strings.HasPrefix(path, "/auth/") || strings.HasPrefix(path, "/tasks/")
}

func authorizedAPIRequest(r *http.Request, expected string) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Api-Key"))
	if provided == "" {
		if cookie, err := r.Cookie(apiSessionCookie); err == nil {
			provided = cookie.Value
		}
	}
	if len(provided) != len(expected) || expected == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func loadOrCreateAPIToken(dataDir, configured string) (string, string, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return "", "", fmt.Errorf("create TrueDown data directory: %w", err)
	}
	if token := strings.TrimSpace(configured); token != "" {
		if err := validateAPIToken(token); err != nil {
			return "", "", fmt.Errorf("TRUEDOWN_API_TOKEN: %w", err)
		}
		return token, "", nil
	}
	tokenPath := filepath.Join(dataDir, "truedown.token")
	if data, err := os.ReadFile(tokenPath); err == nil {
		token := strings.TrimSpace(string(data))
		if err := validateAPIToken(token); err != nil {
			return "", "", fmt.Errorf("read %s: %w", tokenPath, err)
		}
		return token, tokenPath, nil
	} else if !os.IsNotExist(err) {
		return "", "", fmt.Errorf("read TrueDown API Key: %w", err)
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", "", fmt.Errorf("generate TrueDown API Key: %w", err)
	}
	token := hex.EncodeToString(random)
	file, err := os.OpenFile(tokenPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		if os.IsExist(err) {
			return loadOrCreateAPIToken(dataDir, "")
		}
		return "", "", fmt.Errorf("create TrueDown API Key: %w", err)
	}
	if _, err := file.WriteString(token + "\n"); err != nil {
		_ = file.Close()
		return "", "", fmt.Errorf("write TrueDown API Key: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", "", fmt.Errorf("close TrueDown API Key: %w", err)
	}
	return token, tokenPath, nil
}

func validateAPIToken(token string) error {
	if len(token) < 32 || len(token) > 256 || strings.ContainsAny(token, "\x00\r\n") {
		return fmt.Errorf("token must contain 32 to 256 safe characters")
	}
	return nil
}

func allowedRequestHost(requestHost string, listenAddresses ...string) bool {
	host := requestHost
	if parsedHost, _, err := net.SplitHostPort(requestHost); err == nil {
		host = parsedHost
	}
	plainHost := strings.Trim(strings.TrimSpace(host), "[]")
	if strings.EqualFold(plainHost, "localhost") {
		return true
	}
	if ip := net.ParseIP(plainHost); ip != nil && ip.IsLoopback() {
		return true
	}
	for _, address := range listenAddresses {
		configuredHost, _, err := net.SplitHostPort(address)
		if err == nil && strings.EqualFold(strings.Trim(configuredHost, "[]"), plainHost) {
			return true
		}
	}
	return false
}

func allowedRequestOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if parsed.Scheme == "chrome-extension" && parsed.Host != "" {
		return true
	}
	return (parsed.Scheme == "http" || parsed.Scheme == "https") && strings.EqualFold(parsed.Host, r.Host)
}

func openBrowser(url string) {
	time.Sleep(300 * time.Millisecond)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Start()
}
