// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/secret/windows-acl.ts
//
// Windows has no POSIX permission bits: Node's chmod(0o600) there only
// toggles the read-only ATTRIBUTE, and stat() reports 0o666 back (the
// first windows-latest CI run caught exactly this — "expected 438 to be
// 384"). A secret file created on Windows therefore inherits its parent
// directory's DACL, which is NOT a per-owner grant by default.
//
// This module supplies the Windows half of the per-platform guarantee the
// file0600 backend actually makes:
//
//     POSIX   — 0600 mode bits (owner read/write, nothing for group/other)
//     Windows — inheritance stripped + an explicit owner-only full-control
//               DACL, applied with icacls
//
// Principal selection: the current user's SID is preferred over the bare
// account name. A name like "alice" can be ambiguous on a domain-joined
// machine (local vs domain account), whereas a SID cannot; icacls accepts
// a SID with a `*` prefix. The account name is a fallback for the rare case
// where `whoami` is unavailable.
//
// FAIL-CLOSED: if the DACL cannot be applied, this THROWS rather than
// leaving a secret on disk under inherited permissions. A provisioning run
// that cannot make the confidentiality guarantee must stop loudly, not
// silently downgrade it (the same posture the restricted-content guard and
// the update-check signature verification take elsewhere in this repo).

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { SecretAclError } from "../errors.js";

/** True when POSIX mode bits are meaningless on this host. */
export function isWindowsHost(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * The icacls principal for the account this process runs as: `*<SID>` when
 * the SID is resolvable, else the plain account name. Exported for the
 * Windows CI assertion, which needs to name the same principal it expects
 * to find in the resulting DACL.
 */
export function currentUserPrincipal(): string {
  try {
    // `whoami /user /fo csv /nh` prints: "DOMAIN\user","S-1-5-21-..."
    const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const sid = /S-1-[\d-]+/.exec(out)?.[0];
    if (sid) return `*${sid}`;
  } catch {
    // Fall through to the account-name form below.
  }
  return userInfo().username;
}

/**
 * Strip inherited ACEs and grant full control to exactly one principal —
 * the account this process runs as. Throws SecretAclError on any failure.
 *
 * `/inheritance:r` removes inherited ACEs outright (it does not copy them,
 * which `/inheritance:d` would), so entries like BUILTIN\Users do not
 * survive. `/grant:r` replaces, rather than adds to, any existing grant for
 * that principal. The result is a DACL with a single explicit ACE.
 *
 * Note the deliberate consequence: Administrators and SYSTEM are NOT
 * granted. They can still take ownership (an inherent Windows privilege),
 * but they cannot read the file as-is. If the server is later run under a
 * DIFFERENT Windows account than the one that provisioned it, that account
 * will not be able to read this secret — see STATE.md's platform note.
 */
export function applyOwnerOnlyDacl(filePath: string): void {
  const principal = currentUserPrincipal();
  try {
    execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${principal}:F`], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new SecretAclError(filePath, principal, cause);
  }
}
