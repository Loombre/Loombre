// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/restricted/RestrictedZoneChip.tsx
//
// Detail-page chip for a restricted-zone title (design/phosphor/README.md
// "Interactions -> Restricted content": "Detail pages of zone titles carry
// a RESTRICTED · PIN HOLDERS ONLY chip beside the eyebrow (full-width amber
// band on mobile)"). Its own file per this lane's brief ("put the chip in
// its own component file") — app/items/[itemType]/[id]/page.tsx (L4's
// file) only imports and conditionally renders this, a one-line-per-type
// surgical addition; L4 owns everything else on that page.
//
// No props beyond whether to render at all — the caller (page.tsx) already
// knows contentClass from the fetched item and decides when to mount this;
// this component has no fetching/guard logic of its own (the chip is
// purely presentational, matching U10: enforcement lives in the query
// layer, this is affordance/labeling only).

import styles from "./RestrictedZoneChip.module.css";

export function RestrictedZoneChip(): React.JSX.Element {
  return (
    <span className={styles.chip}>
      Restricted <span className={styles.dot} aria-hidden="true" /> PIN holders only
    </span>
  );
}
