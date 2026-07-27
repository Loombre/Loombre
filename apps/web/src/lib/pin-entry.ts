// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/pin-entry.ts
//
// Pure digit-buffer logic for components/restricted/PinModal.tsx (design/
// phosphor/README.md "Interactions -> Restricted content": "4-digit PIN
// entry, auto-submits on the fourth digit"). Factored out of the component
// so the auto-submit RULE is unit-testable without mounting React/
// RestrictedProvider/network mocks — same separation-of-concerns
// shell/mobile-header.ts, shell/tab-items.ts, and lib/restricted-zone-
// toolbar.ts already use for their own pure predicates.

export const PIN_LENGTH = 4;

/** Digits-only, NO length clamp. Split out of sanitizePinInput so the one
 *  field that must accept a non-conforming value can share the digit filter
 *  without also inheriting the clamp: settings' "Current PIN" proves an
 *  ALREADY-STORED PIN, and an install predating the PIN_LENGTH rule may
 *  hold a longer one. Clamping there would leave those users unable to
 *  rotate to a conforming PIN or even opt out — i.e. no recovery at all.
 *  Every OTHER surface wants sanitizePinInput below. */
export function stripPinDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

/** Strips non-digits and clamps to PIN_LENGTH — the sanitizer both the
 *  desktop text field's onChange and the phone keypad's digit buttons
 *  route every update through, so they can never disagree about what a
 *  "valid" buffer looks like. */
export function sanitizePinInput(raw: string): string {
  return stripPinDigits(raw).slice(0, PIN_LENGTH);
}

/** Appends one digit to `current`, ignored once the buffer is already full
 *  (the keypad's own digit buttons all call this — a full buffer simply
 *  doesn't grow further until it's cleared, rather than needing every call
 *  site to separately guard the length). */
export function appendPinDigit(current: string, digit: string): string {
  if (current.length >= PIN_LENGTH) return current;
  return sanitizePinInput(current + digit);
}

/** THE auto-submit rule: exactly PIN_LENGTH digits present. */
export function isPinComplete(pin: string): boolean {
  return pin.length === PIN_LENGTH;
}
