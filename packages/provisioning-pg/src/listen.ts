// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/listen.ts
//
// Pure translation of @loombre/provisioning's frozen ListenStrategy into (a)
// the CLI args `postgres` itself is spawned with, and (b) the CLI args
// pg_isready/psql use to reach it. Verified for real against the actual
// vendored binary on this host before being written (see this lane's
// report): both strategies proven live — unix-socket via
// `-h '' -k <dir>`, tcp-loopback via
// `-h 127.0.0.1 -p <port> -c unix_socket_directories=''` (explicitly
// disabling the platform-default unix socket dir for the TCP strategy so
// this instance never opens an ambient, unlisted local socket — every
// listener this package opens is one of the two the ListenStrategy
// explicitly names, never both at once).
//
// P4.2 "localhost socket" / @loombre/provisioning's listen-strategy.ts
// header ("ALWAYS localhost-only ... embedded PG is never a LAN service"):
// tcp-loopback hard-codes 127.0.0.1, never 0.0.0.0, by construction — there
// is no code path in this file capable of emitting any other bind address.

import type { ListenStrategy } from "@loombre/provisioning";

/** Args appended to a direct `postgres -D <dataDir> ...` invocation
 *  (this package spawns postgres itself, not via pg_ctl — see
 *  supervisor.ts header for why). */
export function buildServerListenArgs(strategy: ListenStrategy): string[] {
  if (strategy.kind === "unix-socket") {
    // -h '' disables TCP entirely; -k DIRECTORY is postgres's own short
    // flag for the unix_socket_directories GUC (verified via `postgres
    // --help` on the vendored binary) — no redundant -c needed.
    return ["-h", "", "-k", strategy.socketDir];
  }
  // -c unix_socket_directories='' disables the unix socket entirely so
  // this instance opens EXACTLY the one listener its ListenStrategy names,
  // never an ambient extra one at the platform-default socket dir.
  return ["-h", "127.0.0.1", "-p", String(strategy.port), "-c", "unix_socket_directories="];
}

/** Args for pg_isready/psql (both accept the same -h/-p connection flags)
 *  to reach an instance listening per `strategy`. */
export function buildClientConnArgs(strategy: ListenStrategy): string[] {
  if (strategy.kind === "unix-socket") {
    return ["-h", strategy.socketDir];
  }
  return ["-h", "127.0.0.1", "-p", String(strategy.port)];
}

/** The `postgres://` connection string for this strategy + credentials —
 *  what apps/server's bootstrap seam exports as DATABASE_URL. node-postgres
 *  (the ONLY consumer, inside packages/db — this package never imports the
 *  driver itself, CLAUDE.md invariant 4) accepts a URL-encoded socket
 *  directory as the `host` component for unix-socket connections. */
export function buildDatabaseUrl(
  strategy: ListenStrategy,
  user: string,
  password: string,
  database: string,
): string {
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  const encodedDatabase = encodeURIComponent(database);
  if (strategy.kind === "unix-socket") {
    const encodedSocketDir = encodeURIComponent(strategy.socketDir);
    return `postgres://${encodedUser}:${encodedPassword}@${encodedSocketDir}/${encodedDatabase}`;
  }
  return `postgres://${encodedUser}:${encodedPassword}@127.0.0.1:${strategy.port}/${encodedDatabase}`;
}
