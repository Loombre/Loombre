// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/BottomSheet.tsx
//
// Phosphor phone-only bottom sheet (design/phosphor/README.md "Screens →
// Mobile → Phone-only additions": "Bottom sheets replace desktop modals.
// Sheet shell: 20px top corners, grab handle, title + sub + Done,
// max-height: 82%, scrollable body"). STATE.md Phosphor W1b scope.
//
// Composes with the EXISTING overlay machinery rather than inventing a
// parallel one: the scrim reuses components/ui/Overlay.module.css's
// `.scrim` (background/blur/position, already retargeted to
// --color-overlay + blur(3px) in Wave 0) via plain className composition —
// this file only ADDS properties (the enter/exit opacity transition)
// rather than overriding anything `.scrim` already declares, so there's no
// dependency on CSS Modules' cross-file cascade order. Vertical anchoring
// to the bottom of the viewport is `align-self: flex-end` on the sheet
// itself, not an override of `.scrim`'s centering `align-items` — same
// reasoning.
//
// Controlled component: the caller owns `open` (same shape as
// components/restricted/PinModal.tsx's `state.modalOpen` /
// closeUnlockModal()). Internally this still needs its OWN "am I still
// visually present" state so the exit transition can play before the
// element leaves the DOM — see overlay-hooks.ts's useExitTimer.
//
// SheetOrModal.tsx is the responsive seam: it renders this on narrow
// viewports and a desktop dialog (same Overlay.module.css recipe, same
// focus-trap/scroll-lock/escape hooks) above the breakpoint. Import this
// component directly only when a flow is deliberately sheet-only (it is
// legitimately phone-only UI per the README) — most Wave-2 flows should
// import SheetOrModal instead.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button.js";
import { useEscapeKey, useExitTimer, useFocusTrap, useScrollLock } from "./overlay-hooks.js";
import overlayStyles from "./Overlay.module.css";
import styles from "./BottomSheet.module.css";

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  doneLabel?: string;
  children: ReactNode;
}

/** Matches --motion-base (240ms, tokens.css) — the fallback-unmount timer
 *  in overlay-hooks.ts's useExitTimer. Kept as a plain constant rather than
 *  read from the custom property: it only needs to be "long enough to
 *  cover the real CSS transition", never pixel-exact (see that file's
 *  header for the full reasoning), and jsdom doesn't evaluate custom
 *  properties or the reduced-motion media query at all, so a computed-style
 *  read would be meaningless in tests anyway. */
const EXIT_FALLBACK_MS = 240;

export function BottomSheet({ open, onClose, title, sub, doneLabel = "Done", children }: BottomSheetProps): React.JSX.Element | null {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Enter: mount immediately, then flip to the "visible" class on the next
  // frame so the browser paints the closed (translateY(100%), opacity 0)
  // state at least once before the transition target changes — skipping
  // that first paint would coalesce both states into one and the CSS
  // transition would never run.
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    // Exit: flip back to the closed class immediately. Because this is a
    // CSS TRANSITION (not a keyframe animation restarting from 0%), if
    // `open` flips false while the enter transition is still mid-flight,
    // the browser starts the exit transition from whatever the CURRENT
    // interpolated transform/opacity is — no jump, no glitch. That's the
    // "dismiss mid-enter must not glitch" requirement, satisfied by the
    // platform rather than by any bookkeeping here.
    setVisible(false);
    return undefined;
  }, [open]);

  const finishClose = useExitTimer(mounted && !open, EXIT_FALLBACK_MS, () => setMounted(false));

  // Focus trap is scoped to `open` (the caller's intent), not `mounted`
  // (which stays true a little longer, through the exit transition) —
  // once the user has asked to close, Tab should behave normally again
  // immediately, and focus returns to the trigger right away rather than
  // waiting for the sheet to finish sliding away.
  useFocusTrap(sheetRef, open);
  // Scroll stays locked for the sheet's full visual lifetime, including
  // the exit transition, so the page behind it can't be scrolled while
  // content is still sliding off screen.
  useScrollLock(mounted);
  useEscapeKey(open, onClose);

  if (!mounted) return null;

  function handleScrimClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  function handleTransitionEnd(event: React.TransitionEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") return;
    if (!visible) finishClose();
  }

  return (
    <div className={`${overlayStyles.scrim} ${styles.scrim}`} data-visible={visible} onClick={handleScrimClick} role="presentation">
      <div
        ref={sheetRef}
        className={styles.sheet}
        data-visible={visible}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onTransitionEnd={handleTransitionEnd}
      >
        <div className={styles.handle} aria-hidden="true" />
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {sub ? <p className={styles.sub}>{sub}</p> : null}
          </div>
          <Button type="button" variant="ghost" className={styles.done} onClick={onClose}>
            {doneLabel}
          </Button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
