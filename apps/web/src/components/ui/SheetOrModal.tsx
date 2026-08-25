// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/SheetOrModal.tsx
//
// The responsive seam design/phosphor/README.md asks for explicitly:
// "the sheet is the small-viewport counterpart of the modal (desktop keeps
// modals; Wave-2 flows will choose per breakpoint)". Deliberately thin —
// BottomSheet.tsx carries all the phone-specific richness (grab handle,
// interruptible slide+fade, focus trap, scroll lock); the desktop branch
// here reuses the SAME Overlay.module.css `.scrim`/`.dialog` recipe every
// other dialog in the app already composes (components/admin/Modal.tsx,
// components/restricted/PinModal.tsx), plus the same accessibility hooks
// as BottomSheet (overlay-hooks.ts) so both branches trap focus, lock
// scroll, and close on Escape identically. No bespoke interruptible exit
// animation on the desktop branch — that rigor was asked for on the SHEET
// specifically; the desktop dialog matches the existing app convention of
// unmounting immediately on close (same as Modal.tsx today).
//
// DISMISS LABEL (d4-e3): the header control below is this primitive's, but
// `doneLabel` — what it SAYS — belongs to the caller, and a flow where
// dismissing costs something must set it. AddLibrarySheet's ungranted
// restricted-create panel is the case that proved it: its own body button
// said "Close without access" while this control still said "Done" and ran
// the same onClose, so the panel's two dismiss controls disagreed about what
// the click meant. Escape and the scrim carry no label at all — a flow that
// needs the user WARNED must therefore also warn in the body, as that one
// does; the label is not a substitute for that.
//
// BREAKPOINT (reconciled at Wave-1 landing): matches W1a's shipped
// sidebar ⇄ bottom-tab-bar swap exactly — sheets belong with the tab-bar
// layout, modals with the sidebar layout. 767.98px is the same repeated
// literal as the shell chrome's media queries (a JS matchMedia string
// here); see tokens.css "Mobile chrome layout" for the single source of
// truth and the list of files that must stay in sync.

import { useId, useRef } from "react";
import { BottomSheet, type BottomSheetProps } from "./BottomSheet.js";
import { Button } from "./Button.js";
import { useEscapeKey, useFocusTrap, useScrollLock } from "./overlay-hooks.js";
import { useMediaQuery } from "./use-media-query.js";
import overlayStyles from "./Overlay.module.css";
import styles from "./SheetOrModal.module.css";

export type SheetOrModalProps = BottomSheetProps;

const PHONE_QUERY = "(max-width: 767.98px)";

function DesktopDialog({ open, onClose, title, sub, doneLabel = "Done", children }: SheetOrModalProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useFocusTrap(dialogRef, open);
  useScrollLock(open);
  useEscapeKey(open, onClose);

  if (!open) return null;

  function handleScrimClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className={overlayStyles.scrim} onClick={handleScrimClick} role="presentation">
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {sub ? <p className={styles.sub}>{sub}</p> : null}
          </div>
          <Button type="button" variant="ghost" className={styles.doneButton} onClick={onClose}>
            {doneLabel}
          </Button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}

/** Renders BottomSheet below PHONE_QUERY, a desktop dialog above it. Same
 *  controlled-open API as BottomSheet either way — Wave-2 flows should
 *  reach for this instead of choosing BottomSheet vs a hand-rolled dialog
 *  themselves. */
export function SheetOrModal(props: SheetOrModalProps): React.JSX.Element | null {
  const isPhone = useMediaQuery(PHONE_QUERY);
  return isPhone ? <BottomSheet {...props} /> : <DesktopDialog {...props} />;
}
