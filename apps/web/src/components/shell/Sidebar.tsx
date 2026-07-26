// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/Sidebar.tsx
//
// Phosphor labelled 210px sidebar (Wave 0, README "Suggested implementation
// order" step 2) — replaces the former icon-only NavRail. See nav-items.ts
// for the LIBRARY/SYSTEM group config and the Movies/TV-shortcut ground
// truth; see AppShell.tsx for why this needs its own Suspense boundary
// (useSearchParams — same pattern app/browse/page.tsx already uses).
//
// Library counts + storage-pool meter: WIRED (Wave 1c, "contract enablers"
// lane — the Wave-0 header above logged both as deferred pending a
// contract+db change; that lane has now landed). Movies/TV Shows counts are
// Library.itemCount (additive) off useLibraryShortcuts' single GET
// /libraries fetch, threaded here as props by ShellNav (reconciled with
// W1a's extraction at Wave-1 landing) — no second request. The
// POOL meter is a separate admin-only fetch (GET /system/info's additive
// `storagePool`, packages/db's computeStoragePool via useStoragePool()) and
// hides gracefully (renders nothing) for non-admins, on any fetch error, or
// when the server itself reports null (no libraries yet / every filesystem
// probe failed) — never fabricated numbers (U9).
//
// SCAN badge: wired. scan.started/scan.completed are real, already-typed
// events on the shared getEventsSocket() connection every authenticated
// session already holds open (AppProviders' EventsSocketLifecycle) — cheap
// to subscribe to, so per the run law this is wired rather than deferred.
// It renders on the "Dashboard" nav item (admin-only group) as a small
// amber SCAN pill while at least one scan job is active, tracked by jobId
// so overlapping scans across libraries don't clear the badge early.
//
// Movies/TV Shows shortcut ids: Wave 1 (W1a) lifted the GET /libraries
// fetch + resolution out to useLibraryShortcuts.ts, called once by
// ShellNav.tsx and threaded down as props — the mobile tab bar and mobile
// header need the same two ids, and three components each doing their own
// fetch would triple the request for no reason. See that hook's header.
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "../icon/Icon.js";
import { Avatar } from "../ui/Card.js";
import { BlazeMark } from "../brand/BlazeMark.js";
import { getEventsSocket, type EventEnvelope } from "../../lib/events-socket.js";
import { APP_VERSION } from "../../lib/app-version.js";
import { formatStoragePoolMeter, useStoragePool } from "../../lib/storage-pool.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import { useRestricted } from "../restricted/RestrictedProvider.js";
import { useWatchlistIds } from "../../lib/watchlist-sync.js";
import { LIBRARY_NAV_ITEMS, SYSTEM_NAV_ITEMS, resolveShortcutHref, type NavActiveContext } from "./nav-items.js";
import styles from "./Sidebar.module.css";

/** Wave 2 (lane L8): sidebar Restricted LIBRARY entry (design/phosphor
 *  README shell spec: "Restricted + PIN badge/count"). Rendered separately
 *  from LIBRARY_NAV_ITEMS' generic .map (rather than pushed into that
 *  array — nav-items.ts's own header invited that shape, but the badge
 *  here is conditionally a PIN glyph OR a count, never a bare number like
 *  every other item's .navCount, so this needed its own small branch
 *  rather than nav-items.ts's isActive/count-only predicate shape) —
 *  entirely hidden (both the entry AND any PIN affordance) for a viewer
 *  with no restricted-library entitlement at all: hasRestrictedZoneEntitlement
 *  is the SAME predicate every other zone entry point (Browse chip, mobile
 *  tab, UserMenu row) gates on, so a restricted-profile viewer sees this
 *  nowhere, consistently. */
