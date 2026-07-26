// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/windows-acl.ts
//
// Orchestrator decision (b), Windows half: "document the required icacls
// grant in the transport amendment + best-effort Node ACL attempt guarded
// by platform (report honestly what Node can/cannot do here)".
//
// HONEST STATEMENT OF WHAT THIS DOES AND DOES NOT DO (per the mission's
// explicit instruction to report this honestly, not just claim success):
//
// - Node has NO built-in Windows ACL API at all — no fs.chmod equivalent
//   (Windows fs.chmod only toggles the read-only DOS attribute, nothing
//   like a POSIX mode/ACL) and no wrapper around the Win32 security APIs.
//   The only way to set a real Windows ACL from this codebase without a
//   new dependency (this wave's "zero new deps" constraint) is shelling
//   out to `icacls.exe`, a tool present on every supported Windows version.
// - This function is BEST-EFFORT: it runs `icacls` via child_process and
//   swallows every failure into a logged warning, never a thrown error —
//   the discovery/token files still get WRITTEN either way (the fallback
//   NTFS ACL a file inherits from its parent directory is whatever that
//   directory's ACL already grants, which for a service-account-owned
//   app-data directory is typically SYSTEM + Administrators already, per
//   docs/PLAN.md §11 / installers/windows/msi's Directories.wxs — so a
//   failed icacls call degrades to "inherited ACL", not "no access
//   whatsoever").
// - This function does NOT know who "the installing user" is. The listener
//   process has no reliable way to learn which interactive Windows account
//   should be able to read these files beyond BUILTIN\Administrators (a
//   locale-INDEPENDENT well-known SID, S-1-5-32-544 — unlike the string
//   "Administrators", which is only that spelling on English-language
//   Windows) — that identity is only known to whatever installed Loombre.
//   LOOMBRE_IPC_WINDOWS_GRANT (env.ts) lets an installer or operator name
//   additional principals explicitly; absent that, only Administrators (and
//   the writing process's own account, implicitly, via NTFS "owner" rights)
//   can read the files. This is intentionally the NARROW default — "local
//   administrators + the installing user, not world" — with the
//   installing-user half left to whichever install path can actually name
//   that account (flagged in this lane's report as an I3 follow-up:
//   Services.wxs / a post-install step is the right place to set
//   LOOMBRE_IPC_WINDOWS_GRANT to the real installing user, or to re-run
//   icacls itself once that identity is known).
// - Every command run here is documented verbatim in the sibling
//   RECOMMENDED_ICACLS_COMMAND export so an operator (or I3's installer)
//   can apply/verify the exact same grant manually, independent of whether
//   this best-effort runtime attempt succeeded.

import { execFileSync } from "node:child_process";

/** BUILTIN\Administrators — locale-independent well-known SID. Always
 *  granted read access; this is the "local administrators" half of the
 *  orchestrator decision's "local administrators + the installing user". */
const ADMINISTRATORS_SID = "*S-1-5-32-544";
/** NT AUTHORITY\SYSTEM — locale-independent well-known SID. Explicitly
 *  granted full control even though a LocalSystem-run service already has
 *  it implicitly, so the ACL is self-documenting when read with `icacls`
 *  later rather than relying on an inherited grant nobody wrote down. */
const SYSTEM_SID = "*S-1-5-18";

export interface WindowsAclResult {
  attempted: boolean;
  succeeded: boolean;
  /** Populated on failure or when not attempted (wrong platform) — never
   *  thrown, always surfaced here for the caller to log. */
  detail?: string;
}

/** The exact icacls invocation this function attempts, minus the path and
 *  any LOOMBRE_IPC_WINDOWS_GRANT extras — documented so an installer/operator
 *  can run (or verify) the equivalent by hand. See also the transport.ts
 *  amendment's IPC_SERVER_START_SEMANTICS neighbor for where the rest of
 *  this contract's Windows-specific guidance lives. */
export const RECOMMENDED_ICACLS_COMMAND =
  'icacls "<path>" /inheritance:r /grant:r "*S-1-5-18:(F)" "*S-1-5-32-544:(R)"';

/** Best-effort: strips inherited permissions and grants SYSTEM full control
 *  + Administrators (+ any LOOMBRE_IPC_WINDOWS_GRANT extras) read-only, via
 *  `icacls`. No-ops (attempted: false) on any platform other than win32 —
 *  callers only need to invoke this unconditionally and check the result. */
export function applyWindowsAcl(path: string, extraGrants: string[] = []): WindowsAclResult {
  if (process.platform !== "win32") {
    return { attempted: false, succeeded: false, detail: "not running on win32" };
  }

  const grants = [`${SYSTEM_SID}:(F)`, `${ADMINISTRATORS_SID}:(R)`, ...extraGrants.map((g) => `${g}:(R)`)];
  const args = [path, "/inheritance:r", "/grant:r", ...grants];

  try {
    execFileSync("icacls", args, { encoding: "utf8" });
    return { attempted: true, succeeded: true };
  } catch (err) {
    return {
      attempted: true,
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
