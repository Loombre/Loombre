// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/windows-acl.ts
//
// THE one place this codebase sets a Windows ACL. Two named policies live
// here side by side, deliberately, because the repo genuinely needs two
// different permissiveness levels and the difference should be a visible
// choice rather than a coincidence of where the code happened to be
// written:
//
//   ownerOnly       — for SECRETS (embedded-PG superuser password, TLS
//                     private keys, JWT HMAC keys). Exactly one ACE, for
//                     the account that wrote the file. Fail-closed.
//   serviceReadable — for the IPC DISCOVERY/TOKEN files. SYSTEM full
//                     control + Administrators read (+ operator-named
//                     extras). Best-effort.
//
// Each policy's rationale is stated on its own function; read those before
// changing either. Picking the wrong one is a security bug in one
// direction (a secret readable by every local admin) or an availability
// bug in the other (a service that cannot read its own discovery file).
//
// WHY icacls AND NOT AN API: Node has no Windows ACL binding at all —
// fs.chmod on Windows only toggles the read-only DOS attribute, and there
// is no wrapper around the Win32 security APIs. Shelling out to
// icacls.exe, present on every supported Windows version, is the only way
// to set a real ACL without adding a dependency. Every principal below is
// named by its locale-independent well-known SID (`*S-1-…`) rather than by
// name: "Administrators" is only spelled that way on English-language
// Windows, whereas S-1-5-32-544 is that group everywhere.

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { SecretAclError } from "./errors.js";

/** BUILTIN\Administrators — locale-independent well-known SID. */
export const ADMINISTRATORS_SID = "*S-1-5-32-544";
/** NT AUTHORITY\SYSTEM — locale-independent well-known SID. */
export const SYSTEM_SID = "*S-1-5-18";

