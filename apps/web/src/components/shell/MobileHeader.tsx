// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/MobileHeader.tsx
//
// Mobile large-title chrome header (Wave 1 W1a, README "Mobile" —
// "a large-title header (31px, -.02em) with subtitle, a back chevron with
// contextual label, a restricted-lock icon button, and an avatar"). Always
// rendered (U2); hidden above the mobile breakpoint by CSS, the same
// pattern as MobileTabBar/Sidebar.
//
// Two render modes from resolveMobileHeader() (mobile-header.ts): "title"
// (large title + optional subtitle, no back control — the current route
// IS one of the tab bar's own tabs) or "back" (a contextual back chevron
// that pops to the OWNING tab, README "back chevron on mobile pops detail
// -> tab"). In "back" mode the resolved generic title (e.g. "Movie") is
// deliberately NOT rendered here — the detail page underneath carries its
// own real title (the item's actual name), and floating a second, generic
// one in the chrome bar above it would be redundant. `state.title` is kept
// on the resolver's return value regardless, for callers/tests that want
// it (e.g. a future document.title wire-up), just not drawn in this mode.
//
// The restricted-lock control and avatar/user-menu are the EXISTING
// components, re-docked here unmodified in logic (RestrictedLockControl,
// UserMenu) — only their own CSS modules gained a 44px mobile touch-target
// bump (see those files). The account SHEET the README's mobile section
// describes ("an avatar that opens the account sheet") does not exist yet
// (bottom-sheet primitive is W1b's parallel lane, sheet contents are W2
// scope) — reusing UserMenu's existing dropdown here is this lane's
// stopgap so the avatar is never a dead tap target; swapping it for the
// real account sheet is a W2 change to this one render branch, not a
// structural rework.
//
// Wave 2 (lane L8): "zone-back" mode (mobile-header.ts) uses
// router.back() rather than a static Link href — see that file's
// MobileHeaderState doc comment for why the zone's "return to whatever tab
// was active" target can't be a fixed pathname the way every other "back"
// case's owning tab is.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { RestrictedLockControl } from "./RestrictedLockControl.js";
import { UserMenu } from "./UserMenu.js";
import { resolveMobileHeader } from "./mobile-header.js";
import styles from "./MobileHeader.module.css";

export interface MobileHeaderProps {
  pathname: string;
  activeLibraryId: string | null;
  moviesLibraryId: string | null;
  tvLibraryId: string | null;
  username: string | null;
}

export function MobileHeader({
  pathname,
  activeLibraryId,
  moviesLibraryId,
  tvLibraryId,
  username,
}: MobileHeaderProps): React.JSX.Element {
  const router = useRouter();
  const state = resolveMobileHeader(pathname, moviesLibraryId, tvLibraryId, activeLibraryId);

  return (
    <header className={styles.header}>
      <div className={styles.topRow}>
        {state.mode === "back" ? (
          <Link href={state.backHref ?? "/home"} className={styles.backButton}>
            <Icon icon={ChevronLeft} strokeWidth={1.55} />
            <span className={styles.backLabel}>{state.backLabel}</span>
          </Link>
        ) : state.mode === "zone-back" ? (
          <button type="button" className={styles.backButton} onClick={() => router.back()}>
            <Icon icon={ChevronLeft} strokeWidth={1.55} />
            <span className={styles.backLabel}>{state.backLabel}</span>
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <div className={styles.topRowControls}>
          <RestrictedLockControl />
          <UserMenu username={username} />
        </div>
      </div>

      {state.mode === "title" && (
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{state.title}</h1>
          {state.subtitle && <span className={styles.subtitle}>{state.subtitle}</span>}
        </div>
      )}
    </header>
  );
}
