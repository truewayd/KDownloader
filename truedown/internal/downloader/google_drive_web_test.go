package downloader

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseGoogleDriveReferenceSupportsGdownURLShapes(t *testing.T) {
	fileID := "0B9P1L--7Wd2vU3VUVlFnbTgtS2c"
	tests := []struct {
		value      string
		folder     bool
		nativeType string
	}{
		{"https://drive.google.com/file/d/" + fileID + "/view?usp=sharing", false, ""},
		{"https://drive.google.com/file/u/2/d/" + fileID + "/edit", false, ""},
		{"https://drive.google.com/open?id=" + fileID, false, ""},
		{"https://drive.google.com/uc?export=download&id=" + fileID, false, ""},
		{"https://docs.google.com/document/d/" + fileID + "/edit", false, "document"},
		{"https://docs.google.com/spreadsheets/u/1/d/" + fileID + "/view", false, "spreadsheets"},
		{"https://docs.google.com/presentation/d/" + fileID + "/edit", false, "presentation"},
		{"https://drive.google.com/drive/folders/" + fileID, true, ""},
	}
	for _, testCase := range tests {
		reference, ok := parseGoogleDriveReference(testCase.value)
		if !ok || reference.ID != fileID || reference.Folder != testCase.folder || reference.NativeType != testCase.nativeType {
			t.Fatalf("parse %q = %+v, %v", testCase.value, reference, ok)
		}
	}
	for _, value := range []string{
		"http://drive.google.com/file/d/" + fileID + "/view",
		"https://drive.google.com.example.test/file/d/" + fileID + "/view",
		"https://example.test/file/d/" + fileID + "/view",
	} {
		if _, ok := parseGoogleDriveReference(value); ok {
			t.Fatalf("unsafe Google Drive URL was accepted: %s", value)
		}
	}
}

func TestGoogleDriveConfirmationFormIsConvertedToTrustedURL(t *testing.T) {
	html := `<form id="download-form" action="https://drive.usercontent.google.com/download">
		<input type="hidden" name="id" value="file-id-1234567890">
		<input type="hidden" name="confirm" value="token&amp;safe">
	</form>`
	resolved, err := googleDriveConfirmationURL(html, "https://drive.google.com/uc?id=file-id-1234567890")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(resolved)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Hostname() != "drive.usercontent.google.com" || parsed.Query().Get("id") != "file-id-1234567890" ||
		parsed.Query().Get("confirm") != "token&safe" {
		t.Fatalf("unexpected confirmation URL: %s", resolved)
	}
	if _, err := googleDriveConfirmationURL(
		`<form id="download-form" action="https://evil.example/download"></form>`,
		"https://drive.google.com/uc?id=file-id-1234567890",
	); err == nil {
		t.Fatal("untrusted confirmation action was accepted")
	}
}

func TestResolveGoogleDriveDownloadFollowsLargeFileConfirmation(t *testing.T) {
	fileID := "0B9P1L--7Wd2vU3VUVlFnbTgtS2c"
	requests := 0
	base := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Query().Get("confirm") == "download-token" {
			return googleDriveTestResponse(request, http.StatusOK, "payload", http.Header{
				"Content-Type":        []string{"application/octet-stream"},
				"Content-Disposition": []string{`attachment; filename="archive.bin"`},
				"Content-Length":      []string{"7"},
			}), nil
		}
		return googleDriveTestResponse(request, http.StatusOK, `<html><body>
			<form id="download-form" action="https://drive.google.com/uc">
			<input type="hidden" name="id" value="`+fileID+`">
			<input type="hidden" name="export" value="download">
			<input type="hidden" name="confirm" value="download-token">
			</form></body></html>`, http.Header{
			"Content-Type": []string{"text/html; charset=utf-8"},
			"Set-Cookie":   []string{"download_warning=download-token; Path=/; Secure"},
		}), nil
	})}
	metadata, headers, err := resolveGoogleDriveDownload(
		context.Background(),
		&Task{Link: "https://drive.google.com/file/d/" + fileID + "/view", Headers: map[string]string{}},
		base,
	)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || metadata.Name != "archive.bin" || metadata.Length != 7 || !metadata.LengthKnown ||
		!strings.Contains(metadata.URL, "confirm=download-token") {
		t.Fatalf("requests=%d metadata=%+v", requests, metadata)
	}
	if !strings.Contains(headers["Cookie"], "download_warning=download-token") {
		t.Fatalf("confirmation cookie was not prepared for aria2: %+v", headers)
	}
}

