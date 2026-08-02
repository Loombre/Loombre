// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/email-format.ts
//
// R-F4 (opus adversarial review, fix wave — STATE.md "Current-password
// re-auth on self-changes + the email-collision signal"): a single,
// shared format check for every user-supplied email address that gets
// STORED (users.email via updateMe/createUser, invites.email via
// createInvite/claimInvite) — the contract declares `format: email`
// everywhere but, before this fix, only `typeof === "string"` was
// actually enforced server-side, so `"not an address"` was accepted
// outright and a value like `"victim@example.invalid\r\nBcc:evil@x.y"`
// could ride a `mail-send` job's `to:` field verbatim (F5 made
// users.email exactly that — a third-party-triggered mail recipient).
//
// Reuses zod v4's `z.email()` rather than a hand-rolled regex — the SAME
// primitive this package's settings-registry.ts already validates
// `mail.fromAddress` with (`OPTIONAL_EMAIL_SCHEMA`); this export is that
// same check with no "or empty string" escape hatch, since every call
// site here has already decided (via `undefined`/`null` handling one
// layer up) that a non-empty string is being validated as an address.
// Verified empirically (not just assumed) to reject every R-F4 case:
// a bare "not an address", any embedded ASCII control character
// (\r \n \t \0 etc. — z.email()'s regex has no character class that
// admits them), and leading/trailing whitespace (callers additionally
// `.trim()` before calling this, so a would-be-valid address surrounded
// by spaces is normalized rather than silently rejected — see each call
// site's own comment for why trim-then-validate, not reject-on-whitespace,
// is what R-F4's own pinned test requires).

import { z } from "zod";

const EMAIL_SCHEMA = z.email();

/** True iff `value` is a syntactically valid, control-character-free email
 *  address. Deliberately permissive about DELIVERABILITY (this is a shape
 *  check, not an SMTP handshake) — same posture as OPTIONAL_EMAIL_SCHEMA. */
export function isValidEmailFormat(value: string): boolean {
  return EMAIL_SCHEMA.safeParse(value).success;
}
