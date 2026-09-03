//go:build !windows && !linux && !darwin

package main

func defaultDataDir(base string) (string, error) {
	return base, nil
}
