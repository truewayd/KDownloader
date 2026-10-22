package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"truedown/internal/modulehost"
	"truedown/modules/mediafire/internal/mediafire"
)

func TestPrivateProtocolAndNoTransferMethods(t *testing.T) {
	s := &service{ctx: context.Background(), client: mediafire.NewClient()}
	for _, method := range []string{"start", "transform", "pause", "resume", "cancel", "snapshot"} {
		if _, code := s.handle(method, json.RawMessage(`{}`)); code != "unsupported" {
			t.Fatalf("standalone transfer method: %s", method)
		}
	}
	for _, body := range []string{`null`, `[]`, `{"source":"x","source":"y"}`, `{"source":"x","output":"C:/private"}`} {
		if _, code := s.handle("resolve", json.RawMessage(body)); code != "invalid_request" {
			t.Fatal("accepted invalid envelope", body, code)
		}
	}
	for _, requests := range [][]modulehost.Request{
		{{ID: 1, Session: "0123456789abcdef0123456789abcdef", Method: "resolve", Body: json.RawMessage(`{}`)}},
		{{ID: 1, Session: "0123456789abcdef0123456789abcdef", Method: "hello", Body: json.RawMessage(`{"protocol":1}`)}, {ID: 1, Session: "0123456789abcdef0123456789abcdef", Method: "resolve", Body: json.RawMessage(`{}`)}},
		{{ID: 1, Session: "0123456789abcdef0123456789abcdef", Method: "hello", Body: json.RawMessage(`{"protocol":1}`)}, {ID: 2, Session: "00000000000000000000000000000000", Method: "resolve", Body: json.RawMessage(`{}`)}},
	} {
		var input, output bytes.Buffer
		for _, request := range requests {
			if err := modulehost.WriteFrame(&input, request); err != nil {
				t.Fatal(err)
			}
		}
		if run(&input, &output) == nil {
			t.Fatal("accepted invalid session/replay")
		}
	}
}
