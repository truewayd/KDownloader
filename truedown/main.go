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
	"strconv"
	"strings"
	"syscall"
	"time"

	"truedown/internal/api"
	"truedown/internal/downloader"
	"truedown/internal/safefile"
	"truedown/internal/systemupdate"
)

var (
	version     = "dev"
	buildNumber = "0"
	commit      = "unknown"
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
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("TrueDown %s (build %s, commit %s)\n", version, buildNumber, commit)
		return
	}
	if handled, exitCode := systemupdate.RunHelperIfRequested(os.Args[1:]); handled {
		os.Exit(exitCode)
	}
	base := exeDir()
	stableAria2 := filepath.Join(base, "aria2c.exe")
	if _, err := os.Stat(stableAria2); os.IsNotExist(err) {
		stableAria2 = filepath.Join(base, "aria2", "aria2c.exe")
	}
	stableAria2, err := filepath.Abs(stableAria2)
	if err != nil {
		log.Fatal(err)
	}
	dataDir := os.Getenv("TRUEDOWN_DATA_DIR")
	if dataDir == "" {
		dataDir = base
	}
	// TRUEDOWN_DATA_DIR is an operator-chosen trusted storage boundary. It may
	// itself be a junction; managed config helpers validate the leaf entries.
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	dataDir = filepath.Clean(dataDir)
	currentBuild, parseErr := strconv.ParseInt(strings.TrimSpace(buildNumber), 10, 64)
	if parseErr != nil || currentBuild < 0 {
		currentBuild = 0
	}
	updates, err := systemupdate.New(systemupdate.Options{
		BaseDir:          base,
		DataDir:          dataDir,
		StableEnginePath: stableAria2,
		CurrentVersion:   version,
		CurrentBuild:     currentBuild,
		CurrentCommit:    commit,
	})
	if err != nil {
		log.Fatal(err)
	}
	aria2 := updates.EnginePath()
	engineStatus := updates.Snapshot().Engine
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
	dm, err := downloader.NewManagerWithConfig(aria2, downloads, database, downloader.ManagerConfig{
		Aria2Next:        engineStatus.Active == systemupdate.EngineNext,
		Aria2NextVersion: engineStatus.ActiveVersion,
	})
	if err != nil {
		log.Fatal(err)
	}
	startErr := dm.Start()
	if startErr != nil && engineStatus.Active == systemupdate.EngineNext && downloader.IsEngineStartError(startErr) {
		dm.Stop()
		aria2 = updates.FallbackToStable(startErr)
		log.Printf("Aria2 Next startup failed; retrying with the built-in stable engine: %v", startErr)
		dm, err = downloader.NewManager(aria2, downloads, database)
		if err != nil {
			log.Fatal(err)
		}
		startErr = dm.Start()
	}
	if startErr != nil {
		dm.Stop()
		log.Fatal(startErr)
	}
	defer dm.Stop()

	mux := http.NewServeMux()
	api.Register(mux, dm, auth, updates)

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
	if os.Getenv("TRUEDOWN_NO_BROWSER") == "" && !systemupdate.IsUpdateRelaunch() {
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
	restart := make(chan struct{}, 1)
	updates.SetRestartCallback(func() error {
		active := dm.TaskCountByStatus(downloader.StatusQueued) +
			dm.TaskCountByStatus(downloader.StatusDownloading) +
			dm.TaskCountByStatus(downloader.StatusPaused)
		if active > 0 {
			return fmt.Errorf("wait for queued, downloading, and paused tasks before restarting TrueDown")
		}
		if err := updates.LaunchPendingApply(os.Args[1:]); err != nil {
			return err
		}
		select {
		case restart <- struct{}{}:
		default:
		}
		return nil
	})
	serverErr := make(chan error, 1)
	go func() {
		if tlsEnabled {
			serverErr <- server.ListenAndServeTLS(tlsCert, tlsKey)
			return
		}
		serverErr <- server.ListenAndServe()
	}()
	updateContext, cancelUpdates := context.WithCancel(context.Background())
	defer cancelUpdates()
	automaticUpdatesDone := updates.RunAutomatic(updateContext, func() bool {
		return dm.TaskCountByStatus(downloader.StatusQueued) == 0 &&
			dm.TaskCountByStatus(downloader.StatusDownloading) == 0 &&
			dm.TaskCountByStatus(downloader.StatusPaused) == 0
	})
	select {
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("HTTP server: %v", err)
		}
		return
	case <-time.After(300 * time.Millisecond):
		if err := systemupdate.SignalHealthyFromEnvironment(); err != nil {
			log.Printf("update health signal: %v", err)
		}
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("HTTP server: %v", err)
		}
	case <-stop:
	case <-restart:
	}
	cancelUpdates()
	<-automaticUpdatesDone
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("HTTP shutdown: %v", err)
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
const maxAPITokenFileBytes int64 = 258

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
				Value:    apiSessionCookieValue(apiToken),
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
	return path == "/ping" || path == "/add" || path == "/start-headless-download" || path == "/start-bt-download" ||
		path == "/tasks" || path == "/modules" || strings.HasPrefix(path, "/modules/") || strings.HasPrefix(path, "/settings/") ||
		strings.HasPrefix(path, "/auth/") || strings.HasPrefix(path, "/tasks/") ||
		strings.HasPrefix(path, "/queue/") || strings.HasPrefix(path, "/system/")
}

