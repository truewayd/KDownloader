package app

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"truedown/internal/api"
	"truedown/internal/applog"
	"truedown/internal/downloader"
	"truedown/internal/profile"
	"truedown/internal/protocol"
	"truedown/internal/safefile"
	"truedown/internal/systemupdate"
	"truedown/web"
)

// exeDir returns the directory that contains the running executable so
// packaged helpers are resolved correctly regardless of cwd.
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// BuildInfo describes this binary without package-level mutable state.
type BuildInfo struct {
	Version     string
	BuildNumber string
	Commit      string
}

// Options controls the shared service independently of any executable entry point.
type Options struct {
	DataDir           string
	Build             BuildInfo
	RelaunchArgs      []string
	DesktopAttachOnly bool
	desktop           *desktopCallbacks
}

// Run owns one profile's service until cancellation or an explicit exit request.
// Run does not terminate the calling process. It must not run concurrently in
// one process because application logging is process-wide.
func Run(ctx context.Context, options Options) (resultErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	if options.Build.Version == "" {
		options.Build.Version = "dev"
	}
	if options.Build.BuildNumber == "" {
		options.Build.BuildNumber = "0"
	}
	if options.Build.Commit == "" {
		options.Build.Commit = "unknown"
	}
	version, buildNumber, commit := options.Build.Version, options.Build.BuildNumber, options.Build.Commit
	base := exeDir()
	stableAria2, err := resolveStableAria2(base)
	if err != nil {
		return err
	}
	location, err := profile.Resolve(options.DataDir, base)
	if err != nil {
		return err
	}
	dataDir := location.DataDirectory
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return err
	}
	instance, alreadyRunning, err := acquireAppInstance(dataDir)
	if err != nil {
		return err
	}
	if alreadyRunning {
		instance.Close()
		log.Printf("another TrueDown instance owns %s", dataDir)
		if options.desktop != nil {
			tlsEnabled := strings.TrimSpace(os.Getenv("TRUEDOWN_TLS_CERT")) != ""
			addr, err := validateListenAddress(os.Getenv("TRUEDOWN_ADDR"), false, tlsEnabled, true)
			if err != nil {
				return err
			}
			return options.desktop.attach(browserURLForAddress(addr, tlsEnabled), location)
		}
		return nil
	}
	defer instance.Close()
	if options.DesktopAttachOnly {
		return fmt.Errorf("independent TrueDown core is not running")
	}
	location, err = profile.Initialize(ctx, location, downloader.CheckpointForProfileMigration)
	if err != nil {
		return err
	}
	applicationLog, err := applog.Open(location.Paths.Logs)
	if err != nil {
		return err
	}
	previousLogWriter := log.Writer()
	log.SetOutput(io.MultiWriter(applicationLog, previousLogWriter))
	defer func() {
		if resultErr != nil {
			log.Printf("fatal startup/runtime error: %v", resultErr)
		}
		if closeErr := applicationLog.Close(); closeErr != nil && resultErr == nil {
			resultErr = closeErr
		}
		log.SetOutput(previousLogWriter)
	}()
	log.Printf("TrueDown %s (build %s, commit %s) starting", version, buildNumber, commit)
	log.Printf("TrueDown data directory: %s (%s)", dataDir, location.Source)
	currentBuild, parseErr := strconv.ParseInt(strings.TrimSpace(buildNumber), 10, 64)
	if parseErr != nil || currentBuild < 0 {
		currentBuild = 0
	}
	nativeExecutable := ""
	if options.desktop != nil && runtime.GOOS == "windows" && currentBuild > 0 {
		nativeExecutable = os.Getenv("TRUEDOWN_DESKTOP_EXECUTABLE")
	}
	updates, err := systemupdate.New(systemupdate.Options{
		BaseDir:               base,
		DataDir:               dataDir,
		Paths:                 location.Paths,
		StableEnginePath:      stableAria2,
		CurrentVersion:        version,
		CurrentBuild:          currentBuild,
		CurrentCommit:         commit,
		DisableProgramUpdates: nativeExecutable == "",
		NativeExecutable:      nativeExecutable,
	})
	if err != nil {
		return err
	}
	downloads := location.Paths.Downloads
	database := location.Paths.File(profile.Database)
	auth, err := newAuthController(
		location.Paths.Config,
		os.Getenv("TRUEDOWN_REQUIRE_TOKEN") == "1",
		os.Getenv("TRUEDOWN_API_TOKEN"),
	)
	if err != nil {
		return err
	}
	tlsCert := strings.TrimSpace(os.Getenv("TRUEDOWN_TLS_CERT"))
	tlsKey := strings.TrimSpace(os.Getenv("TRUEDOWN_TLS_KEY"))
	if (tlsCert == "") != (tlsKey == "") {
		return fmt.Errorf("TRUEDOWN_TLS_CERT and TRUEDOWN_TLS_KEY must be configured together")
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
		return err
	}
	if !loopbackListener([]string{addr}) {
		auth.LockEnabled()
	}
	lifecycleExit := make(chan struct{}, 1)
	engineReload := make(chan struct{}, 1)
	host := &managerHost{}
	controller := newEngineController(updates, host, func() error {
		if engineRelaunchAttempt() >= 1 {
			return fmt.Errorf("automatic TrueDown reload was already attempted during this engine recovery incident")
		}
		select {
		case engineReload <- struct{}{}:
		default:
		}
		return nil
	})
	buildManager := func(spec systemupdate.EngineSpec) (*downloader.Manager, error) {
		return downloader.NewManagerWithConfig(spec.Path, downloads, database, downloader.ManagerConfig{
			Paths:            location.Paths,
			Aria2Next:        spec.Kind == systemupdate.EngineNext,
			Aria2NextVersion: spec.Version,
			EngineExit: func(source *downloader.Manager, exitErr error) {
				if controller != nil {
					controller.recover(source, exitErr)
				}
			},
		})
	}
	routes := func(manager *downloader.Manager) http.Handler {
		mux := http.NewServeMux()
		api.Register(mux, manager, auth, controller)
		api.RegisterInfo(mux, protocol.Info{Product: protocol.Product, ProtocolVersion: protocol.Version, Version: version, BuildNumber: buildNumber, Commit: commit, Mode: "serve"})
		api.RegisterStorage(mux, location)
		api.RegisterDiagnostics(mux, applicationLog)
		api.RegisterStartup(mux)
		api.RegisterLifecycle(mux, func() {
			select {
			case lifecycleExit <- struct{}{}:
			default:
			}
		})
		mux.Handle("/", http.FileServer(http.FS(web.Assets)))
		return mux
	}
	activeSpec := updates.ActiveEngine()
	dm, err := buildManager(activeSpec)
	if err != nil {
		return err
	}
	host.configure(dm, activeSpec, buildManager, routes)
	defer host.stop()
	startErr := dm.Start()
	if startErr != nil && activeSpec.Kind == systemupdate.EngineNext && downloader.IsEngineStartError(startErr) {
		dm.Stop()
		_ = updates.FallbackToStable(startErr)
		activeSpec = updates.ActiveEngine()
		log.Printf("Aria2 Next startup failed; retrying with the built-in stable engine: %v", startErr)
		dm, err = buildManager(activeSpec)
		if err != nil {
			return err
		}
		host.configure(dm, activeSpec, buildManager, routes)
		startErr = dm.Start()
	}
	if startErr != nil {
		dm.Stop()
		return startErr
	}

	log.Printf("TrueDown listening on %s", addr)
	if tokenPath := auth.TokenPath(); tokenPath != "" && authEnabled {
		log.Printf("TrueDown API Key is available from the dashboard and stored in %s", tokenPath)
	} else if !authEnabled {
		log.Printf("API Key authentication is disabled; enable it from the dashboard when needed")
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           secureHandler(host, auth, addr),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 * 1024,
	}
	restart := make(chan struct{}, 1)
	updates.SetRestartCallback(func() error {
		if controller.transitionActive() {
			return fmt.Errorf("wait for the download-engine transition before restarting TrueDown")
		}
		active := host.taskCount(downloader.StatusQueued) +
			host.taskCount(downloader.StatusDownloading) +
			host.taskCount(downloader.StatusPaused)
		if active > 0 {
			return fmt.Errorf("wait for queued, downloading, and paused tasks before restarting TrueDown")
		}
		if err := updates.LaunchPendingApply([]string{"--background", "--data-dir", dataDir}); err != nil {
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
	updateContext, cancelUpdates := context.WithCancel(ctx)
	defer cancelUpdates()
	automaticUpdatesDone := updates.RunAutomatic(updateContext, func() bool {
		return host.taskCount(downloader.StatusQueued) == 0 &&
			host.taskCount(downloader.StatusDownloading) == 0 &&
			host.taskCount(downloader.StatusPaused) == 0
	})
	select {
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("HTTP server: %v", err)
		}
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		_ = server.Close()
		cancelUpdates()
		<-automaticUpdatesDone
		return ctx.Err()
	case <-time.After(300 * time.Millisecond):
		resetEngineRelaunchCircuitAfterHealthyPeriod()
	}
	if options.desktop != nil {
		options.desktop.ready(host)
	}
	reloadEngine := false

waitForExit:
	for {
		select {
		case err := <-serverErr:
			if !errors.Is(err, http.ErrServerClosed) {
				log.Printf("HTTP server: %v", err)
				resultErr = err
			}
			break waitForExit
		case <-ctx.Done():
			break waitForExit
		case <-lifecycleExit:
			log.Printf("dashboard: exit requested")
			break waitForExit
		case <-restart:
			break waitForExit
		case <-engineReload:
			reloadEngine = true
			break waitForExit
		}
	}
	cancelUpdates()
	<-automaticUpdatesDone
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("HTTP shutdown: %v", err)
	}
	host.stop()
	if reloadEngine {
		_ = instance.Close()
		if options.desktop != nil {
			return fmt.Errorf("desktop core needs restart after engine recovery failure")
		}
		if err := launchEngineRelaunch(options.RelaunchArgs); err != nil {
			log.Printf("reload TrueDown after download-engine recovery failure: %v", err)
		}
	}
	log.Printf("TrueDown stopped cleanly")
	return resultErr
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
	return sameRequestOrigin(r, origin)
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
	tokenPath := profile.File(dataDir, profile.Token)
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
	if err != nil || !validOriginURL(parsed) {
		return false
	}
	if parsed.Scheme == "chrome-extension" && parsed.Host != "" {
		return true
	}
	return sameRequestOrigin(r, origin)
}

func validOriginURL(origin *url.URL) bool {
	return origin.Host != "" && origin.User == nil && origin.Path == "" &&
		origin.RawQuery == "" && !origin.ForceQuery && origin.Fragment == "" && origin.Opaque == ""
}

func sameRequestOrigin(r *http.Request, origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || !validOriginURL(parsed) {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return parsed.Scheme == scheme && strings.EqualFold(parsed.Host, r.Host)
}