func TestSubmitGoogleDriveTaskRefreshesURLBeforeAria2(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	fileID := "0B9P1L--7Wd2vU3VUVlFnbTgtS2c"
	stable := googleDriveStableLink(fileID, "", "")
	task, duplicate, err := manager.AddTask(stable, "archive.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil || duplicate {
		t.Fatalf("add Google Drive task: task=%+v duplicate=%v err=%v", task, duplicate, err)
	}
	manager.flushAdmissions(false)
	manager.googleDriveClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Query().Get("confirm") == "fresh-token" {
			return googleDriveTestResponse(request, http.StatusOK, "payload", http.Header{
				"Content-Type":        []string{"application/octet-stream"},
				"Content-Disposition": []string{`attachment; filename="archive.bin"`},
				"Content-Length":      []string{"7"},
			}), nil
		}
		return googleDriveTestResponse(request, http.StatusOK, `<form id="download-form" action="https://drive.google.com/uc">
			<input type="hidden" name="id" value="`+fileID+`">
			<input type="hidden" name="confirm" value="fresh-token">
		</form>`, http.Header{
			"Content-Type": []string{"text/html"},
			"Set-Cookie":   []string{"download_warning=fresh-token; Path=/; Secure"},
		}), nil
	})}
	manager.googleDriveProxy = func(*http.Request) (*url.URL, error) {
		return url.Parse("http://127.0.0.1:10809")
	}
	fake := &fakeAriaRPC{}
	manager.rpc = fake
	if !manager.submit(submission{id: task.ID}) {
		t.Fatal("Google Drive task was not admitted")
	}
	if len(fake.added) != 1 || !strings.Contains(fake.added[0].Link, "confirm=fresh-token") ||
		!strings.Contains(fake.added[0].Headers["Cookie"], "download_warning=fresh-token") {
		t.Fatalf("aria2 did not receive refreshed Google Drive data: %+v", fake.added)
	}
	if fake.addedOptions[0]["https-proxy"] != "http://127.0.0.1:10809" {
		t.Fatalf("aria2 did not receive the Google Drive proxy: %+v", fake.addedOptions)
	}
	persisted, ok := manager.GetTask(task.ID)
	if !ok || persisted.Link != stable || persisted.ModuleID != GoogleDriveModuleID || persisted.TotalLength != 7 {
		t.Fatalf("stable Google Drive task metadata was not persisted: %+v", persisted)
	}
}

func TestResolveGoogleDriveNativeFileUsesRequestedExportFormat(t *testing.T) {
	fileID := "slides-file-id-123456789012"
	requests := 0
	base := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if strings.Contains(request.URL.Path, "/presentation/") && strings.Contains(request.URL.Path, "/export") {
			return googleDriveTestResponse(request, http.StatusOK, "pdf", http.Header{
				"Content-Type":        []string{"application/pdf"},
				"Content-Disposition": []string{`attachment; filename="deck.pdf"`},
				"Content-Length":      []string{"3"},
			}), nil
		}
		return googleDriveTestResponse(request, http.StatusOK, "pptx", http.Header{
			"Content-Type":        []string{"application/vnd.openxmlformats-officedocument.presentationml.presentation"},
			"Content-Disposition": []string{`attachment; filename="deck.pptx"`},
			"Content-Length":      []string{"4"},
		}), nil
	})}
	metadata, _, err := resolveGoogleDriveDownload(context.Background(), &Task{
		Link: googleDriveStableLink(fileID, "presentation", "pdf"),
	}, base)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || metadata.Name != "deck.pdf" || !strings.Contains(metadata.URL, "/presentation/") {
		t.Fatalf("requests=%d metadata=%+v", requests, metadata)
	}
}

