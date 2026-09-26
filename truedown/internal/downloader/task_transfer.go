package downloader

import (
	"context"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

// Detailed engine data is read only for the open task, never for every list row.
type TaskTransfer struct {
	Available        bool                 `json:"available"`
	Connections      int64                `json:"connections"`
	PieceCount       int64                `json:"pieceCount"`
	PieceLength      int64                `json:"pieceLength"`
	CompletedPieces  int64                `json:"completedPieces"`
	Pieces           []TaskPieceRange     `json:"pieces,omitempty"`
	ServersAvailable bool                 `json:"serversAvailable"`
	ServersTruncated bool                 `json:"serversTruncated,omitempty"`
	Servers          []TaskTransferServer `json:"servers,omitempty"`
}

type TaskPieceRange struct {
	First     int64 `json:"first"`
	Count     int64 `json:"count"`
	Completed int64 `json:"completed"`
}

type TaskTransferServer struct {
	FileIndex     int64  `json:"fileIndex"`
	Host          string `json:"host"`
	DownloadSpeed int64  `json:"downloadSpeed"`
}

type ariaTransferStatus struct {
	GID             string `json:"gid"`
	Status          string `json:"status"`
	TotalLength     string `json:"totalLength"`
	CompletedLength string `json:"completedLength"`
	DownloadSpeed   string `json:"downloadSpeed"`
	Connections     string `json:"connections"`
	Bitfield        string `json:"bitfield"`
	NumPieces       string `json:"numPieces"`
	PieceLength     string `json:"pieceLength"`
}

type ariaTransferServer struct {
	Index   string `json:"index"`
	Servers []struct {
		CurrentURI    string `json:"currentUri"`
		DownloadSpeed string `json:"downloadSpeed"`
	} `json:"servers"`
}

type taskTransferRPC interface {
	transfer(context.Context, string) (ariaTransferStatus, []ariaTransferServer, bool, error)
}

func (c *ariaClient) transfer(ctx context.Context, gid string) (ariaTransferStatus, []ariaTransferServer, bool, error) {
	keys := []string{"gid", "status", "totalLength", "completedLength", "downloadSpeed", "connections", "bitfield", "numPieces", "pieceLength"}
	var status ariaTransferStatus
	if err := c.callContext(ctx, "aria2.tellStatus", []any{gid, keys}, &status); err != nil {
		return status, nil, false, err
	}
	if status.GID != gid {
		return status, nil, false, fmt.Errorf("unexpected transfer identity")
	}
	var servers []ariaTransferServer
	// Paused/finished tasks have no live connections; some engines reject getServers.
	if status.Status != "active" {
		return status, nil, true, nil
	}
	err := c.callContext(ctx, "aria2.getServers", []any{gid}, &servers)
	return status, servers, err == nil, nil
}

func transferNumber(value string) int64 {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 || n > 9_007_199_254_740_991 {
		return 0
	}
	return n
}

func transferSnapshot(status ariaTransferStatus, servers []ariaTransferServer, serversAvailable bool) *TaskTransfer {
	result := &TaskTransfer{Available: true, Connections: transferNumber(status.Connections), ServersAvailable: serversAvailable}
	count, size := transferNumber(status.NumPieces), transferNumber(status.PieceLength)
	// At most 4M pieces are decoded and at most 96 ranges cross the UI boundary.
	if count > 0 && count <= 4*1024*1024 && size > 0 && int64(len(status.Bitfield)) == ((count+7)/8)*2 {
		if bitmap, err := hex.DecodeString(status.Bitfield); err == nil {
			result.PieceCount, result.PieceLength = count, size
			width := (count + 95) / 96
			for first := int64(0); first < count; first += width {
				part := TaskPieceRange{First: first, Count: min(width, count-first)}
				for index := first; index < first+part.Count; index++ {
					if bitmap[index/8]&(0x80>>uint(index%8)) != 0 {
						part.Completed++
					}
				}
				result.CompletedPieces += part.Completed
				result.Pieces = append(result.Pieces, part)
			}
		}
	}
	if !serversAvailable {
		return result
	}
	for _, file := range servers {
		for _, server := range file.Servers {
			if len(result.Servers) == 64 {
				result.ServersTruncated = true
				return result
			}
			// Redirect URLs may carry credentials or signed queries. Expose only a host.
			host := ""
			if len(server.CurrentURI) <= 16*1024 {
				if parsed, err := url.Parse(server.CurrentURI); err == nil && len(parsed.Hostname()) <= 253 {
					host = parsed.Hostname()
				}
			}
			result.Servers = append(result.Servers, TaskTransferServer{transferNumber(file.Index), host, transferNumber(server.DownloadSpeed)})
		}
	}
	return result
}

func (m *Manager) LiveTaskDetails(ctx context.Context, id int64) (TaskDetails, error) {
	m.mu.RLock()
	task := m.tasks[id]
	if task == nil {
		m.mu.RUnlock()
		return TaskDetails{}, ErrTaskNotFound
	}
	detail := m.taskDetails(task)
	gid, state, fingerprint, engine := task.GID, task.Status, task.Fingerprint, m.rpc
	m.mu.RUnlock()
	detail.Transfer = &TaskTransfer{}
	rpc, supported := engine.(taskTransferRPC)
	if !supported || gid == "" || state == StatusDone || state == StatusError {
		return detail, nil
	}
	if m.detailReads.Add(1) > 4 {
		m.detailReads.Add(-1)
		return detail, nil
	}
	defer m.detailReads.Add(-1)
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	status, servers, serversAvailable, err := rpc.transfer(ctx, gid)
	if ctx.Err() != nil {
		return detail, ctx.Err()
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	current := m.tasks[id]
	if current == nil {
		return TaskDetails{}, ErrTaskNotFound
	}
	if current != task || current.GID != gid || current.Status != state || current.Fingerprint != fingerprint || m.rpc != engine {
		return m.taskDetails(current), nil
	}
	if err != nil || status.GID != gid {
		return detail, nil
	}
	detail.Transfer = transferSnapshot(status, servers, serversAvailable)
	detail.TotalLength = transferNumber(status.TotalLength)
	detail.CompletedLength = transferNumber(status.CompletedLength)
	detail.DownloadSpeed = transferNumber(status.DownloadSpeed)
	return detail, nil
}
