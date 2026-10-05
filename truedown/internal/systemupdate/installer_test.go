package systemupdate

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func makeInstallerFixture(t *testing.T, build byte) ([]byte, []nativeFile) {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Skip("executing installer fixtures requires Windows")
	}
	root := t.TempDir()
	payload := map[string][]byte{}
	files := []nativeFile{}
	for _, name := range nativeNames {
		data := nativePayload(name, build)
		payload[name] = data
		files = append(files, nativeMetadata(name, data))
	}
	encoded, _ := json.Marshal(payload)
	source := `package main
import("encoding/json";"os";"path/filepath";"strings")
func main(){args:=os.Args[1:];if len(args)!=4 || args[0]!="/S" || args[1]!="/UPDATE" || args[2]!="/TRUEDOWN-STAGE" || !strings.HasPrefix(args[3],"/D="){os.Exit(2)};dir:=strings.TrimPrefix(args[3],"/D=");var files map[string][]byte;if json.Unmarshal([]byte(` + "`" + string(encoded) + "`" + `),&files)!=nil{os.Exit(3)};for name,data:=range files{if os.WriteFile(filepath.Join(dir,name),data,0600)!=nil{os.Exit(4)}}}`
	path := filepath.Join(root, "fixture.go")
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "setup.exe")
	command := exec.Command("go", "build", "-o", binary, path)
	command.Env = append(os.Environ(), "GOOS=windows", "GOARCH=386", "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build installer fixture: %v: %s", err, output)
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	return data, files
}

func TestInstallerDiscoveryDoesNotFallBackToZip(t *testing.T) {
	release := githubRelease{TagName: "truedown-build-95", Assets: []githubAsset{
		{Name: "TrueDown-build-95.zip", Size: 10}, {Name: "truedown-update-95.json", Size: 10},
	}}
	if available, _ := selectTrueDownRelease([]githubRelease{release}, 94); available != nil {
		t.Fatal("legacy ZIP selected")
	}
	release.Assets = append(release.Assets, githubAsset{Name: installerAssetName(95), Size: 10}, githubAsset{Name: "truedown-installer-update-95.json", Size: 10})
	available, err := selectTrueDownRelease([]githubRelease{release}, 94)
	if err != nil || available == nil || !strings.HasSuffix(available.ArchiveName, "-setup.exe") {
		t.Fatalf("installer not selected: %v", err)
	}
}

func TestInstallerCleanupReceiptIsBuildBound(t *testing.T) {
	receipt := updateDownload{Build: 95, Name: installerAssetName(95), Size: 100, SHA256: strings.Repeat("a", 64)}
	if !receipt.valid() {
		t.Fatal("installer cleanup receipt rejected")
	}
	receipt.Build++
	if receipt.valid() {
		t.Fatal("cross-build cleanup receipt accepted")
	}
}