func authorizedAPIRequest(r *http.Request, expected string) bool {
	provided := r.Header.Get("X-Api-Key")
	if provided != "" && constantTimeStringEqual(provided, expected) {
		return true
	}
	cookie, err := r.Cookie(apiSessionCookie)
	if err != nil {
		return false
	}
	return constantTimeStringEqual(cookie.Value, apiSessionCookieValue(expected))
}

func apiSessionCookieValue(token string) string {
	return api.SessionCookieValue(token)
}

func constantTimeStringEqual(provided, expected string) bool {
	if len(provided) != len(expected) || expected == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func loadOrCreateAPIToken(dataDir, configured string) (string, string, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return "", "", fmt.Errorf("create TrueDown data directory: %w", err)
	}
	if configured != "" {
		if err := validateAPIToken(configured); err != nil {
			return "", "", fmt.Errorf("TRUEDOWN_API_TOKEN: %w", err)
		}
		return configured, "", nil
	}
	tokenPath := filepath.Join(dataDir, "truedown.token")
	if data, err := safefile.ReadFile(tokenPath, maxAPITokenFileBytes); err == nil {
		token := storedAPIToken(data)
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
		_ = os.Remove(tokenPath)
		return "", "", fmt.Errorf("write TrueDown API Key: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(tokenPath)
		return "", "", fmt.Errorf("sync TrueDown API Key: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tokenPath)
		return "", "", fmt.Errorf("close TrueDown API Key: %w", err)
	}
	return token, tokenPath, nil
}

func storedAPIToken(data []byte) string {
	if len(data) >= 2 && data[len(data)-2] == '\r' && data[len(data)-1] == '\n' {
		return string(data[:len(data)-2])
	}
	if len(data) >= 1 && data[len(data)-1] == '\n' {
		return string(data[:len(data)-1])
	}
	return string(data)
}

func validateAPIToken(token string) error {
	const message = "token must contain 32 to 256 printable ASCII bytes without surrounding whitespace"
	if len(token) < 32 || len(token) > 256 || strings.TrimSpace(token) != token {
		return fmt.Errorf("%s", message)
	}
	for _, character := range []byte(token) {
		if character < 0x20 || character > 0x7e {
			return fmt.Errorf("%s", message)
		}
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
	if err := cmd.Start(); err == nil {
		if runtime.GOOS == "windows" {
			_ = cmd.Process.Release()
		} else {
			go func() { _ = cmd.Wait() }()
		}
	}
}
