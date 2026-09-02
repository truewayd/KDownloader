package applog

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	fileName       = "truedown.log"
	maximumBytes   = int64(4 * 1024 * 1024)
	maximumBackups = 3
	maximumWrite   = 64 * 1024
)

type Logger struct {
	mu   sync.Mutex
	path string
	file *os.File
	size int64
}

func Open(dataDir string) (*Logger, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("create TrueDown data directory: %w", err)
	}
	logger := &Logger{path: filepath.Join(dataDir, fileName)}
	if info, err := regularFileInfo(logger.path); err == nil && info.Size() >= maximumBytes {
		if err := logger.rotate(); err != nil {
			return nil, err
		}
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err := logger.open(); err != nil {
		return nil, err
	}
	return logger, nil
}

func (logger *Logger) Path() string {
	return logger.path
}

func (logger *Logger) Write(input []byte) (int, error) {
	logger.mu.Lock()
	defer logger.mu.Unlock()

	originalLength := len(input)
	data := input
	if len(data) > maximumWrite {
		cut := maximumWrite
		for cut > 0 && !utf8.Valid(input[:cut]) {
			cut--
		}
		data = append(append([]byte(nil), data[:cut]...), []byte("\n[log entry truncated]\n")...)
	}
	if logger.file == nil {
		return 0, fmt.Errorf("TrueDown application log is closed")
	}
	if logger.size > 0 && logger.size+int64(len(data)) > maximumBytes {
		if err := logger.file.Close(); err != nil {
			return 0, err
		}
		logger.file = nil
		if err := logger.rotate(); err != nil {
			return 0, err
		}
		if err := logger.open(); err != nil {
			return 0, err
		}
	}
	written, err := logger.file.Write(data)
	logger.size += int64(written)
	if err != nil {
		return written, err
	}
	return originalLength, nil
}

func (logger *Logger) ReadTail(limit int64) (content string, truncated bool, updatedAt time.Time, err error) {
	if limit < 1 || limit > maximumBytes {
		return "", false, time.Time{}, fmt.Errorf("application log limit must be between 1 and %d bytes", maximumBytes)
	}
	logger.mu.Lock()
	defer logger.mu.Unlock()

	if logger.file == nil {
		return "", false, time.Time{}, fmt.Errorf("TrueDown application log is closed")
	}
	if err := logger.file.Sync(); err != nil {
		return "", false, time.Time{}, err
	}
	info, err := regularFileInfo(logger.path)
	if err != nil {
		return "", false, time.Time{}, err
	}
	file, err := os.Open(logger.path)
	if err != nil {
		return "", false, time.Time{}, err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return "", false, time.Time{}, err
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) {
		return "", false, time.Time{}, fmt.Errorf("application log changed while opening")
	}
	start := int64(0)
	if openedInfo.Size() > limit {
		start = openedInfo.Size() - limit
		truncated = true
	}
	data := make([]byte, openedInfo.Size()-start)
	if len(data) > 0 {
		read, readErr := file.ReadAt(data, start)
		if readErr != nil && read != len(data) {
			return "", false, time.Time{}, readErr
		}
		data = data[:read]
	}
	if start > 0 {
		if newline := strings.IndexByte(string(data), '\n'); newline >= 0 {
			data = data[newline+1:]
		}
	}
	if !utf8.Valid(data) {
		data = []byte(strings.ToValidUTF8(string(data), "\uFFFD"))
	}
	return string(data), truncated, openedInfo.ModTime().UTC(), nil
}

func (logger *Logger) Close() error {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	if logger.file == nil {
		return nil
	}
	err := logger.file.Close()
	logger.file = nil
	return err
}

func (logger *Logger) open() error {
	file, err := os.OpenFile(logger.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("open TrueDown application log: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	pathInfo, err := os.Lstat(logger.path)
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() || !os.SameFile(pathInfo, info) {
		file.Close()
		return fmt.Errorf("application log is not a regular file")
	}
	logger.file = file
	logger.size = info.Size()
	return nil
}

func (logger *Logger) rotate() error {
	for index := maximumBackups; index >= 1; index-- {
		target := fmt.Sprintf("%s.%d", logger.path, index)
		if err := requireRegularOrMissing(target); err != nil {
			return err
		}
		if index == maximumBackups {
			if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		source := logger.path
		if index > 1 {
			source = fmt.Sprintf("%s.%d", logger.path, index-1)
		}
		if err := requireRegularOrMissing(source); err != nil {
			return err
		}
		if err := os.Rename(source, target); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func regularFileInfo(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	return info, nil
}

func requireRegularOrMissing(path string) error {
	_, err := regularFileInfo(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
