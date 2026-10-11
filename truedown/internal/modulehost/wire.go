// Package modulehost implements the private protocol for independent download providers.
package modulehost

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

const ProtocolVersion = 1
const MaxFrameBytes = 1024 * 1024

var ErrProtocol = errors.New("invalid module protocol message")

type Request struct {
	ID      uint64          `json:"id"`
	Session string          `json:"session"`
	Method  string          `json:"method"`
	Body    json.RawMessage `json:"body"`
}

type Response struct {
	ID      uint64          `json:"id"`
	Session string          `json:"session"`
	Body    json.RawMessage `json:"body"`
	Error   string          `json:"error"`
}

type Hello struct {
	Protocol     int      `json:"protocol"`
	ModuleID     string   `json:"moduleId"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

// ReadFrame validates the length before allocating. Errors never include payloads.
func ReadFrame(r io.Reader, value any) error {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > MaxFrameBytes {
		return ErrProtocol
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(r, data); err != nil {
		return err
	}
	return Decode(data, value)
}

// Decode rejects duplicate keys as well as unknown fields and trailing values.
func Decode(data []byte, value any) error {
	if len(data) == 0 || len(data) > MaxFrameBytes || !utf8.Valid(data) {
		return ErrProtocol
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := checkJSON(d, 0); err != nil {
		return ErrProtocol
	}
	if _, err := d.Token(); err != io.EOF {
		return ErrProtocol
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return ErrProtocol
	}
	return nil
}

func checkJSON(d *json.Decoder, depth int) error {
	if depth > 32 {
		return ErrProtocol
	}
	token, err := d.Token()
	if err != nil {
		return err
	}
	opening, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	if opening != '{' && opening != '[' {
		return ErrProtocol
	}
	seen := make(map[string]bool)
	for d.More() {
		if opening == '{' {
			key, err := d.Token()
			name, ok := key.(string)
			name = strings.ToLower(name)
			if err != nil || !ok || seen[name] {
				return ErrProtocol
			}
			seen[name] = true
		}
		if err := checkJSON(d, depth+1); err != nil {
			return err
		}
	}
	closing, err := d.Token()
	if err != nil || (opening == '{' && closing != json.Delim('}')) || (opening == '[' && closing != json.Delim(']')) {
		return ErrProtocol
	}
	return nil
}

func WriteFrame(w io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) == 0 || len(data) > MaxFrameBytes {
		return ErrProtocol
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	for _, part := range [][]byte{header[:], data} {
		for len(part) > 0 {
			n, err := w.Write(part)
			if err != nil {
				return err
			}
			if n <= 0 || n > len(part) {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}
