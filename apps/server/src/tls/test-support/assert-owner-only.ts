// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/test-support/assert-owner-only.ts
//
// One place for "prove this secret file is owner-only", so the TLS specs
// state the guarantee once per platform instead of hardcoding 0600 (which
// is meaningless on Windows — chmod there only toggles the read-only
// attribute and stat() reports 0o666, exactly what the first
// windows-latest CI run failed on).
//
//   POSIX   — assert the 0600 mode bits.
//   Windows — assert the DACL that fs-secret.ts actually applied: no
//             inherited ACEs, no broad principals, exactly one
//             full-control ACE, owned by this process's account. This IS
//             the Windows CI assertion that the ACL we set is the ACL on
//             disk.
//
// Throws (rather than importing vitest's `expect`) so this file stays free
// of test-framework imports, matching self-signed-cert.ts's posture in this
// same directory — a throw fails the calling test just as loudly.

import { statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { currentUserPrincipal } from "@loombre/secrets";

export const IS_WINDOWS = process.platform === "win32";

function fail(path: string, why: string, detail: string): never {
  throw new Error(`assertOwnerOnlyFile(${path}): ${why}\n${detail}`);
}

/** ACE lines from `icacls <path>`, matched positively on the
 *  "principal:(FLAGS)" shape so this does not depend on the host's display
 *  language (the trailing summary line is localized; ACEs are not). */
function aceLines(acl: string): string[] {
  return acl
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /:\([A-Z]/.test(l));
}

export function assertOwnerOnlyFile(path: string): void {
  if (!IS_WINDOWS) {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) fail(path, `expected mode 0600, got 0${mode.toString(8)}`, "");
    return;
  }

  const acl = execFileSync("icacls", [path], { encoding: "utf8", windowsHide: true });

  if (/\(I\)/.test(acl)) fail(path, "inherited ACEs present — /inheritance:r did not take effect", acl);
  for (const broad of [/BUILTIN\\Users/i, /\bEveryone\b/i, /Authenticated Users/i]) {
    if (broad.test(acl)) fail(path, `a broad principal (${String(broad)}) can read this secret`, acl);
  }

  const aces = aceLines(acl);
  if (aces.length !== 1) fail(path, `expected exactly 1 ACE, got ${aces.length}`, acl);
  if (!/:\(F\)$/.test(aces[0]!)) fail(path, "the single ACE is not full-control", acl);

  const principal = currentUserPrincipal();
  const bareName = principal.startsWith("*") ? userInfo().username : principal;
  if (!aces[0]!.toLowerCase().includes(bareName.toLowerCase())) {
    fail(path, `the single ACE does not belong to this process's account (${bareName})`, acl);
  }
}
