// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/fs-secret.ts
//
// Shared "write this file as a 0600 secret" helper (P4.7's file0600
// backend, docs/PLAN.md §10 "secrets ... else 0600 file"). A single spot
// for the mode-on-overwrite gotcha: Node's fs.writeFileSync `mode` option
// only takes effect when the file is CREATED (O_CREAT); on an existing
// file (renewal rewriting a cert, for instance) the mode is left
// untouched, so every write here is followed by an explicit chmod.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SECRET_FILE_MODE = 0o600;

export function writeSecretFile(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: SECRET_FILE_MODE });
  chmodSync(path, SECRET_FILE_MODE);
}
