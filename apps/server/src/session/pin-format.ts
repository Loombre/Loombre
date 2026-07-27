// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/pin-format.ts
//
// The restricted-content PIN shape, enforced server-side for both surfaces
// that accept one: PUT /users/me/restricted (`RestrictedSettingsUpdate.pin`)
// and POST /restricted/unlock (`UnlockRequest.pin`). The contract
// (packages/contract/openapi.yaml) is the source of truth — it carries
// `minLength: 4`, `maxLength: 4`, `pattern: '^[0-9]{4}$'` on both — and this
// module is the conforming controller-side check (invariant 1: controllers
// conform to the contract, tested).
//
// WHY the constraint exists at all: the web client's ONE unlock surface,
// apps/web/src/components/restricted/PinModal.tsx, is a fixed PIN_LENGTH
// digit buffer that auto-submits on the last digit — it can neither enter
// nor send anything else. A server that happily stored a 5-digit PIN
// therefore locked that user out of restricted content permanently. The
// server is the boundary; the client's matching check (apps/web/src/lib/
// pin-entry.ts) is UX.
//
// DELIBERATELY NOT COVERED HERE: `currentPin` on PUT /users/me/restricted.
// That field proves an ALREADY-STORED secret, and an install predating this
// rule may hold a PIN of some other length. It stays unconstrained (in the
// contract too) so those users retain a SELF-SERVICE migration path — prove
// the old PIN, set a conforming new one, or opt out — rather than being
// stranded. It is only ever compared against a stored hash, never stored
// itself, so the looser shape widens nothing.
//
// H2 update: this is no longer the ONLY recovery path. `loombre admin
// reset-pin <username>` (apps/server/src/cli/admin-reset-pin.ts,
// server-local, interactively confirmed) now covers the case currentPin
// can't — a user who has forgotten their PIN entirely, with nothing to
// prove. currentPin stays exactly as unclamped as before (it is still the
// right tool for "I know my old PIN and it's just the wrong shape"); it
// dies naturally once no install can hold a legacy non-conforming PIN
// anymore, since every such PIN either gets rotated through this field or
// cleared through the CLI.

/** Digits in a PIN. Mirrors apps/web/src/lib/pin-entry.ts's PIN_LENGTH;
 *  the contract is what actually binds the two. */
export const PIN_LENGTH = 4;

/** The exact regex source the contract's `pattern` carries, exported so the
 *  spec can assert the two strings are identical rather than eyeballing it. */
export const PIN_PATTERN_SOURCE = `^[0-9]{${PIN_LENGTH}}$`;

const PIN_PATTERN = new RegExp(PIN_PATTERN_SOURCE);

/** True only for a string of exactly PIN_LENGTH ASCII digits. The literal
 *  `[0-9]` (rather than `\d`) keeps this byte-identical to the contract's
 *  own `pattern`, and ECMA-262's `$` without the `m` flag anchors at true
 *  end-of-input — so "١٢٣٤" and "1234\n" both correctly fail. */
export function isValidNewPin(value: unknown): value is string {
  return typeof value === "string" && PIN_PATTERN.test(value);
}
