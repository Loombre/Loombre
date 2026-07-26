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
// This module is the file-WRITING half; the ACL itself comes from
// ./windows-acl.ts, which is the single home for every Windows ACL this
// codebase sets and which exposes the `ownerOnly` policy used here
// alongside the more permissive `serviceReadable` policy the IPC lane
// needs. Two secret writers reach this module — this package's own
// file0600 backend (JWT HMAC keys et al) and apps/server/src/tls/
// fs-secret.ts (TLS PRIVATE KEYS). packages/provisioning-pg keeps its own
// copy: that package must not depend on this one (see its header) and
// @loombre/provisioning is a pure contract package, so there is no shared
// home all three can reach — keep the two in sync.

import { chmodSync, writeFileSync } from "node:fs";
import { applyOwnerOnlyDacl, isWindowsHost } from "./windows-acl.js";

export const SECRET_FILE_MODE = 0o600;

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
