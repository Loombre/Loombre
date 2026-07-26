// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/RestrictedZoneBrowseChip.tsx
//
// Browse's amber "N RESTRICTED · PIN-GATED ZONE →" chip (design/phosphor/
// README.md "Interactions -> Restricted content": "Browse shows an amber
// `N RESTRICTED · PIN-GATED ZONE →` chip that navigates there (mobile: a
// 44px tappable row above the grid)"). Own component file so
// app/browse/page.tsx's edit is a one-line import + render, not a
// surgical CSS/logic addition inline there.
//
// Entirely hidden for a viewer with no restricted-library entitlement —
// the SAME hasRestrictedZoneEntitlement predicate every other zone entry
// point gates on (sidebar, mobile tab, UserMenu row).

import Link from "next/link";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import styles from "./RestrictedZoneBrowseChip.module.css";

export function RestrictedZoneBrowseChip(): React.JSX.Element | null {
  const { count } = useRestrictedZoneCount();

  if (!hasRestrictedZoneEntitlement(count)) return null;

  return (
    <Link href="/restricted" className={styles.chip}>
      {count} restricted <span aria-hidden="true">·</span> PIN-gated zone
      <span aria-hidden="true" className={styles.arrow}>
        →
      </span>
    </Link>
  );
}
