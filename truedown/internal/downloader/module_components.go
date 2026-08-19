package downloader

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	modulePackageSchemaVersion = 1
	maxModulePackageBytes      = 64 * 1024
)

//go:embed module_baselines/*.json
var moduleBaselineFS embed.FS

type componentPackage struct {
	SchemaVersion int             `json:"schemaVersion"`
	ID            string          `json:"id"`
	Engine        string          `json:"engine"`
	Version       string          `json:"version"`
	ReleasedAt    string          `json:"releasedAt"`
	Config        json.RawMessage `json:"config"`
}

// ModulePackageInstallRequest is the bounded dashboard/API envelope used to
// install and hot-activate one declarative resolver component package.
type ModulePackageInstallRequest struct {
	Package json.RawMessage `json:"package"`
}

type resolverComponentFactory struct {
	id           string
	engine       string
	baselinePath string
	build        func(componentPackage) (resolverModule, error)
}

type loadedComponent struct {
	packageInfo componentPackage
	module      resolverModule
	digest      string
	source      string
}

func resolverComponentFactories() []resolverComponentFactory {
	return []resolverComponentFactory{
		{
			id: DropboxModuleID, engine: "dropbox-v1",
			baselinePath: "module_baselines/dropbox.json", build: newDropboxResolverModule,
		},
		{
			id: GoogleDriveModuleID, engine: "google-drive-v1",
			baselinePath: "module_baselines/google-drive.json", build: newGoogleDriveResolverModule,
		},
	}
}

func loadBaselineComponent(factory resolverComponentFactory) (loadedComponent, error) {
	raw, err := moduleBaselineFS.ReadFile(factory.baselinePath)
	if err != nil {
		return loadedComponent{}, fmt.Errorf("read %s baseline component: %w", factory.id, err)
	}
	return decodeComponent(factory, raw, "baseline")
}

func decodeComponent(factory resolverComponentFactory, raw []byte, source string) (loadedComponent, error) {
	if len(raw) == 0 || len(raw) > maxModulePackageBytes {
		return loadedComponent{}, &ValidationError{Message: "resolver component package must be between 1 byte and 64 KiB"}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var pkg componentPackage
	if err := decoder.Decode(&pkg); err != nil {
		return loadedComponent{}, &ValidationError{Message: fmt.Sprintf("invalid resolver component package: %v", err)}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return loadedComponent{}, &ValidationError{Message: "resolver component package must contain one JSON object"}
	}
	if pkg.SchemaVersion != modulePackageSchemaVersion {
		return loadedComponent{}, &ValidationError{Message: fmt.Sprintf("unsupported resolver component package schema %d", pkg.SchemaVersion)}
	}
	pkg.ID = strings.TrimSpace(pkg.ID)
	pkg.Engine = strings.TrimSpace(pkg.Engine)
	pkg.Version = strings.TrimSpace(pkg.Version)
	pkg.ReleasedAt = strings.TrimSpace(pkg.ReleasedAt)
	if pkg.ID != factory.id {
		return loadedComponent{}, &ValidationError{Message: fmt.Sprintf("resolver component package ID must be %q", factory.id)}
	}
	if pkg.Engine != factory.engine {
		return loadedComponent{}, &ValidationError{Message: fmt.Sprintf("resolver component engine must be %q", factory.engine)}
	}
	if _, err := parseComponentVersion(pkg.Version); err != nil {
		return loadedComponent{}, &ValidationError{Message: err.Error()}
	}
	if _, err := time.Parse("2006-01-02", pkg.ReleasedAt); err != nil {
		return loadedComponent{}, &ValidationError{Message: "resolver component releasedAt must use YYYY-MM-DD"}
	}
	trimmedConfig := bytes.TrimSpace(pkg.Config)
	if len(trimmedConfig) == 0 || trimmedConfig[0] != '{' {
		return loadedComponent{}, &ValidationError{Message: "resolver component config must be a JSON object"}
	}
	module, err := factory.build(pkg)
	if err != nil {
		return loadedComponent{}, err
	}
	canonical, err := json.Marshal(pkg)
	if err != nil {
		return loadedComponent{}, fmt.Errorf("encode resolver component package: %w", err)
	}
	digest := sha256.Sum256(canonical)
	return loadedComponent{
		packageInfo: pkg,
		module:      module,
		digest:      hex.EncodeToString(digest[:]),
		source:      source,
	}, nil
}

func parseComponentVersion(value string) ([3]int, error) {
	var result [3]int
	parts := strings.Split(value, ".")
	if len(parts) != len(result) {
		return result, fmt.Errorf("resolver component version must use major.minor.patch")
	}
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return result, fmt.Errorf("resolver component version must use canonical major.minor.patch")
		}
		parsed, err := strconv.Atoi(part)
		if err != nil || parsed < 0 || parsed > 999999 {
			return result, fmt.Errorf("resolver component version is invalid")
		}
		result[index] = parsed
	}
	return result, nil
}

func compareComponentVersions(left, right string) int {
	a, _ := parseComponentVersion(left)
	b, _ := parseComponentVersion(right)
	for index := range a {
		if a[index] < b[index] {
			return -1
		}
		if a[index] > b[index] {
			return 1
		}
	}
	return 0
}

func marshalComponentPackage(pkg componentPackage) ([]byte, error) {
	data, err := json.MarshalIndent(pkg, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func writeComponentPackage(path string, data []byte) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".component-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	backupPath := path + ".bak"
	_ = os.Remove(backupPath)
	if _, err := os.Stat(path); err == nil {
		if err := os.Rename(path, backupPath); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Rename(backupPath, path)
		return err
	}
	_ = os.Remove(backupPath)
	return nil
}

func readComponentPackage(path string) ([]byte, error) {
	data, err := readBoundedComponentFile(path)
	if os.IsNotExist(err) {
		data, err = readBoundedComponentFile(path + ".bak")
	}
	return data, err
}

func readBoundedComponentFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxModulePackageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxModulePackageBytes {
		return nil, fmt.Errorf("resolver component package exceeds 64 KiB")
	}
	return data, nil
}

func validComponentHeaderValue(value string, maxLength int) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxLength {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < 0x20 || value[index] == 0x7f {
			return false
		}
	}
	return true
}

func validComponentCookieName(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || strings.ContainsRune("!#$%&'*+-.^_`|~", rune(char)) {
			continue
		}
		return false
	}
	return true
}

func validComponentPath(value string) bool {
	if !strings.HasPrefix(value, "/") || len(value) > 256 ||
		strings.ContainsAny(value, "?#\\\r\n") || strings.Contains(value, "//") {
		return false
	}
	for _, segment := range strings.Split(value[1:], "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}
