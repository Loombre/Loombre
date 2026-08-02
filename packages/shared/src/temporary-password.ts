// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/temporary-password.ts
//
// Admin/CLI password recovery (E3a/M14, STATE.md "Optional mail transport +
// invitation & reset flows"): a crypto-random temporary password shown
// exactly once to the operator (stdout for the CLI, an HTTP response body
// for the admin action — never stored or logged in plaintext, never in an
// event payload) and immediately argon2id-hashed by the caller.
//
// Format (recorded per the owner brief's instruction — this IS the
// contract, not an implementation detail): 20 characters drawn uniformly
// from a 54-character unambiguous charset (uppercase + lowercase + digits,
// with BOTH cases of I/L/O and digits 0/1 removed — six characters an
// operator reading it off a terminal or a user typing it off a screen
// could otherwise confuse: 0/O, 1/I/l/L). Entropy: floor(log2(54) * 20) ≈
// 114 bits — comfortably over the "~16+ chars" floor the brief sets, and
// the charset choice trades a small amount of entropy-per-character for
// zero read-back ambiguity, which matters more here than for a
// machine-generated API key: a human is meant to read and type this once.
//
// node:crypto only (no browser use — this module is imported by
// apps/server and apps/server/src/cli/*, never by apps/web; see
// packages/shared/src/ids.ts's identical node:crypto precedent and
// apps/web's SUBPATH-only import convention, which keeps this module out
// of any browser bundle).

import { randomInt } from "node:crypto";

/** Digits 0/1 and both cases of I/L/O excluded — see this file's header. */
const TEMPORARY_PASSWORD_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export const TEMPORARY_PASSWORD_LENGTH = 20;

/**
 * `randomInt` (not `randomBytes` + modulo, which would bias the
 * distribution toward the low end of the charset for any charset length
 * that doesn't evenly divide 256) — uniform over
 * `[0, TEMPORARY_PASSWORD_CHARSET.length)` per call.
 */
export function generateTemporaryPassword(length: number = TEMPORARY_PASSWORD_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += TEMPORARY_PASSWORD_CHARSET.charAt(randomInt(TEMPORARY_PASSWORD_CHARSET.length));
  }
  return out;
}
