//go:build !windows && !linux && !darwin

package main

type appInstance struct{}

func acquireAppInstance(dataDir string) (*appInstance, bool, error) {
	return &appInstance{}, false, nil
}

func (instance *appInstance) Close() error {
	return nil
}
