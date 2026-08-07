// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/ShellNav.tsx
//
// Wave 1 (W1a) responsive breakpoint: the single client subtree that reads
// pathname/searchParams and the library-shortcut ids ONCE and renders
// every viewport's chrome from that one state — Sidebar (desktop/tablet),
// MobileHeader + MobileTabBar (phone). This is what AppShell wraps in a
// Suspense boundary (useSearchParams requirement); all three children
// below are always in the DOM (U2: one component tree), CSS decides which
// are visible at the current viewport width, never this component.
//
// Extracted out of AppShell.tsx itself (rather than growing that file)
// because useSearchParams forces a Suspense boundary — AppShell also
// renders the desktop Topbar, which needs no such boundary, so keeping
// Topbar outside this component avoids suspending chrome that doesn't
// need to be.

import { usePathname, useSearchParams } from "next/navigation";
import { Sidebar } from "./Sidebar.js";
import { MobileHeader } from "./MobileHeader.js";
import { MobileTabBar } from "./MobileTabBar.js";
import { useLibraryShortcuts } from "./useLibraryShortcuts.js";
import type { TabActiveContext } from "./tab-items.js";

export interface ShellNavProps {
  isAdmin: boolean;
  displayName: string | null;
  username: string | null;
  onSignOut: () => void;
}

export function ShellNav({ isAdmin, displayName, username, onSignOut }: ShellNavProps): React.JSX.Element {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const activeLibraryId = searchParams.get("library");
  const { libraries, moviesLibraryId, tvLibraryId } = useLibraryShortcuts();

  // Library.itemCount (W1c additive field) for the two shortcut entries —
  // computed here so Sidebar needs no fetch of its own (only the sidebar
  // shows counts; the tab bar and mobile header don't, per the prototype).
  const moviesItemCount = libraries?.find((l) => l.id === moviesLibraryId)?.itemCount ?? null;
  const tvItemCount = libraries?.find((l) => l.id === tvLibraryId)?.itemCount ?? null;

  // Restricted-zone overlay flag (README "exactly one tab lit at a time"):
  // Wave 2 (lane L8) wires the real signal. /restricted is a genuine route
  // (not a client-side-only overlay layered on top of another page — U2
  // means one responsive component tree, not a fake modal hack), so "the
  // zone is open" is exactly "the current route IS /restricted": every
  // OTHER tab's own isActive already ANDs against !zoneOverlayOpen (see
  // tab-items.ts), and the Restricted tab's own isActive is the mirror
  // (lit only while this is true) — together that gives "exactly one tab
  // lit at a time" for free from ordinary route state, no separate overlay
  // bookkeeping needed. Tapping any other tab navigates away from
  // /restricted, which "dismisses the overlay" by construction.
  const zoneOverlayOpen = pathname.startsWith("/restricted");

  const tabCtx: TabActiveContext = {
    pathname,
    activeLibraryId,
    moviesLibraryId,
    tvLibraryId,
    zoneOverlayOpen,
  };

  return (
    <>
      <Sidebar
        isAdmin={isAdmin}
        displayName={displayName}
        username={username}
        onSignOut={onSignOut}
        moviesLibraryId={moviesLibraryId}
        tvLibraryId={tvLibraryId}
        moviesItemCount={moviesItemCount}
        tvItemCount={tvItemCount}
      />
      <MobileHeader
        pathname={pathname}
        activeLibraryId={activeLibraryId}
        moviesLibraryId={moviesLibraryId}
        tvLibraryId={tvLibraryId}
        username={username}
      />
      <MobileTabBar ctx={tabCtx} moviesLibraryId={moviesLibraryId} tvLibraryId={tvLibraryId} isAdmin={isAdmin} />
    </>
  );
}
