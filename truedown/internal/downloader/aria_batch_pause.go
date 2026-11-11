package downloader

import (
	"encoding/json"
	"fmt"
	"time"
)

// Dispatch every pause before waiting for writers. This avoids holding each
// group of queued tasks behind the slowest active writer in that group.
func (c *ariaClient) pauseBatch(targets []rpcTarget) map[int64]error {
	errorsByID := make(map[int64]error)
	for offset := 0; offset < len(targets); offset += 128 {
		batch := targets[offset:min(offset+128, len(targets))]
		calls := make([]any, 0, len(batch))
		for _, target := range batch {
			calls = append(calls, map[string]any{"methodName": "aria2.pause", "params": []any{"token:" + c.secret, target.gid}})
		}
		var results []json.RawMessage
		err := c.call("system.multicall", []any{calls}, &results)
		if err == nil && len(results) != len(batch) {
			err = fmt.Errorf("aria2 returned an incomplete pause batch")
		}
		for index, target := range batch {
			if err != nil {
				errorsByID[target.id] = err
				continue
			}
			var fault ariaRPCError
			if len(results[index]) > 0 && results[index][0] == '{' {
				if json.Unmarshal(results[index], &fault) != nil || fault.Message == "" {
					errorsByID[target.id] = fmt.Errorf("invalid aria2 pause result")
				} else {
					errorsByID[target.id] = &ariaRPCError{Code: fault.Code, Message: fault.Message}
				}
			} else {
				var ack []string
				if json.Unmarshal(results[index], &ack) != nil || len(ack) != 1 || ack[0] != target.gid {
					errorsByID[target.id] = fmt.Errorf("invalid aria2 pause acknowledgement")
				}
			}
		}
	}
	var waiting []rpcTarget
	for _, target := range targets {
		if errorsByID[target.id] == nil {
			waiting = append(waiting, target)
		}
	}
	ctx, cancel := c.pauseContext()
	defer cancel()
	for len(waiting) > 0 {
		var pending []rpcTarget
		for offset := 0; offset < len(waiting); offset += 128 {
			batch := waiting[offset:min(offset+128, len(waiting))]
			calls := make([]any, 0, len(batch))
			for _, target := range batch {
				calls = append(calls, map[string]any{"methodName": "aria2.tellStatus", "params": []any{"token:" + c.secret, target.gid, []string{"status"}}})
			}
			var results []json.RawMessage
			err := c.callContext(ctx, "system.multicall", []any{calls}, &results)
			if err == nil && len(results) != len(batch) {
				err = fmt.Errorf("incomplete aria2 pause status batch")
			}
			for index, target := range batch {
				if err != nil {
					errorsByID[target.id] = err
					continue
				}
				var state []ariaStatus
				if json.Unmarshal(results[index], &state) != nil || len(state) != 1 {
					var fault ariaRPCError
					if json.Unmarshal(results[index], &fault) == nil && fault.Message != "" {
						errorsByID[target.id] = &fault
					} else {
						errorsByID[target.id] = fmt.Errorf("invalid aria2 pause state")
					}
					continue
				}
				switch state[0].Status {
				case "paused":
				case "active", "waiting":
					pending = append(pending, target)
				default:
					errorsByID[target.id] = fmt.Errorf("aria2 task did not reach paused state")
				}
			}
		}
		waiting = pending
		if len(waiting) == 0 {
			break
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			for _, target := range waiting {
				errorsByID[target.id] = ctx.Err()
			}
			return errorsByID
		case <-timer.C:
		}
	}
	return errorsByID
}
