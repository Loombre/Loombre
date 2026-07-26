// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/owner-only-file.ts
//
// "Write this file so that only the account we run as can read it" — one
// guarantee, expressed differently per platform:
//
//     POSIX   — 0600 mode bits (owner read/write; nothing for group/other).
//     Windows — POSIX bits DO NOT EXIST there. Node's chmod only toggles
//               the read-only attribute and stat() reports 0o666 back (the
//               first windows-latest CI run caught exactly this: "expected
//               438 to be 384"). Without the treatment below a secret file
//               simply inherits its parent directory's DACL. So the
//               equivalent guarantee is made with an ACL: inheritance
//               stripped + a single explicit owner-only full-control ACE,
//               applied with icacls.
//
// This module is the CANONICAL implementation for the two secret writers
// that can reach it — this package's own file0600 backend (JWT HMAC keys
// et al) and apps/server/src/tls/fs-secret.ts (TLS PRIVATE KEYS). A third,
// architecturally-mandated copy lives in packages/provisioning-pg/src/
// secret/windows-acl.ts: that package must not depend on this one (see its
// header), and @loombre/provisioning is a pure contract package, so there
// is no shared home all three can reach. Keep the three in sync.

import { chmodSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { SecretAclError } from "./errors.js";

export const SECRET_FILE_MODE = 0o600;

/** True when POSIX mode bits are meaningless on this host. */
export function isWindowsHost(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * The icacls principal for the account this process runs as: `*<SID>` when
 * the SID is resolvable, else the plain account name. Exported so the
 * Windows CI assertions can name the same principal they expect to find in
 * the resulting DACL.
 *
 * The SID is preferred because an account NAME can be ambiguous on a
 * domain-joined machine (local `alice` vs domain `alice`); a SID cannot.
 * icacls accepts a SID when prefixed with `*`.
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
 * the account this process runs as. Throws SecretAclError on failure.
 *
 * `/inheritance:r` removes inherited ACEs outright (not `:d`, which would
 * COPY them), so entries like BUILTIN\Users do not survive. `/grant:r`
 * replaces rather than adds to any existing grant for that principal.
 *
 * Deliberate consequence: Administrators and SYSTEM are NOT granted. They
 * can still take ownership (inherent to Windows), but cannot read the file
 * as-is. If the server is later run under a DIFFERENT Windows account than
 * the one that wrote the secret, that account cannot read it — see
 * STATE.md's platform note.
 */
export function applyOwnerOnlyDacl(filePath: string): void {
  const principal = currentUserPrincipal();
  const icacls = (args: string[]): string => {
    try {
      return execFileSync("icacls", [filePath, ...args], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      throw new SecretAclError(filePath, principal, cause);
    }
  };

  icacls(["/inheritance:r", "/grant:r", `${principal}:F`]);

  // Those two flags alone are NOT enough, which the first windows-latest
  // run of this code proved: it left three ACEs behind. `/inheritance:r`
  // removes only INHERITED entries, and `/grant:r` replaces only the NAMED
  // principal's entry — so any OTHER principal holding an EXPLICIT ACE
  // (SYSTEM and Administrators, typically) survives both. Enumerate what is
  // actually left and remove everything that is not us.
  const me = userInfo().username;
  for (const other of daclPrincipals(filePath, icacls([]))) {
    if (!sameAccount(other, me)) icacls(["/remove:g", other]);
  }

  // Verify the postcondition rather than assuming it. This is a
  // confidentiality control: if the DACL is not exactly one ACE, the
  // guarantee this function exists to make has not been made.
  const remaining = daclPrincipals(filePath, icacls([]));
  if (remaining.length !== 1 || !sameAccount(remaining[0]!, me)) {
    throw new SecretAclError(filePath, principal, new Error(`DACL is not owner-only after hardening: [${remaining.join(", ")}]`));
  }
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
 * Write `contents` to `filePath` with owner-only access on every platform.
 * The directory is NOT created here — callers own that (they already
 * mkdir -p their own layout).
 *
 * On Windows the file is created EMPTY, the DACL is applied, and only then
 * are the secret bytes written: any other order would leave the secret
 * briefly readable under the parent directory's inherited permissions.
 */
export function writeOwnerOnlyFile(filePath: string, contents: string | Buffer): void {
  if (isWindowsHost()) {
    writeFileSync(filePath, "");
    applyOwnerOnlyDacl(filePath);
    writeFileSync(filePath, contents);
    return;
  }
  // Node's `mode` option on writeFileSync only takes effect on file
  // CREATION (O_CREAT) — an existing file's mode is left untouched (a
  // renewal rewriting a cert, for instance), so every write is followed by
  // an explicit chmod.
  writeFileSync(filePath, contents, { mode: SECRET_FILE_MODE });
  chmodSync(filePath, SECRET_FILE_MODE);
}

/**
 * Re-assert owner-only protection on a file that already exists, without
 * touching its content. Lets a secret written by a build that predated this
 * hardening be repaired on the next run.
 */
export function reassertOwnerOnly(filePath: string): void {
  if (isWindowsHost()) {
    applyOwnerOnlyDacl(filePath);
    return;
  }
  chmodSync(filePath, SECRET_FILE_MODE);
}
