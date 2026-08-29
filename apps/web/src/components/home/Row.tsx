// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/home/Row.tsx
//
// Section shell for Home's simple rails (Continue Watching, Recently
// Added, New in Music — the Featured banner is its own component). ONE
// component tree (U2), and — since G1 (UIFIX-2026-08-29) — ONE heading
// string in it. This used to render `heading` (desktop, title-case, e.g.
// "Continue Watching") AND a `mobileHeading` sibling carrying different
// copy (e.g. "KEEP WATCHING"), with Row.module.css swapping which one
// painted at 767.98px; that was documented here as deliberate and is what
// G1 reverses. Two vocabularies for one rail is a copy defect, not a
// mobile affordance: a rail the viewer learns as "Continue Watching" on a
// laptop must not become a different section name on their phone. The
// phone form is now purely a CSS TREATMENT of this same <h2> (mono,
// uppercase, muted — Row.module.css's 767.98px block, the same breakpoint
// literal as the rest of the shell), so the phone copy is the desktop
// string uppercased. The Topbar/MobileHeader "both rendered, CSS-hidden"
// convention still applies where the two forms are genuinely different
// WIDGETS; it never licensed two different STRINGS for one label.

import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./Row.module.css";

export interface RowAction {
  label: string;
  href: string;
}

export function Row({
  heading,
  meta,
  action,
  empty,
  children,
}: {
  /** The rail's ONE section label, at every width (G1). Title-case: the
   *  phone form's uppercase is a CSS text-transform, not a second string. */
  heading: string;
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