/** True when POSIX mode bits are meaningless on this host. */
export function isWindowsHost(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

function icacls(filePath: string, args: string[]): string {
  return execFileSync("icacls", [filePath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Principal names from `icacls <path>` output ("DOMAIN\\user:(F)" ->
 *  "DOMAIN\\user"). The first line is prefixed with the file path, which is
 *  stripped. Matched on the "principal:(FLAGS)" shape so the trailing
 *  localized summary line is ignored. */
function daclPrincipals(filePath: string, aclText: string): string[] {
  const names: string[] = [];
  for (const rawLine of aclText.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(filePath)) line = line.slice(filePath.length).trim();
    const matched = /^(.+?):\([A-Z]/.exec(line);
    if (matched) names.push(matched[1]!.trim());
  }
  return names;
}

/** True when an ACL principal ("DOMAIN\\alice", "alice") names this
 *  account. Compared on the leaf so a domain prefix does not matter. */
function sameAccount(aclPrincipal: string, username: string): boolean {
  const leaf = aclPrincipal.includes("\\") ? aclPrincipal.slice(aclPrincipal.lastIndexOf("\\") + 1) : aclPrincipal;
  return leaf.toLowerCase() === username.toLowerCase();
}

/**
 * The icacls principal for the account this process runs as: `*<SID>` when
 * the SID is resolvable, else the plain account name. Exported so tests can
 * name the same principal they expect to find in a resulting DACL.
 *
 * The SID is preferred because an account NAME can be ambiguous on a
 * domain-joined machine (local `alice` vs domain `alice`); a SID cannot.
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
 * POLICY: ownerOnly — for SECRETS.
 *
 * WHY THIS LEVEL IS CORRECT HERE: these files (embedded-PG superuser
 * password, TLS private keys, JWT signing keys) are the POSIX-0600 tier.
 * On POSIX they carry mode 0600 — owner read/write, nothing for group or
 * other, NOT "root can read it too" — and the Windows ACL has to mean the
 * same thing or the guarantee silently weakens when you change platform.
 * Administrators and SYSTEM are therefore NOT granted. They retain the
 * ability to take ownership, which is inherent to Windows and cannot be
 * revoked, but that is an audited, deliberate act rather than a quiet read.
 *
 * FAIL-CLOSED, unlike serviceReadable: a secret left under inherited
 * permissions is a confidentiality failure, so this throws rather than
 * returning a warning the caller might log and move past.
 *
 * NOTE the two flags alone are NOT sufficient, which windows-latest proved:
 * `/inheritance:r` removes only INHERITED entries and `/grant:r` replaces
 * only the NAMED principal's entry, so any OTHER principal holding an
 * EXPLICIT ACE (SYSTEM, Administrators) survives both. The resulting DACL
 * is therefore enumerated, every non-owner principal removed, and the
 * postcondition verified before returning.
 */
export function applyOwnerOnlyDacl(filePath: string): void {
  const principal = currentUserPrincipal();
  const run = (args: string[]): string => {
    try {
      return icacls(filePath, args);
    } catch (cause) {
      throw new SecretAclError(filePath, principal, cause);
    }
  };

  run(["/inheritance:r", "/grant:r", `${principal}:F`]);

  const me = userInfo().username;
  for (const other of daclPrincipals(filePath, run([]))) {
    if (!sameAccount(other, me)) run(["/remove:g", other]);
  }

  const remaining = daclPrincipals(filePath, run([]));
  if (remaining.length !== 1 || !sameAccount(remaining[0]!, me)) {
    throw new SecretAclError(filePath, principal, new Error(`DACL is not owner-only after hardening: [${remaining.join(", ")}]`));
  }
}

export interface WindowsAclResult {
  attempted: boolean;
  succeeded: boolean;
  /** Populated on failure or when not attempted (wrong platform) — never
   *  thrown, always surfaced here for the caller to log. */
  detail?: string;
}

/** The exact icacls invocation serviceReadable attempts, minus the path and
 *  any operator-named extras — documented so an installer or operator can
 *  run (or verify) the equivalent by hand. */
export const RECOMMENDED_ICACLS_COMMAND =
  'icacls "<path>" /inheritance:r /grant:r "*S-1-5-18:(F)" "*S-1-5-32-544:(R)"';

/**
 * POLICY: serviceReadable — for the IPC DISCOVERY/TOKEN files.
 *
 * WHY THIS LEVEL IS CORRECT HERE, AND WHY IT IS MORE PERMISSIVE THAN
 * ownerOnly ON PURPOSE: these files exist to be FOUND. A tray app or CLI
 * run by a local administrator has to read the discovery file to locate and
 * authenticate to a server that may be running as LocalSystem — a
 * different account entirely. Owner-only here would not be "more secure",
 * it would break the feature: the service would write a file its own
 * operator could never read. So SYSTEM gets full control (explicitly, so
 * the ACL is self-documenting when read back rather than relying on an
 * inherited grant nobody wrote down) and Administrators get READ. That is
 * still the narrow default — local administrators, not world — and
 * inheritance is stripped so a permissive parent directory cannot widen it.
 *
 * `extraGrants` names additional principals (the installing user, whose
 * identity only the installer knows) read access; see the caller for the
 * env var that supplies them.
 *
 * BEST-EFFORT, unlike ownerOnly: these are not secrets in the 0600 tier —
 * the token they carry is already scoped and revocable — and a failed
 * icacls degrades to the parent directory's inherited ACL, not to world
 * access. Refusing to start the IPC listener because a hardening step
 * failed would trade a small confidentiality margin for a total
 * availability loss, so the failure is reported, not thrown.
 */
export function applyServiceReadableDacl(filePath: string, extraGrants: string[] = []): WindowsAclResult {
  if (!isWindowsHost()) {
    return { attempted: false, succeeded: false, detail: "not running on win32" };
  }

  const grants = [`${SYSTEM_SID}:(F)`, `${ADMINISTRATORS_SID}:(R)`, ...extraGrants.map((g) => `${g}:(R)`)];

  try {
    icacls(filePath, ["/inheritance:r", "/grant:r", ...grants]);
    return { attempted: true, succeeded: true };
  } catch (err) {
    return {
      attempted: true,
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
