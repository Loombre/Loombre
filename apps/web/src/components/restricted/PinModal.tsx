// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/PinModal.tsx
//
// PIN-unlock flow (P2.8), mounted once app-wide by AppProviders and driven
// entirely by RestrictedProvider's context state — RestrictedLockControl
// (and the /restricted gate screen, Wave 2 lane L8) just call
// openUnlockModal(), never render this dialog themselves.
//
// Wave 2 (lane L8) rebuild per design/phosphor/README.md "Interactions ->
// Restricted content": "4-digit PIN entry, auto-submits on the fourth
// digit" and "Phone-only additions -> PIN keypad — 74px circular keys in a
// 3-column grid with filled dot indicators". Ground-truthed against the
// PRE-Wave-2 version of this file (P2.8-era): it took a free-length PIN
// (maxLength 12) with a manual Submit button — no auto-submit, no keypad.
// Rebuilt here as ONE responsive component (U2): a 4-slot dot indicator row
// plus TWO input mechanisms feeding the same `pin` state — a 74px circular
// 3-column keypad (shown at every width, per H20/W3 fidelity audit: the
// dc's own desktop pin dialog, dc:2994-3013, renders this same keypad, not
// a text field) and a keyboard-typable numeric field (CSS-hidden below the
// shell's 767.98px boundary, tokens.css "Mobile chrome layout" — kept at
// desktop widths as a real keyboard-accessibility affordance the dc's
// static mockup can't express).
// Renders through SheetOrModal (W1b primitive) instead of a hand-rolled
// scrim/dialog: the README lists "PIN entry" among the nine phone-only
// bottom sheets, so the mobile form is a real sheet, not a narrower modal.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Delete, Lock } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { SheetOrModal } from "../ui/SheetOrModal.js";
import { TextInput } from "../ui/Input.js";
import { PIN_LENGTH, appendPinDigit, isPinComplete, sanitizePinInput } from "../../lib/pin-entry.js";
import { useRestricted } from "./RestrictedProvider.js";
import styles from "./PinModal.module.css";

const KEYPAD_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function PinModal(): React.JSX.Element | null {
  const { state, closeUnlockModal, unlock } = useRestricted();
  const [pin, setPin] = useState("");
  const submittingRef = useRef(false);

  // Fresh entry every time the modal opens — no residual digits from a
  // previous cancelled/failed attempt.
  useEffect(() => {
    if (state.modalOpen) setPin("");
  }, [state.modalOpen]);

  // Auto-submit on the 4th digit (README, verbatim). Resets the buffer on
  // a failed attempt so the user can immediately retry; on success
  // RestrictedProvider.unlock() itself flips modalOpen false.
  useEffect(() => {
    if (!isPinComplete(pin) || submittingRef.current) return;
    submittingRef.current = true;
    void unlock(pin).then((ok) => {
      submittingRef.current = false;
      if (!ok) setPin("");
    });
  }, [pin, unlock]);

  if (!state.modalOpen) return null;

  function handleSubmit(event: FormEvent): void {
    // No manual submit path any more (auto-submit on the 4th digit) — this
    // only exists so Enter inside the text field doesn't reload the page.
    event.preventDefault();
  }

  function appendDigit(digit: string): void {
    if (state.submitting) return;
    setPin((prev) => appendPinDigit(prev, digit));
  }

  function backspace(): void {
    if (state.submitting) return;
    setPin((prev) => prev.slice(0, -1));
  }

  function handleKeypadKeyDown(event: KeyboardEvent<HTMLButtonElement>, digit: string): void {
    // 74px circular keys are still real buttons — Enter/Space activation
    // comes for free; this only exists so the keypad grid is genuinely
    // arrow-key navigable rather than a plain tab-order-only grid, matching
    // the roving grid pattern the rest of the app's grids use.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      appendDigit(digit);
    }
  }

  return (
    <SheetOrModal open={state.modalOpen} onClose={closeUnlockModal} title="Enter PIN" sub="Unlock restricted content for this session.">
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.iconRow} aria-hidden="true">
          <Icon icon={Lock} />
        </div>

        <div className={styles.dots} role="status" aria-label={`PIN entry: ${pin.length} of ${PIN_LENGTH} digits`}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span key={i} className={styles.dot} data-filled={i < pin.length} />
          ))}
        </div>

        {/* Desktop: keyboard-typable numeric field. CSS-hidden on phone,
            where the keypad below is the primary input. Consolidated onto
            the shared ui/Input.tsx TextInput (item 2, an upstream media server-study Wave
            A) — inherits Input.module.css's `.input:focus-visible` inset
            ring instead of shipping its own copy; PinModal.module.css's
            `.hiddenInput` now only carries the PIN field's own overrides. */}
        <TextInput
          className={styles.hiddenInput}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          maxLength={PIN_LENGTH}
          value={pin}
          disabled={state.submitting}
          onChange={(e) => setPin(sanitizePinInput(e.target.value))}
          aria-label="PIN"
        />

        {/* Phone: 74px circular keys, 3-column grid, filled dot indicators
            above (README "Phone-only additions -> PIN keypad"). CSS-hidden
            above the 767.98px breakpoint. */}
        <div className={styles.keypad} role="group" aria-label="PIN keypad">
          {KEYPAD_DIGITS.map((digit) => (
            <button
              key={digit}
              type="button"
              className={styles.key}
              disabled={state.submitting}
              onClick={() => appendDigit(digit)}
              onKeyDown={(e) => handleKeypadKeyDown(e, digit)}
            >
              {digit}
            </button>
          ))}
          <span aria-hidden="true" />
          <button type="button" className={styles.key} disabled={state.submitting} onClick={() => appendDigit("0")}>
            0
          </button>
          <button
            type="button"
            className={styles.key}
            disabled={state.submitting || pin.length === 0}
            onClick={backspace}
            aria-label="Backspace"
          >
            <Icon icon={Delete} />
          </button>
        </div>

        {state.error && (
          <div className={styles.error} role="alert">
            {state.error}
          </div>
        )}
      </form>
    </SheetOrModal>
  );
}
