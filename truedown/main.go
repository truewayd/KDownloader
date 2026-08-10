package main

import (
	"context"
	"embed"
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
	api.Register(mux, dm)

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))

	addr, err := validateListenAddress(os.Getenv("TRUEDOWN_ADDR"), os.Getenv("TRUEDOWN_ALLOW_REMOTE") == "1")
	if err != nil {
		log.Fatal(err)
	}
	browserURL := browserURLForAddress(addr)
	log.Printf("TrueDown listening on %s", addr)
	if os.Getenv("TRUEDOWN_NO_BROWSER") == "" {
		go openBrowser(browserURL)
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           secureHandler(mux, addr),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 * 1024,
	}
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.ListenAndServe() }()
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

func validateListenAddress(value string, allowRemote bool) (string, error) {
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
	return addr, nil
}

func browserURLForAddress(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://127.0.0.1:15151"
	}
	plainHost := strings.Trim(host, "[]")
	if plainHost == "" || plainHost == "0.0.0.0" || plainHost == "::" {
		plainHost = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(plainHost, port)
}

func secureHandler(next http.Handler, listenAddresses ...string) http.Handler {
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
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !allowedRequestOrigin(r) {
			http.Error(w, "cross-origin request rejected", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
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
