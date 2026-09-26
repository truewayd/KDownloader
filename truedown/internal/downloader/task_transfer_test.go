package downloader

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTransferPiecesAndConnectionRedaction(t *testing.T) {
	var servers []ariaTransferServer
	if err := json.Unmarshal([]byte(`[{"index":"1","servers":[{"currentUri":"https://user:secret@cdn.example.test/file?token=secret#fragment","downloadSpeed":"4096"}]}]`), &servers); err != nil {
		t.Fatal(err)
	}
	status := ariaTransferStatus{NumPieces: "9", PieceLength: "1024", Bitfield: "aaff", Connections: "1"}
	snapshot := transferSnapshot(status, servers, true)
	if snapshot.CompletedPieces != 5 || len(snapshot.Pieces) != 9 || snapshot.Pieces[0].Completed != 1 || snapshot.Pieces[1].Completed != 0 {
		t.Fatalf("MSB-first pieces or padding bits were misread: %+v", snapshot)
	}
	encoded, _ := json.Marshal(snapshot)
	if strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "/file") || snapshot.Servers[0].Host != "cdn.example.test" {
		t.Fatal("redirect credentials escaped the engine boundary", string(encoded))
	}
	for _, malformed := range []string{"af", "not-hex", strings.Repeat("f", 1024)} {
		status.Bitfield = malformed
		if result := transferSnapshot(status, nil, false); len(result.Pieces) != 0 || result.PieceCount != 0 {
			t.Fatal("invalid bitmap became a completion claim")
		}
	}
	status.NumPieces, status.Bitfield = "1024", strings.Repeat("f", 256)
	if result := transferSnapshot(status, nil, false); len(result.Pieces) > 96 || result.CompletedPieces != 1024 {
		t.Fatal("piece aggregation lost data or exceeded the UI bound", result)
	}
	servers = append(servers, servers...)
	for len(servers) < 128 {
		servers = append(servers, servers...)
	}
	if result := transferSnapshot(status, servers, true); len(result.Servers) != 64 || !result.ServersTruncated {
		t.Fatal("unbounded connection list")
	}
}

type transferRPCStub struct {
	*fakeAriaRPC
	read func(context.Context, string) (ariaTransferStatus, []ariaTransferServer, bool, error)
}

func (stub *transferRPCStub) transfer(ctx context.Context, gid string) (ariaTransferStatus, []ariaTransferServer, bool, error) {
	return stub.read(ctx, gid)
}

func TestLiveTaskDetailsRejectsChangedTaskAndReleasesSlots(t *testing.T) {
	task := &Task{ID: 1, GID: "0123456789abcdef", Status: StatusDownloading, TotalLength: 90}
	m := &Manager{tasks: map[int64]*Task{1: task}}
	rpc := &transferRPCStub{fakeAriaRPC: &fakeAriaRPC{}}
	m.rpc = rpc
	rpc.read = func(ctx context.Context, gid string) (ariaTransferStatus, []ariaTransferServer, bool, error) {
		// The request must not retain the task lock across engine I/O.
		m.mu.Lock()
		task.Status = StatusPaused
		m.mu.Unlock()
		return ariaTransferStatus{GID: gid, TotalLength: "100", DownloadSpeed: "500"}, nil, true, nil
	}
	detail, err := m.LiveTaskDetails(context.Background(), 1)
	if err != nil || detail.Transfer != nil || detail.Status != StatusPaused || detail.TotalLength != 90 {
		t.Fatal("stale live transfer replaced a newer task", detail, err)
	}
	rpc.read = func(ctx context.Context, gid string) (ariaTransferStatus, []ariaTransferServer, bool, error) {
		return ariaTransferStatus{GID: gid, TotalLength: "100", CompletedLength: "25", DownloadSpeed: "0"}, nil, true, nil
	}
	detail, err = m.LiveTaskDetails(context.Background(), 1)
	if err != nil || !detail.Transfer.Available || detail.CompletedLength != 25 || task.TotalLength != 90 {
		t.Fatal("live view must not mutate stored history", detail, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.LiveTaskDetails(ctx, 1); !errors.Is(err, context.Canceled) || m.detailReads.Load() != 0 {
		t.Fatal("cancellation retained a slot", err)
	}
	m.detailReads.Store(4)
	rpc.read = func(context.Context, string) (ariaTransferStatus, []ariaTransferServer, bool, error) {
		t.Fatal("read exceeded concurrency limit")
		return ariaTransferStatus{}, nil, false, nil
	}
	if detail, err := m.LiveTaskDetails(context.Background(), 1); err != nil || detail.Transfer.Available || m.detailReads.Load() != 4 {
		t.Fatal("busy engine read did not return the stored snapshot")
	}
}

func TestAriaTransferQueriesAndCancellation(t *testing.T) {
	const gid = "0123456789abcdef"
	methods := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		methods = append(methods, request.Method)
		if string(request.Params[0]) != `"token:secret"` || string(request.Params[1]) != `"`+gid+`"` {
			t.Error("wrong RPC identity")
		}
		if request.Method == "aria2.tellStatus" {
			if !strings.Contains(string(request.Params[2]), "bitfield") {
				t.Error("missing bitmap request")
			}
			_, _ = w.Write([]byte(`{"result":{"gid":"0123456789abcdef","status":"active","numPieces":"8","pieceLength":"1024","bitfield":"f0"}}`))
		} else {
			_, _ = w.Write([]byte(`{"error":{"code":1,"message":"unsupported"}}`))
		}
	}))
	defer server.Close()
	client := newAriaClient(0, "secret")
	client.url = server.URL
	status, _, serversAvailable, err := client.transfer(context.Background(), gid)
	if err != nil || status.Bitfield != "f0" || serversAvailable || strings.Join(methods, ",") != "aria2.tellStatus,aria2.getServers" {
		t.Fatal("optional server failure discarded usable progress", status, methods, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := client.transfer(ctx, gid); !errors.Is(err, context.Canceled) {
		t.Fatal("RPC ignored cancellation", err)
	}
}
