// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/home/Row.tsx
//
// Section shell for Home's simple rails (Continue Watching, Recently
// Added, New in Music — the Featured banner is its own component). ONE
// component tree (U2): `heading` (desktop, title-case — e.g. "Continue
// Watching") and `mobileHeading` (the phone form's mono/uppercase copy —
// e.g. "KEEP WATCHING", a DIFFERENT word per the README's mobile section,
// not just a re-cased desktop string) are both always in the DOM; CSS
// (Row.module.css, the same 767.98px breakpoint literal as the rest of the
// shell) decides which one paints, matching the established
// Topbar/MobileHeader "both rendered, CSS-hidden" convention.

import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./Row.module.css";

export interface RowAction {
  label: string;
  href: string;
}

export function Row({
  heading,
  mobileHeading,
  meta,
  action,
  empty,
  children,
}: {
  heading: string;
  /** Mobile phone-form section label — README §Mobile's own copy (mono,
   *  uppercase), not derived from `heading`. Falls back to an uppercased
   *  `heading` only if not supplied, so a caller can't forget it silently. */
  mobileHeading?: string;
  /** Real, derived readout (e.g. an item count) — never invented fixture
   *  copy like the prototype's "SYNCED ACROSS 4 DEVICES · 12S AGO". */
  meta?: string;
  action?: RowAction;
  empty?: string;
  children: ReactNode[];
}): React.JSX.Element {
  return (
    <section className={styles.row}>
      <div className={styles.headingRow}>
        <h2 className={styles.heading}>{heading}</h2>
        <span className={styles.mobileHeading}>{mobileHeading ?? heading.toUpperCase()}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
        {action && (
          // next/link, never a raw <a href> (QA C/zone-row-action-raw-anchor):
          // app/restricted/page.tsx renders its rails with this component, so
          // "ALL →" out of the UNLOCKED zone used to be a full document load —
          // RestrictedProvider starts over at locked=true and cannot rehydrate
          // the live server-side unlock, so the destination showed the PIN gate
          // and burned one of the 5 unlock attempts/min. On the public home it
          // was "only" a full reload of an app that is already loaded.
          <Link href={action.href} className={styles.action}>
            {action.label}
          </Link>
        )}
      </div>
      {children.length === 0 ? (
        <div className={styles.empty}>{empty ?? "Nothing here yet."}</div>
      ) : (
        <div className={styles.scroller}>{children}</div>
      )}
    </section>
  );
}
