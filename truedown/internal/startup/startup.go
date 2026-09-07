package startup

import (
	"fmt"
	"sync"
)

type State struct {
	Supported bool   `json:"supported"`
	Enabled   bool   `json:"enabled"`
	Reason    string `json:"reason,omitempty"`
}

type registration interface {
	Read() (string, error)
	Write(string) error
	Remove() error
}

type Manager struct {
	mu      sync.Mutex
	entry   registration
	command string
	reason  string
}

// Unavailable leaves registration ownership with an external service or shell.
func Unavailable(reason string) *Manager { return &Manager{reason: reason} }

func (m *Manager) Snapshot() (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshot()
}

func (m *Manager) snapshot() (State, error) {
	if m.entry == nil {
		return State{Reason: m.reason}, nil
	}
	command, err := m.entry.Read()
	if err != nil {
		return State{}, err
	}
	return State{Supported: true, Enabled: command == m.command}, nil
}

func (m *Manager) SetEnabled(enabled bool) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.entry == nil {
		return State{Reason: m.reason}, fmt.Errorf("%s", m.reason)
	}
	current, err := m.entry.Read()
	if err != nil {
		return State{}, err
	}
	if current != "" && current != m.command {
		return State{}, fmt.Errorf("startup registration belongs to another executable; remove the old TrueDown startup entry in Windows first")
	}
	if enabled {
		err = m.entry.Write(m.command)
	} else if current != "" {
		err = m.entry.Remove()
	}
	if err != nil {
		return State{}, err
	}
	return m.snapshot()
}