func TestCrawlGoogleDriveFolderRecursesAndKeepsNativeTypes(t *testing.T) {
	rootID := "root-folder-id-123456789012345"
	childID := "child-folder-id-12345678901234"
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		folderID := request.URL.Query().Get("id")
		if folderID == rootID {
			return googleDriveTestResponse(request, http.StatusOK, `<html><head><title>Shared Root</title></head><body>
				<a href="https://drive.google.com/file/d/file-regular-id-123456789012/view">image.png</a>
				<a href="https://docs.google.com/document/d/document-file-id-123456789012/edit">notes</a>
				<a href="https://drive.google.com/drive/folders/`+childID+`">nested</a>
			</body></html>`, http.Header{"Content-Type": []string{"text/html"}}), nil
		}
		if folderID == childID {
			return googleDriveTestResponse(request, http.StatusOK, `<html><head><title>nested</title></head><body>
				<a href="https://drive.google.com/file/d/child-file-id-123456789012345/view">child.bin</a>
			</body></html>`, http.Header{"Content-Type": []string{"text/html"}}), nil
		}
		t.Fatalf("unexpected folder ID %q", folderID)
		return nil, nil
	})}
	files, name, err := crawlGoogleDriveFolder(context.Background(), client, rootID)
	if err != nil {
		t.Fatal(err)
	}
	if name != "Shared Root" || len(files) != 3 {
		t.Fatalf("name=%q files=%+v", name, files)
	}
	if files[1].NativeType != "document" || len(files[2].Relative) != 1 || files[2].Relative[0] != "nested" {
		t.Fatalf("folder structure was not preserved: %+v", files)
	}
}

func TestGoogleDriveFolderModuleCreatesIndependentTasks(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	folderID := "root-folder-id-123456789012345"
	manager.googleDriveClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return googleDriveTestResponse(request, http.StatusOK, `<html><head><title>Drive Root</title></head><body>
			<a href="https://drive.google.com/file/d/file-regular-id-123456789012/view">image.png</a>
			<a href="https://docs.google.com/presentation/d/slides-file-id-123456789012/edit">deck</a>
		</body></html>`, http.Header{"Content-Type": []string{"text/html"}}), nil
	})}
	result, handled, err := manager.AddWithModules(
		context.Background(), "https://drive.google.com/drive/folders/"+folderID,
		"", "", nil, "", 0, Aria2Opts{}, nil,
	)
	if err != nil || !handled {
		t.Fatalf("handled=%v result=%+v err=%v", handled, result, err)
	}
	if !result.Collection || result.ModuleID != GoogleDriveModuleID || len(result.Tasks) != 2 {
		t.Fatalf("unexpected module result: %+v", result)
	}
	if result.Tasks[0].ModuleID != GoogleDriveModuleID || result.Tasks[1].Name != "deck.pptx" ||
		filepath.Base(result.Tasks[0].Folder) != "Drive Root" {
		t.Fatalf("unexpected Google Drive tasks: %+v", result.Tasks)
	}
}

func TestResolverModuleInstallationPersists(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "records.db")
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetModuleInstalled(GoogleDriveModuleID, false); err != nil {
		t.Fatal(err)
	}
	manager.Stop()
	reopened, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Stop()
	found := false
	for _, module := range reopened.Modules() {
		if module.ID == GoogleDriveModuleID {
			found = true
			if module.Installed {
				t.Fatalf("Google Drive module installation state was not persisted: %+v", module)
			}
		}
	}
	if !found {
		t.Fatal("Google Drive module disappeared from the registry")
	}
}

func TestResolverTaskModuleIDPersists(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "records.db")
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	task, _, err := manager.AddTask(
		googleDriveStableLink("persisted-file-id-1234567890", "", ""),
		"persisted.bin", "", nil, "", 0, Aria2Opts{},
	)
	if err != nil {
		t.Fatal(err)
	}
	manager.Stop()
	reopened, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Stop()
	persisted, ok := reopened.GetTask(task.ID)
	if !ok || persisted.ModuleID != GoogleDriveModuleID {
		t.Fatalf("resolver module ID was not persisted: %+v", persisted)
	}
}

func TestGoogleDriveModuleLive(t *testing.T) {
	value := strings.TrimSpace(os.Getenv("TRUEDOWN_GOOGLE_DRIVE_TEST_URL"))
	if value == "" {
		t.Skip("set TRUEDOWN_GOOGLE_DRIVE_TEST_URL to exercise the current public Google Drive protocol")
	}
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	result, handled, err := manager.AddWithModules(context.Background(), value, "", "", nil, "", 0, Aria2Opts{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !handled || len(result.Tasks) == 0 {
		t.Fatalf("Google Drive link was not resolved: handled=%v result=%+v", handled, result)
	}
	for _, task := range result.Tasks {
		if task.ModuleID != GoogleDriveModuleID || task.Name == "" {
			t.Fatalf("invalid Google Drive task: %+v", task)
		}
	}
	t.Logf("resolved %d Google Drive task(s)", len(result.Tasks))
}

func googleDriveTestResponse(request *http.Request, status int, body string, headers http.Header) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     headers,
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    request,
	}
}
