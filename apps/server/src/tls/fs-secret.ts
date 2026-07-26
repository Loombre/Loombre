// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/fs-secret.ts
//
// Shared "write this file as an owner-only secret" helper for the TLS lane
// (P4.7's file0600 backend, docs/PLAN.md §10 "secrets ... else 0600 file").
// These are the most sensitive files this server writes: the ACME account
// key and the issued certificate's PRIVATE KEY.
//
// WHAT THIS GUARANTEES, PER PLATFORM — the "0600" in the backend name is
// POSIX-flavoured, the guarantee itself is not POSIX-only:
//
//   POSIX   — 0600 mode bits: owner read/write, nothing for group/other.
//             Node's `mode` option only applies on file CREATION (O_CREAT);
//             on an existing file (a renewal rewriting a cert) the mode is
//             left untouched, so the write is followed by an explicit
//             chmod.
//   Windows — POSIX bits do not exist there (chmod only toggles the
//             read-only attribute; stat() reports 0o666 back), so the file
//             would otherwise simply inherit its parent directory's DACL.
//             The equivalent guarantee is an explicit owner-only DACL
//             applied with icacls, and the file is created EMPTY before the
//             DACL goes on, so the key bytes never exist on disk under
//             inherited permissions.
//
// Both halves live in @loombre/secrets' owner-only-file.ts so this lane and
// that package's own file0600 backend share ONE implementation.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SECRET_FILE_MODE, writeOwnerOnlyFile } from "@loombre/secrets";

export { SECRET_FILE_MODE };

export function writeSecretFile(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeOwnerOnlyFile(path, contents);
}
