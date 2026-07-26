// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/scratch-paths.ts
//
// REAL bug found and fixed during this lane's own integration testing: a
// unix domain socket path is capped at ~104 bytes (macOS/BSD
// sizeof(sockaddr_un.sun_path); Linux is 108) — `node:os`'s tmpdir() on
// macOS resolves to a long-ish per-process `/var/folders/.../T` path, and
// a descriptive mkdtemp prefix on top of THAT plus the `.s.PGSQL.<port>`
// socket filename postgres appends routinely blows the limit (postgres
// then fails to bind with a cryptic "invalid argument" / silent startup
// failure — this package's health poll would just time out and report a
// misleading 'corrupt' status with no obviously-socket-related detail).
// `/tmp` (a short, stable path on every POSIX platform) has no such
// problem. Used ONLY for scratch directories that will host a unix
// socket file (upgrade()'s internal throwaway old/new-binaries
// instances) — every OTHER scratch need (pwfile dirs, dump file dirs)
// keeps using node:os's tmpdir() as normal, since only socket paths have
// this constraint.

import { tmpdir } from "node:os";

export function socketScratchBase(): string {
  // Unix domain sockets don't exist on win32 in the AF_UNIX sense this
  // package uses them in (ListenStrategy's unix-socket kind is a POSIX-
  // oriented option; Windows installer lanes use tcp-loopback) — tmpdir()
  // is fine there since this path is never used to host a real socket file
  // on that platform.
  return process.platform === "win32" ? tmpdir() : "/tmp";
}
