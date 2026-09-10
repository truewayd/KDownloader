package downloader

import (
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"strconv"
)

// Stable aria2 sometimes reports only "Download aborted" for malformed piece
// maps. Inspect a stopped HTTP task's map with bounded reads and no bitmap
// allocations. Unknown layouts and I/O errors remain engine-owned failures.
func invalidHTTPResumeControl(task *Task, remoteLength string) bool {
	if task.OutputName == "" {
		return false
	}
	_, control, err := inspectHTTPOutput(task)
	if err != nil || !control {
		return false
	}
	file, err := os.Open(filepath.Join(task.Folder, task.OutputName+".aria2"))
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	read := func(buffer []byte) bool {
		_, err := io.ReadFull(file, buffer)
		return err == nil
	}
	var prefix [10]byte
	if !read(prefix[:]) {
		return info.Size() < int64(len(prefix))
	}
	var order binary.ByteOrder = binary.BigEndian
	switch binary.BigEndian.Uint16(prefix[:2]) {
	case 0:
		order = binary.NativeEndian
	case 1:
	default:
		return prefix[0] != 0
	}
	hashLength := int64(order.Uint32(prefix[6:]))
	if hashLength > 20 {
		return true
	}
	if _, err := file.Seek(hashLength, io.SeekCurrent); err != nil {
		return false
	}
	var header [24]byte
	if !read(header[:]) {
		return info.Size() < 34+hashLength
	}
	pieceLength := uint64(order.Uint32(header[:4]))
	total := order.Uint64(header[4:12])
	bitmapLength := uint64(order.Uint32(header[20:]))
	if pieceLength == 0 || total > 1<<63-1 {
		return true
	}
	if remote, err := strconv.ParseUint(remoteLength, 10, 63); err == nil && remote > 0 && total != remote {
		return true
	}
	pieces := (total + pieceLength - 1) / pieceLength
	if bitmapLength != (pieces+7)/8 {
		return true
	}
	position := int64(34+hashLength) + int64(bitmapLength)
	if position+4 > info.Size() {
		return true
	}
	if _, err := file.Seek(position, io.SeekStart); err != nil {
		return false
	}
	var count [4]byte
	if !read(count[:]) {
		return false
	}
	inflight := uint64(order.Uint32(count[:]))
	position += 4
	if inflight > pieces || inflight > uint64((info.Size()-position)/12) {
		return true
	}
	if inflight > 4096 {
		return false
	}
	for i := uint64(0); i < inflight; i++ {
		var piece [12]byte
		if !read(piece[:]) {
			return false
		}
		index := uint64(order.Uint32(piece[:4]))
		length := uint64(order.Uint32(piece[4:8]))
		bitmap := uint64(order.Uint32(piece[8:]))
		if index >= pieces || length == 0 || length > pieceLength || bitmap != ((length+16383)/16384+7)/8 {
			return true
		}
		position += 12 + int64(bitmap)
		if position > info.Size() {
			return true
		}
		if _, err := file.Seek(position, io.SeekStart); err != nil {
			return false
		}
	}
	return false
}
