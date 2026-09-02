//go:build windows

package main

import "testing"

func TestAppInstanceIsScopedToDataDirectory(t *testing.T) {
	directory := t.TempDir()
	first, alreadyRunning, err := acquireAppInstance(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if alreadyRunning {
		t.Fatal("first instance unexpectedly reported an existing owner")
	}
	second, alreadyRunning, err := acquireAppInstance(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if !alreadyRunning {
		t.Fatal("second instance did not find the existing data-directory owner")
	}
	other, alreadyRunning, err := acquireAppInstance(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if alreadyRunning {
		t.Fatal("different data directories unexpectedly share one instance mutex")
	}
}
