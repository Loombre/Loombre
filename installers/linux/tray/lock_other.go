// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/lock_other.go
//
// Non-POSIX stub for lock_unix.go — see app_other.go for why this package
// stays compilable off Linux at all.

//go:build !unix

package main

import "errors"

type instanceLock struct{}

func lockPath() string { return "" }

func acquireInstanceLock() (*instanceLock, error) {
	return nil, errors.New("loombre-tray: single-instance locking needs a POSIX host")
}

func (l *instanceLock) release() {}
