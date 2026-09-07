// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/platform_unix.go
//
// The two POSIX primitives discovery needs. Split out behind a build tag
// (with a !unix stub alongside) so the rest of this package stays plain Go
// that compiles and tests anywhere — the decision logic is what matters,
// and it must not need a Linux host to run.

//go:build unix

package ipc

import (
	"errors"
	"io/fs"
	"strconv"
	"syscall"
)

// processAlive reports whether pid names a live process, using the
// standard kill(pid, 0) probe (sends nothing; tests existence+permission).
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	// ESRCH is the only definitive "no such process". EPERM means the pid
	// exists but belongs to another user — the NORMAL case here, since the
	// server runs as a dedicated service account and this tray runs as the
	// desktop user, so treating EPERM as dead would report every healthy
	// install as stale.
	return !errors.Is(err, syscall.ESRCH)
}

// fileGroupID returns the numeric owning group of a stat result. Used only
// to turn "you are not in the right group" into an actionable command, so
// a failure here degrades the hint, never the discovery result.
func fileGroupID(info fs.FileInfo) (string, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", false
	}
	return strconv.FormatUint(uint64(st.Gid), 10), true
}
