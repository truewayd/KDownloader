//go:build windows

package main

func defaultDataDir(base string) (string, error) {
	return base, nil
}
