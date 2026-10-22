package modulehost

import (
	"context"
	"encoding/json"
	"io"
)

// Handler processes one private request. The context is cancelled on parent EOF.
type Handler func(string, json.RawMessage) (any, string)

func Serve(input io.Reader, output io.Writer, factory func(context.Context) Handler) error {
	ctx, cancel := context.WithCancel(context.Background())
	readerDone := make(chan struct{})
	defer func() { close(readerDone); cancel() }()
	handle := factory(ctx)
	type incoming struct {
		request Request
		err     error
	}
	requests := make(chan incoming, 1)
	// EOF cancels a currently running local transform even when the parent dies.
	go func() {
		for {
			var request Request
			err := ReadFrame(input, &request)
			if err != nil {
				cancel()
			}
			select {
			case requests <- incoming{request, err}:
			case <-readerDone:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	var session string
	var previous uint64
	for {
		message := <-requests
		if message.err != nil {
			if message.err == io.EOF {
				return nil
			}
			return ErrProtocol
		}
		request := message.request
		if request.ID <= previous || len(request.Session) != 32 {
			return ErrProtocol
		}
		for _, r := range request.Session {
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
				return ErrProtocol
			}
		}
		if session == "" {
			if request.Method != "hello" {
				return ErrProtocol
			}
			session = request.Session
		} else if request.Session != session || request.Method == "hello" {
			return ErrProtocol
		}
		previous = request.ID
		value, code := handle(request.Method, request.Body)
		body, err := json.Marshal(value)
		if err != nil {
			return ErrProtocol
		}
		if err := WriteFrame(output, Response{ID: request.ID, Session: session, Body: body, Error: code}); err != nil {
			return err
		}
		if request.Method == "shutdown" && code == "" {
			return nil
		}
	}
}
