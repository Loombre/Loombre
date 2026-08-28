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
// a text field) and a keyboard-typable numeric field — a real
// keyboard-accessibility affordance the dc's static mockup can't express.
// Renders through SheetOrModal (W1b primitive) instead of a hand-rolled
// scrim/dialog: the README lists "PIN entry" among the nine phone-only
// bottom sheets, so the mobile form is a real sheet, not a narrower modal.
//
// LD-17 (rc.6): that numeric field is no longer a visible 160px control at
// desktop widths. It is visually hidden but still FOCUSABLE at EVERY width
// (owner ruling R3 deleted the old phone-only `display: none` branch, which
// is why no media query is left in PinModal.module.css); the dots are the
// sole visible representation of entry state and now carry the field's
// focus ring; and the two focus fixes below keep hardware-keyboard entry
// working now that there is no visible field left to click into.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Delete, Lock } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { SheetOrModal } from "../ui/SheetOrModal.js";
import { TextInput } from "../ui/Input.js";
import { PIN_LENGTH, appendPinDigit, isPinComplete, sanitizePinInput } from "../../lib/pin-entry.js";
import { useRestricted } from "./RestrictedProvider.js";
import { useMediaQuery } from "../ui/use-media-query.js";
import styles from "./PinModal.module.css";

const KEYPAD_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

// 767.98px is the shared mobile-breakpoint literal (tokens.css "Mobile
// chrome layout"; same copy SheetOrModal.tsx keys the sheet/dialog split on).
// Used here only to CONFINE the LD-17 (rc.6) programmatic-focus calls to the
// desktop dialog the decision governs: on a phone, focusing the hidden
// inputMode="numeric" field would raise the soft keyboard over the keypad
// the sheet flow is built around. The field stays focusable at every width
// (R3); only the automatic focus placement is desktop-only.
const PHONE_QUERY = "(max-width: 767.98px)";

/**
 * Puts focus on the (LD-17, rc.6: visually hidden) PIN field.
 *
 * Reached through the form rather than a ref on <TextInput> because
 * ui/Input.tsx's TextInput takes plain InputHTMLAttributes and declares no
 * `ref` prop — and this form holds exactly ONE input element, the same
 * single-input assumption PinModal.module.css's
 * `.form:has(input:focus-visible)` ring rule makes. Module-scope so its
 * identity is stable across renders.
 */
function focusPinField(formRef: React.RefObject<HTMLFormElement | null>): void {
  formRef.current?.querySelector("input")?.focus();
}

export function PinModal(): React.JSX.Element | null {
  const { state, closeUnlockModal, unlock } = useRestricted();
  const [pin, setPin] = useState("");
  const submittingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const isPhone = useMediaQuery(PHONE_QUERY);

  // Fresh entry every time the modal opens — no residual digits from a
  // previous cancelled/failed attempt.
  useEffect(() => {
    if (state.modalOpen) setPin("");
  }, [state.modalOpen]);

  // LD-17 (rc.6): with the field visually hidden there is nothing left to
  // click into, so focus has to be put there in code — the decision's
  // "hardware-keyboard entry must keep working" is unmeetable otherwise.
  // The field's own `autoFocus` does NOT survive the mount: SheetOrModal's
  // useFocusTrap moves initial focus to the dialog's first focusable, which
  // is the header's "Done" button (proven in PinModal.test.tsx — the red run
  // for this change found document.activeElement was that button). This
  // effect wins because React flushes a CHILD's passive effects before its
  // parent's, and the trap lives in DesktopDialog/BottomSheet, both
  // descendants of this component.
  // Re-running on `submitting` also restores focus after a REJECTED attempt:
  // the field is `disabled` while submitting, and a disabled element drops
  // focus, so without this a user could type exactly one wrong PIN and then
  // never type again.
  // Deferred one frame: the dialog subtree MOUNTS when the modal opens, and
  // React dev StrictMode double-invokes the new subtree's effects — the focus
  // trap's cleanup restores focus and its re-run focuses the Done button
  // AFTER this long-mounted component's dep-effect already ran (verified live
  // in the dev server; jsdom test renders have no StrictMode and masked it).
  // A rAF callback runs after that whole remount cycle in dev and after the
  // single pass in prod, so the field wins in both.
  useEffect(() => {
    if (!state.modalOpen || state.submitting || isPhone) return undefined;
    const frame = requestAnimationFrame(() => focusPinField(formRef));
    return () => cancelAnimationFrame(frame);
  }, [state.modalOpen, state.submitting, isPhone]);

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

  // LD-17 (rc.6): pressing a keypad key natively moves focus onto that
  // <button>, and with the field visually hidden there is no way to click
  // back into it — mixed entry (tap "1", then type "2","3","4") would
  // silently stop filling dots. Both keypad value paths therefore route
  // focus home. This also covers handleKeypadKeyDown's Enter/Space
  // activation, which lands the user on the field ready to keep typing.
  function appendDigit(digit: string): void {
    if (state.submitting) return;
    setPin((prev) => appendPinDigit(prev, digit));
    if (!isPhone) focusPinField(formRef);
  }

  function backspace(): void {
    if (state.submitting) return;
    setPin((prev) => prev.slice(0, -1));
    if (!isPhone) focusPinField(formRef);
  }

  function handleKeypadKeyDown(event: KeyboardEvent<HTMLButtonElement>, digit: string): void {
    // The 74px circular keys are real <button>s. This handler activates a
    // key on Enter/Space (append the digit) and preventDefault()s the key so
    // Space never scrolls the sheet and Enter never submits a surrounding
    // form. It is NOT arrow-key roving between keys — the keypad grid uses
    // plain tab-order navigation, not a roving-tabindex pattern.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      appendDigit(digit);
    }
  }

  return (
    <SheetOrModal open={state.modalOpen} onClose={closeUnlockModal} title="Enter PIN" sub="Unlock restricted content for this session.">
      <form ref={formRef} className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.iconRow} aria-hidden="true">
          <Icon icon={Lock} />
        </div>

        <div className={styles.dots} role="status" aria-label={`PIN entry: ${pin.length} of ${PIN_LENGTH} digits`}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span key={i} className={styles.dot} data-filled={i < pin.length} />
          ))}
        </div>

        {/* The keyboard-typable numeric field — the ONLY path a hardware
            keystroke or a paste can reach `pin` by.
            LD-17 (rc.6): it is now visually hidden but still FOCUSABLE (the
            ui/Toggle.module.css recipe, in PinModal.module.css's
            `input.hiddenInput`), at every width per owner ruling R3 — the
            dots above are the sole visible representation of entry state.
            Its four required attributes are inputMode="numeric",
            autoComplete="off", an aria-label, and a focus ring — the ring
            being the one that moved, onto `.dots`, because the shared
            `.input:focus-visible` INSET ring paints nothing on a 1x1
            clipped box. `autoFocus` is kept but is not what actually lands
            focus here; see the focus effect above. Still rendered through
            ui/Input.tsx's TextInput (item 2, Wave A), never a raw element. */}
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
