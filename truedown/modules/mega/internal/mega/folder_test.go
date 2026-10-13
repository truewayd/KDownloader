package mega

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func folderFixture() (Source, []folderNode) {
	source := Source{Folder: "SHAREAAA"}
	share, _ := aes.NewCipher(source.Key[:])
	node := func(h, p, name string, kind int) folderNode {
		key := bytes.Repeat([]byte{3}, 16)
		if kind == 0 {
			file := testLink()
			key = append([]byte{}, file.Key[:]...)
		}
		attributeBlock, _ := aes.NewCipher(key[:16])
		if kind == 0 {
			file := Link{}
			copy(file.Key[:], key)
			attributeBlock = file.block()
		}
		plain, _ := json.Marshal(map[string]string{"n": name})
		plain = append([]byte("MEGA"), plain...)
		plain = append(plain, make([]byte, (16-len(plain)%16)%16)...)
		cipher.NewCBCEncrypter(attributeBlock, make([]byte, 16)).CryptBlocks(plain, plain)
		encrypted := append([]byte{}, key...)
		for offset := 0; offset < len(key); offset += 16 {
			share.Encrypt(encrypted[offset:offset+16], encrypted[offset:offset+16])
		}
		return folderNode{Handle: h, Parent: p, Type: kind, Key: "ROOTAAAA:" + base64.RawURLEncoding.EncodeToString(encrypted), Attributes: base64.RawURLEncoding.EncodeToString(plain), Size: 0}
	}
	return source, []folderNode{node("ROOTAAAA", "", "root", 1), node("DIRAAAAA", "ROOTAAAA", "same", 1), node("DIRAAAAB", "ROOTAAAA", "same", 1), node("FILEAAAA", "DIRAAAAA", "a.PSD", 0), node("FILEAAAB", "DIRAAAAB", "b.txt", 0)}
}

func TestFolderDecryptionUsesNodeAncestryAndQualifiedDownloads(t *testing.T) {
	source, nodes := folderFixture()
	source.Node, source.NodeKind = "DIRAAAAA", "folder"
	client := NewClient()
	client.http.Transport = transportFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Query().Get("n") != source.Folder || request.URL.Query().Get("ak") != "" {
			t.Fatal("missing public folder context")
		}
		var commands []map[string]any
		json.NewDecoder(request.Body).Decode(&commands)
		if commands[0]["a"] == "f" {
			payload, _ := json.Marshal([]any{map[string]any{"f": nodes}})
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(payload))}, nil
		}
		if commands[0]["n"] != "FILEAAAA" || commands[0]["p"] != nil {
			t.Fatal("folder file incorrectly treated as public file")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewBufferString(`[{"g":"https://fixture.userstorage.mega.co.nz/file","s":0}]`))}, nil
	})
	collection, err := client.ListFolder(context.Background(), source)
	if err != nil || len(collection.Entries) != 1 || collection.Entries[0].Path[0] != "a.PSD" {
		t.Fatal("same-named sibling leaked into subtree", err)
	}
	entry := collection.Entries[0]
	child, err := ParseSource(entry.Source)
	if err != nil {
		t.Fatal(err)
	}
	metadata, _, err := client.ResolveFile(context.Background(), child, entry.Data)
	if err != nil || metadata.Name != "a.PSD" {
		t.Fatal("qualified child resolution", err)
	}
	var data FileData
	json.Unmarshal(entry.Data, &data)
	data.Size = 1
	changed, _ := json.Marshal(data)
	if _, _, err := client.ResolveFile(context.Background(), child, changed); err == nil {
		t.Fatal("changed child size accepted")
	}
}

func TestFolderRejectsWrongKeysCyclesAndMissingParents(t *testing.T) {
	for _, scenario := range []string{"key", "cycle", "parent", "selection"} {
		source, nodes := folderFixture()
		switch scenario {
		case "key":
			source.Key[0] = 1
		case "cycle":
			nodes[1].Parent = nodes[2].Handle
			nodes[2].Parent = nodes[1].Handle
		case "parent":
			nodes[3].Parent = "MISSINGA"
		case "selection":
			source.Node, source.NodeKind = "DIRAAAAA", "file"
		}
		client := NewClient()
		client.http.Transport = transportFunc(func(*http.Request) (*http.Response, error) {
			payload, _ := json.Marshal([]any{map[string]any{"f": nodes}})
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(payload))}, nil
		})
		if _, err := client.ListFolder(context.Background(), source); err == nil {
			t.Fatal("invalid folder accepted", scenario)
		}
	}
}

func TestFolderSourceShapesRequireCompleteKeys(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	for _, raw := range []string{"https://mega.nz/folder/SHAREAAA#" + key, "https://mega.co.nz/#F!SHAREAAA!" + key, "https://mega.nz/folder/SHAREAAA#" + key + "/folder/DIRAAAAA", "https://mega.nz/folder/SHAREAAA#" + key + "/file/FILEAAAA"} {
		if _, err := ParseSource(raw); err != nil {
			t.Fatal("valid folder shape", err)
		}
	}
	for _, raw := range []string{"https://mega.nz/folder/SHAREAAA", "https://mega.nz/folder/SHAREAAA#bad", "https://mega.nz:443/folder/SHAREAAA#" + key, "https://mega.nz/folder/SHAREAAA?ak=a#" + key, "https://mega.nz/folder/SHAREAAA#" + key + "/file/../a"} {
		if _, err := ParseSource(raw); err == nil {
			t.Fatal("invalid folder accepted")
		}
	}
}
