package downloader

import (
	"context"
	"fmt"
	"time"
)

func (c *ariaClient) pauseContext() (context.Context, context.CancelFunc) {
	parent := c.lifecycleCtx
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, 5*time.Second)
}

// The pause RPC acknowledges a request before the engine stops its writer.
// Do not publish paused state until a following resume can actually succeed.
func (c *ariaClient) waitForPause(ctx context.Context, gid string) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if gid == "" {
			var active []ariaStatus
			if err := c.callContext(ctx, "aria2.tellActive", []any{[]string{"gid"}}, &active); err != nil {
				return err
			}
			if len(active) == 0 {
				return nil
			}
		} else {
			var state ariaStatus
			if err := c.callContext(ctx, "aria2.tellStatus", []any{gid, []string{"status"}}, &state); err != nil {
				return err
			}
			switch state.Status {
			case "paused":
				return nil
			case "active", "waiting":
			default:
				return fmt.Errorf("aria2 task did not reach paused state")
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for aria2 pause: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}
