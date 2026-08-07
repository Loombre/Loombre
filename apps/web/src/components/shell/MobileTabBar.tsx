// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/MobileTabBar.tsx
//
// Mobile bottom tab bar (Wave 1 W1a, README "Mobile" — "A 6-tab bottom
// bar"). Always rendered in the DOM (U2: one component tree, CSS decides
// visibility) — hidden above the mobile breakpoint via
// MobileTabBar.module.css, exactly the same convention Sidebar.module.css
// already uses for its icon-collapse. See tab-items.ts for the tab data
// and its header for the "exactly one tab lit at a time" zone-overlay hook
// point.
//
// Wave 2 (lane L8): the Restricted tab is filtered OUT entirely for a
// viewer with no restricted-library entitlement (hasRestrictedZoneEntitlement
// — the SAME predicate the sidebar/Browse-chip/UserMenu row gate on), never
// rendered disabled/dead. Self-contained useRestrictedZoneCount() call
// (same posture as Sidebar's own RestrictedNavEntry) rather than threading
// another prop through ShellNav.

import Link from "next/link";
import { Icon } from "../icon/Icon.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import { resolveShortcutHref } from "./nav-items.js";
import { resolveTabItem, TAB_ITEMS, type TabActiveContext } from "./tab-items.js";
import styles from "./MobileTabBar.module.css";

export interface MobileTabBarProps {
  ctx: TabActiveContext;
  moviesLibraryId: string | null;
  tvLibraryId: string | null;
  /** W3-R (opus review, D-6): threaded through from ShellNav (same value
   *  Sidebar already receives) so the settings-slot tab can be role-aware —
   *  see tab-items.ts's resolveTabItem for the label/href split. */
  isAdmin: boolean;
}

export function MobileTabBar({ ctx, moviesLibraryId, tvLibraryId, isAdmin }: MobileTabBarProps): React.JSX.Element {
  const { count } = useRestrictedZoneCount();
  const restrictedEntitled = hasRestrictedZoneEntitlement(count);
  const items = TAB_ITEMS.filter((item) => item.key !== "restricted" || restrictedEntitled);

  return (
    <nav className={styles.tabBar} aria-label="Primary">
      {items.map((item) => {
        const { label, href } = resolveTabItem(item, isAdmin);
        return (
          <Link
            key={item.key}
            href={resolveShortcutHref({ key: item.key, href }, moviesLibraryId, tvLibraryId)}
            className={styles.tab}
            data-active={item.isActive(ctx)}
          >
            <Icon icon={item.icon} className={styles.tabIcon ?? ""} />
            <span className={styles.tabLabel}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
