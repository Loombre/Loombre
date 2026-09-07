// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/lock_unix.go
//
// Single-instance guard. Both registered launch paths can fire in the same
// session — the autostart desktop entry at login and the application
// launcher whenever someone clicks Loombre — and two tray icons for one
// server is a bug, not a feature.
//
// flock(2) rather than a pid file: the kernel releases it when the process
// dies for ANY reason, including SIGKILL and a crash, so there is no stale
// lock to clean up and no "is pid 12345 still mine?" guesswork. The file
// itself is only a handle to lock; nothing is ever written to it.

//go:build unix

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type instanceLock struct {
	file *os.File
	path string
}

// lockPath prefers $XDG_RUNTIME_DIR (per-user, per-session, cleaned up by
// the login manager). The /tmp fallback carries the uid in its name so two
// users on one machine cannot lock each other out of their own trays.
func lockPath() string {
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		return filepath.Join(dir, "loombre-tray.lock")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("loombre-tray-%d.lock", os.Getuid()))
}

// acquireInstanceLock returns a non-nil lock when this process now owns
// the tray, or nil when another instance already does. An error means the
// lock file itself could not be opened, which the caller treats as "run
// anyway": failing to start a tray because /run is odd would be worse than
// briefly showing two.
func acquireInstanceLock() (*instanceLock, error) {
	path := lockPath()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, nil
		}
		return nil, fmt.Errorf("flock %s: %w", path, err)
	}
	return &instanceLock{file: file, path: path}, nil
}

// release drops the lock. The kernel would do it at exit anyway; this
// makes the ordering explicit for the paths that keep running afterwards.
func (l *instanceLock) release() {
	if l == nil || l.file == nil {
		return
	}
	_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	_ = l.file.Close()
}
