package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"truedown/internal/modulehost"
	"truedown/modules/mega/internal/mega"
)

func TestProtocolRequiresHelloAndCurrentSession(t *testing.T) {
	for _, requests := range [][]modulehost.Request{
		{{ID: 1, Session: "0123456789abcdef0123456789abcdef", Method: "resolve", Body: json.RawMessage(`{}`)}},
		{{ID: 1, Session: "0123456789abcdef0123456789abcdef", Method: "hello", Body: json.RawMessage(`{"protocol":1}`)}, {ID: 2, Session: "00000000000000000000000000000000", Method: "resolve", Body: json.RawMessage(`{}`)}},
		{{ID: 1, Session: "0123456789abcdef0123456789abcdef", Method: "hello", Body: json.RawMessage(`{"protocol":1}`)}, {ID: 1, Session: "0123456789abcdef0123456789abcdef", Method: "resolve", Body: json.RawMessage(`{}`)}},
	} {
		var input, output bytes.Buffer
		for _, request := range requests {
			modulehost.WriteFrame(&input, request)
		}
		if run(&input, &output) == nil {
			t.Fatal("accepted out-of-session request")
		}
	}
}

func TestModuleDoesNotOfferAnIndependentDownloadStack(t *testing.T) {
	s := &service{ctx: context.Background(), client: mega.NewClient()}
	for _, method := range []string{"start", "pause", "resume", "cancel", "snapshot"} {
		if _, code := s.handle(method, json.RawMessage(`{}`)); code != "unsupported" {
			t.Fatalf("unexpected standalone transfer method %s", method)
		}
	}
}