function RestrictedNavEntry({ pathname }: { pathname: string }): React.JSX.Element | null {
  const { count } = useRestrictedZoneCount();
  const { state } = useRestricted();

  if (!hasRestrictedZoneEntitlement(count)) return null;

  return (
    <Link href="/restricted" className={styles.navItem} data-active={pathname.startsWith("/restricted")}>
      <Icon icon="lock" size="dense" className={styles.navIcon ?? ""} />
      <span className={styles.navLabel}>Restricted</span>
      {state.locked ? <span className={styles.pinBadge}>PIN</span> : <span className={styles.navCount}>{count}</span>}
    </Link>
  );
}

export interface SidebarProps {
  isAdmin: boolean;
  displayName: string | null;
  username: string | null;
  onSignOut: () => void;
  moviesLibraryId: string | null;
  tvLibraryId: string | null;
  /** Library.itemCount for the two shortcut libraries (W1c additive field),
   *  threaded from useLibraryShortcuts' single fetch via ShellNav — null
   *  while unresolved or when the library doesn't exist. */
  moviesItemCount: number | null;
  tvItemCount: number | null;
}

interface ScanJobPayload {
  jobId: string;
}

function useScanBadge(isAdmin: boolean): boolean {
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    const socket = getEventsSocket();
    const active = new Set<string>();

    const unsubStarted = socket.subscribe<ScanJobPayload>("scan.started", (e: EventEnvelope<ScanJobPayload>) => {
      active.add(e.payload.jobId);
      setScanning(active.size > 0);
    });
    const unsubCompleted = socket.subscribe<ScanJobPayload>("scan.completed", (e: EventEnvelope<ScanJobPayload>) => {
      active.delete(e.payload.jobId);
      setScanning(active.size > 0);
    });

    return () => {
      unsubStarted();
      unsubCompleted();
    };
  }, [isAdmin]);

  return scanning;
}

