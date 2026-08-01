// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/restricted/page.tsx
//
// The restricted zone HOME shell (design/phosphor/README.md "Screens":
// /restricted). STATE.md Stash run (S9/K4): SUPERSEDES the old single-page
// "fetch the whole zone, filter client-side" design (lib/restricted-zone-
// items.ts + lib/restricted-zone-toolbar.ts, retired) with a real IA — this
// route is now the zone's SHELL only: title, nav tiles to Browse/
// Performers/Studios/Search, and a minimal rails placeholder (GET
// /restricted/home lands with this lane; the RAIL UI itself — continue-
// watching/recently-added/studios/performers rendered as real rows — is
// explicitly Lane E's scope per the dispatch brief, "you land the endpoint
// + a placeholder section, not the rail UI").
//
// LOCKED (default): RestrictedGate — UNCHANGED from the prior design (lock
// roundel, item count, separation rule, session-scoped mono line, "Unlock
// with PIN" -> the existing PinModal, rendered app-wide by AppProviders).
// "LOCK NOW" sits in the header on desktop, a dedicated row above the
// content on mobile (README) — both call the same handler (instant relock
// + the exact toast copy) — also UNCHANGED.
//
// Not-entitled viewers are redirected to /home the instant that's known:
// this route renders NOTHING for them, same "the zone does not exist"
// posture every other zone entry point already enforces — also UNCHANGED.

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Lock, Search, Users, Building2, LayoutGrid } from "lucide-react";
import { AppShell } from "../../components/shell/AppShell.js";
import { Icon } from "../../components/icon/Icon.js";
import { RestrictedGate } from "../../components/restricted/RestrictedGate.js";
import { useRestricted } from "../../components/restricted/RestrictedProvider.js";
import { useToast } from "../../components/ui/Toast.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import { apiGet } from "../../lib/api-client.js";
import type { components } from "@loombre/sdk";
import styles from "./page.module.css";

type RestrictedHome = components["schemas"]["RestrictedHome"];

const RELOCK_TOAST = "RESTRICTED ITEMS HIDDEN · PIN TO UNLOCK";

const NAV_TILES = [
  { href: "/restricted/browse", label: "Browse", icon: LayoutGrid, description: "Filter and sort the full zone catalog" },
  { href: "/restricted/performers", label: "Performers", icon: Users, description: "Browse by performer" },
  { href: "/restricted/studios", label: "Studios", icon: Building2, description: "Browse by studio" },
  { href: "/restricted/search", label: "Search", icon: Search, description: "Search titles, performers, studios, tags" },
] as const;

function RestrictedHomeContent(): React.JSX.Element | null {
  const router = useRouter();
  const { state: restrictedState, lock } = useRestricted();
  const { count, loading: countLoading } = useRestrictedZoneCount();
  const entitled = hasRestrictedZoneEntitlement(count);
  const { showToast } = useToast();

  const [home, setHome] = useState<RestrictedHome | null>(null);

  useEffect(() => {
    if (!countLoading && !entitled) {
      router.replace("/home");
    }
  }, [countLoading, entitled, router]);

  // Minimal placeholder wiring only (see module header) — lands the
  // GET /restricted/home round trip so Lane E's rail UI has real data to
  // render against; this page itself only surfaces a one-line summary,
  // never rail rows/cards.
  useEffect(() => {
    if (restrictedState.locked || !entitled) {
      setHome(null);
      return;
    }
    let cancelled = false;
    apiGet("/restricted/home")
      .then((h) => {
        if (!cancelled) setHome(h);
      })
      .catch(() => {
        if (!cancelled) setHome(null);
      });
    return () => {
      cancelled = true;
    };
  }, [restrictedState.locked, restrictedState.unlockedUntilMs, entitled]);

  if (countLoading || !entitled) {
    return null;
  }

  if (restrictedState.locked) {
    return (
      <div className={styles.page}>
        <RestrictedGate itemCount={count} />
      </div>
    );
  }

  function handleLockNow(): void {
    void lock();
    showToast(RELOCK_TOAST, { variant: "warning" });
  }

  return (
    <div className={styles.page} data-unlocked="true">
      <div className={styles.header}>
        <h1 className={styles.title}>Restricted</h1>
        <button type="button" className={styles.lockNowDesktop} onClick={handleLockNow}>
          <Icon icon={Lock} size="dense" />
          Lock now
        </button>
      </div>

      <button type="button" className={styles.lockNowMobile} onClick={handleLockNow}>
        <Icon icon={Lock} size="dense" />
        Lock now
      </button>

      <nav className={styles.navGrid} aria-label="Restricted zone sections">
        {NAV_TILES.map((tile) => (
          <Link key={tile.href} href={tile.href} className={styles.navTile}>
            <span className={styles.navTileIcon} aria-hidden="true">
              <Icon icon={tile.icon} size="default" />
            </span>
            <span className={styles.navTileLabel}>{tile.label}</span>
            <span className={styles.navTileDescription}>{tile.description}</span>
          </Link>
        ))}
      </nav>

      {/* Rails placeholder (module header) — a one-line summary from the
          real GET /restricted/home response, not rail UI. */}
      <div className={styles.railsPlaceholder}>
        {home ? (
          <p className={styles.railsSummary}>
            {home.recentlyAddedInZone.length > 0 && `${home.recentlyAddedInZone.length} recently added`}
            {home.continueWatchingInZone.length > 0 && ` · ${home.continueWatchingInZone.length} in progress`}
            {home.studios.length > 0 && ` · ${home.studios.length} studios`}
            {home.performers.length > 0 && ` · ${home.performers.length} performers`}
          </p>
        ) : (
          <p className={styles.railsSummary}>{count} {count === 1 ? "item" : "items"} in this zone.</p>
        )}
        <p className={styles.railsNote}>Rails coming soon — use Browse to explore the full catalog.</p>
      </div>
    </div>
  );
}

export default function RestrictedPage(): React.JSX.Element {
  return (
    <AppShell>
      <RestrictedHomeContent />
    </AppShell>
  );
}
