// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/posix-permissions.ts
//
// Orchestrator decision (b), POSIX half: "mac/linux 0640 with the file
// group set from LOOMBRE_IPC_GROUP env (default: the process's own primary
// group; installers set 'admin' on mac)".
//
// THREAT MODEL (STATE.md Phase 4 Open "IPC token-file permission bridging"):
// this contract's FROZEN transport.ts originally said "0600 (owner-read/
// write only)" — taken literally that makes the token unreadable by any
// process running as a different OS user, which is exactly the situation
// on a real install: the server/worker often run as a dedicated service
// account (_loombre on macOS's LaunchDaemon, LocalSystem on Windows) while
// the controller (tray/menubar) runs as the interactive console user.
// 0640 + an explicit group grant is the fix: still refuses "world" (no
// other-bits), but lets a named group (installer-chosen — "admin" on
// macOS, a dedicated group on Linux) read it without needing the same
// single owning UID. This is strictly a WIDENING from 0600 to 0640, never
// wider than group-read, and the group itself is never "everyone" —
// "local administrators + the installing user, not world" per the
// orchestrator decision.
//
// Group-name -> gid resolution has no Node stdlib API (os.userInfo() only
// ever returns the CURRENT process's own uid/gid, never an arbitrary named
// group's gid) — POSIX itself only exposes getgrnam(3) as a C call, and
// `id`'s own optional argument names a USER whose primary group to report,
// not an arbitrary group name to resolve directly (`id -g admin` asks "what
// is user admin's primary group", not "what is group admin's gid" — the
// two only coincide by accident, and fail outright when no such-named user
// exists, which is the common case: e.g. macOS's real "admin" GROUP has no
// same-named USER). getent(1) would be the natural fix on Linux but does
// not exist on macOS/BSD at all (no NSS story there). The one thing every
// POSIX system Loombre targets (Linux, macOS) genuinely has in common is
// /etc/group itself — a plain `name:passwd:gid:members` text file, the
// authoritative source for every LOCAL group (which is exactly what
// matters here: an installer-created or platform-builtin group like
// macOS's "admin", never a directory-service-only one) — so this reads
// and parses it directly rather than shelling out to a tool whose exact
// semantics/availability differ by platform. Best-effort either way: a
// typo'd/nonexistent group name logs a warning and falls back to leaving
// the file's group untouched (the process's own default primary group —
// fails CLOSED, never wider).

import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const IPC_FILE_MODE = 0o640;
const IPC_DIR_MODE = 0o750;
const ETC_GROUP_PATH = "/etc/group";

/** Resolves a POSIX group name to a numeric gid by reading /etc/group.
 *  Returns null (never throws) on any failure — unknown group, file
 *  unreadable, non-POSIX platform, etc. — so callers always have a safe,
 *  documented fallback. */
export function resolveGroupId(groupName: string): number | null {
  if (process.platform === "win32") return null;
  let contents: string;
  try {
    contents = readFileSync(ETC_GROUP_PATH, "utf8");
  } catch {
    return null;
  }
  for (const line of contents.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(":");
    if (fields[0] !== groupName) continue;
    const gid = Number.parseInt(fields[2] ?? "", 10);
    return Number.isInteger(gid) && gid >= 0 ? gid : null;
  }
  return null;
}

/** Writes `contents` to `path` with mode 0640, then best-effort chowns the
 *  GROUP (never the owning uid — always -1/"unchanged" for that) to
 *  `groupName` when resolvable. Ensures the parent directory exists first
 *  (0750, only when this call is the one creating it — an existing
 *  directory's mode is never touched, so an installer's own chosen
 *  ownership/mode on the app-data dir is never clobbered). */
export function writeIpcFilePosix(path: string, contents: string, groupName: string | undefined): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: IPC_DIR_MODE });
  }

  // `mode` on writeFileSync only applies at file CREATION (O_CREAT); an
  // existing file's mode is left as-is by the OS, so every write is
  // followed by an explicit chmod — the same gotcha this repo already
  // documents in packages/provisioning-pg/src/secret/file0600.ts and
  // apps/server/src/tls/fs-secret.ts for their own instances of this
  // pattern (both linked here for the next reader who hits it a third
  // time).
  writeFileSync(path, contents, { mode: IPC_FILE_MODE });
  chmodSync(path, IPC_FILE_MODE);

  if (groupName === undefined) return;
  const gid = resolveGroupId(groupName);
  if (gid === null) {
    console.warn(
      `ipc: LOOMBRE_IPC_GROUP="${groupName}" could not be resolved to a group id (unknown group, or "id" unavailable) — ` +
        `leaving ${path}'s group as the server process's own default. This fails CLOSED (narrower access than requested), never wider.`,
    );
    return;
  }
  try {
    // uid -1 is the POSIX chown(2) "leave unchanged" sentinel — Node's
    // chownSync requires a concrete number, not undefined, to express it.
    chownSync(path, -1, gid);
  } catch (err) {
    console.warn(
      `ipc: failed to chown ${path} to group "${groupName}" (gid ${gid}): ${err instanceof Error ? err.message : String(err)}. ` +
        "Leaving the file's existing group unchanged.",
    );
  }
}
