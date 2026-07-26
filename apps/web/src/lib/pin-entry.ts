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

/** Strips non-digits and clamps to PIN_LENGTH — the sanitizer both the
 *  desktop text field's onChange and the phone keypad's digit buttons
 *  route every update through, so they can never disagree about what a
 *  "valid" buffer looks like. */
export function sanitizePinInput(raw: string): string {
  return raw.replace(/[^0-9]/g, "").slice(0, PIN_LENGTH);
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