export function Sidebar({
  isAdmin,
  displayName,
  username,
  onSignOut,
  moviesLibraryId,
  tvLibraryId,
  moviesItemCount,
  tvItemCount,
}: SidebarProps): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeLibraryId = searchParams.get("library");
  const scanning = useScanBadge(isAdmin);
  const pool = useStoragePool(isAdmin);
  // Watchlist count (Wave 2 lane L3) — DERIVED from the same bounded
  // GET /watchlist page useWatchlistIds() fetches for every consumer (no
  // dedicated aggregate-count endpoint exists, unlike Movies/TV's
  // Library.itemCount or Restricted's GET /restricted/count — see that
  // hook's header). Sidebar remounts this fetch on every route (same
  // posture as the SCAN badge/pool meter above), not a persisted count.
  const watchlist = useWatchlistIds();

  const ctx: NavActiveContext = {
    pathname: pathname ?? "",
    activeLibraryId,
    moviesLibraryId,
    tvLibraryId,
  };

  const libraryItems = LIBRARY_NAV_ITEMS.filter((item) => {
    if (item.key === "movies") return moviesLibraryId !== null;
    if (item.key === "tv") return tvLibraryId !== null;
    return true;
  });

  // README shell spec order: "Home, Browse, Movies + count, TV Shows +
  // count, Watchlist + count, Restricted + PIN badge/count, Search" — the
  // Restricted entry (L8) slots in right before Search; Watchlist (L3) is
  // an ordinary nav-items entry with a threaded count. Splitting the array
  // here keeps nav-items' generic count-only item shape untouched
  // (RestrictedNavEntry's badge is conditionally a PIN glyph, not always a
  // count — see its own header).
  const splitIndex = libraryItems.findIndex((item) => item.key === "search");
  const beforeRestricted = splitIndex === -1 ? libraryItems : libraryItems.slice(0, splitIndex);
  const fromSearch = splitIndex === -1 ? [] : libraryItems.slice(splitIndex);

  /** Movies/TV Shows/Watchlist counts — threaded as props from the single
   *  useLibraryShortcuts fetch (W1a extraction) for the first two, derived
   *  from useWatchlistIds() for the third; every other nav item has none.
   *  Watchlist renders nothing while loading and "N+" once the bounded
   *  fetch is at capacity (see useWatchlistIds' `atCapacity`) rather than
   *  ever showing a number known to undercount. */
  const navItemCount = (key: string): number | string | null => {
    if (key === "movies") return moviesItemCount;
    if (key === "tv") return tvItemCount;
    if (key === "watchlist") {
      if (watchlist.loading) return null;
      return watchlist.atCapacity ? `${watchlist.ids.size}+` : watchlist.ids.size;
    }
    return null;
  };

  const poolMeter = pool ? formatStoragePoolMeter(pool) : null;

  const name = displayName ?? username ?? "Signed in";
  const roleLabel = isAdmin ? "ADMIN" : "MEMBER";

  return (
    <nav className={styles.sidebar} aria-label="Primary">
      <div className={styles.wordmarkRow}>
        <div className={styles.wordmarkLine}>
          <BlazeMark variant="flat" size={18} />
          <span className={styles.wordmark}>LOOMBRE</span>
        </div>
        <span className={styles.tagline}>MEDIA SERVER · V{APP_VERSION}</span>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Library</span>
        {beforeRestricted.map((item) => {
          const count = navItemCount(item.key);
          return (
            <Link
              key={item.key}
              href={resolveShortcutHref(item, moviesLibraryId, tvLibraryId)}
              className={styles.navItem}
              data-active={item.isActive(ctx)}
            >
              <Icon icon={item.icon} size="dense" strokeWidth={1.55} className={styles.navIcon ?? ""} />
              <span className={styles.navLabel}>{item.label}</span>
              {count !== null && <span className={styles.navCount}>{count}</span>}
            </Link>
          );
        })}
        <RestrictedNavEntry pathname={ctx.pathname} />
        {fromSearch.map((item) => {
          const count = navItemCount(item.key);
          return (
            <Link
              key={item.key}
              href={resolveShortcutHref(item, moviesLibraryId, tvLibraryId)}
              className={styles.navItem}
              data-active={item.isActive(ctx)}
            >
              <Icon icon={item.icon} size="nav" className={styles.navIcon ?? ""} />
              <span className={styles.navLabel}>{item.label}</span>
              {count !== null && <span className={styles.navCount}>{count}</span>}
            </Link>
          );
        })}
      </div>

      {isAdmin && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>System</span>
          {SYSTEM_NAV_ITEMS.map((item) => (
            <Link key={item.key} href={item.href} className={styles.navItem} data-active={item.isActive(ctx)}>
              <Icon icon={item.icon} size="nav" className={styles.navIcon ?? ""} />
              <span className={styles.navLabel}>{item.label}</span>
              {item.key === "dashboard" && scanning && (
                <span className={styles.scanBadge}>
                  <span className={styles.scanBadgeDot} aria-hidden="true" />
                  Scan
                </span>
              )}
            </Link>
          ))}
        </div>
      )}

      {isAdmin && poolMeter && (
        <div className={styles.poolMeter}>
          <div className={styles.poolLabelRow}>
            <span className={styles.poolLabel}>Pool</span>
            <span className={styles.poolValue}>
              {poolMeter.usedLabel} / {poolMeter.totalLabel} {poolMeter.unit}
            </span>
          </div>
          <div className={styles.poolBarTrack}>
            <div className={styles.poolBarFill} style={{ width: `${poolMeter.percent}%` }} />
          </div>
        </div>
      )}

      <div className={styles.spacer} />

      <div className={styles.userRow}>
        <Avatar label={name} size={32} />
        <div className={styles.userInfo}>
          <span className={styles.userName}>{name}</span>
          <span className={styles.userMeta}>
            <span>{roleLabel}</span>
            <span aria-hidden="true">·</span>
            <button type="button" className={styles.signOut} onClick={onSignOut}>
              Sign out
            </button>
          </span>
        </div>
      </div>
    </nav>
  );
}
