//go:build !windows

package app

// aria2's stop-with-process watch owns the Unix parent-death fallback.
func protectCoreProcess() error { return nil }
