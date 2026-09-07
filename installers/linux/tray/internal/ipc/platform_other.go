// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/platform_other.go
//
// Non-POSIX stub for platform_unix.go. This tray only ever ships on Linux
// and only ever develops on Linux/macOS, but keeping the package
// compilable everywhere means `go build ./...` never fails for a reason
// that has nothing to do with the change being made.

//go:build !unix

package ipc

import "io/fs"

func processAlive(int) bool { return false }

func fileGroupID(fs.FileInfo) (string, bool) { return "", false }
