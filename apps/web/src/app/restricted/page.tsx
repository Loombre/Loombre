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
//
// Lane E landing (S9 rail UI): the placeholder one-line summary is
// replaced by the REAL rails — continueWatchingInZone/recentlyAddedInZone
// as ZonePosterCard rows (imitating app/home/HomeContent.tsx's Row +
// PosterCard shape, amber identity per ZonePosterCard.tsx), studios/
// performers as their own rail tiles (ZoneStudioTile/ZonePerformerTile)
// linking to Lane D's /restricted/studios/{id} + /restricted/performers/{id}
// pages. Entitlement predicates, RestrictedGate, and the lock/unlock flow
// above are untouched.

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Lock, Search, Users, Building2, LayoutGrid } from "lucide-react";
import { AppShell } from "../../components/shell/AppShell.js";
import { Icon } from "../../components/icon/Icon.js";
import { RestrictedGate } from "../../components/restricted/RestrictedGate.js";
import { ZonePosterCard } from "../../components/restricted/ZonePosterCard.js";
import { ZoneStudioTile } from "../../components/restricted/ZoneStudioTile.js";
import { ZonePerformerTile } from "../../components/restricted/ZonePerformerTile.js";
import { Row } from "../../components/home/Row.js";
import { useRestricted } from "../../components/restricted/RestrictedProvider.js";
import { useToast } from "../../components/ui/Toast.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import { apiGet } from "../../lib/api-client.js";
import { getAuthStore } from "../../lib/auth-store.js";
import type { components } from "@loombre/sdk";
import styles from "./page.module.css";

type RestrictedHome = components["schemas"]["RestrictedHome"];

/** Elapsed-position readout for a continue-watching card's subtitle — same
 *  shape as app/home/HomeContent.tsx's own (module-private) formatElapsed;
 *  small enough that duplicating it here (rather than exporting/importing
 *  across route trees) matches this codebase's existing per-file-formatter
 *  convention (see ZonePosterCard.tsx's header for the identical stance). */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

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
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    if (!countLoading && !entitled) {
      router.replace("/home");
    }
  }, [countLoading, entitled, router]);

  useEffect(() => {
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  // Lands the real GET /restricted/home round trip the rails below render.
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

      {home === null || accessToken === null ? (
        <p className={styles.railsSummary}>{count} {count === 1 ? "item" : "items"} in this zone.</p>
      ) : (
        <div className={styles.rails}>
          <Row heading="Continue Watching" empty="Nothing in progress in this zone.">
            {home.continueWatchingInZone.map((entry) => (
              <ZonePosterCard
                key={entry.item.id}
                serverUrl={serverUrl}
                accessToken={accessToken}
                itemId={entry.item.id}
                itemType={entry.item.itemType}
                title={entry.item.title}
                subtitle={formatElapsed(entry.progress.positionMs)}
                blurhash={entry.item.images.find((img) => img.kind === "poster")?.blurhash ?? null}
                href={`/restricted/scenes/${entry.item.id}`}
                aspectRatio="16/9"
                progressPercent={entry.progress.durationMs ? (entry.progress.positionMs / entry.progress.durationMs) * 100 : 0}
                playHref={`/watch/${entry.item.id}`}
              />
            ))}
          </Row>

          {/* RZI-D2a: the ONLY surface a watchlisted restricted title
              renders on — the general /watchlist list refuses them
              unconditionally (guard-enforced surface scoping). */}
          <Row heading="Watchlist" empty="Nothing watchlisted in this zone.">
            {home.watchlistInZone.map((entry) => (
              <ZonePosterCard
                key={entry.item.id}
                serverUrl={serverUrl}
                accessToken={accessToken}
                itemId={entry.item.id}
                itemType={entry.item.itemType}
                title={entry.item.title}
                subtitle={entry.item.year ? String(entry.item.year) : undefined}
                blurhash={entry.item.images.find((img) => img.kind === "poster")?.blurhash ?? null}
                href={`/restricted/scenes/${entry.item.id}`}
              />
            ))}
          </Row>

          <Row
            heading="Recently Added"
            action={{ label: "ALL →", href: "/restricted/browse" }}
            empty="Nothing added to this zone yet."
          >
            {home.recentlyAddedInZone.map((item) => (
              <ZonePosterCard
                key={item.id}
                serverUrl={serverUrl}
                accessToken={accessToken}
                itemId={item.id}
                itemType={item.itemType}
                title={item.title}
                subtitle={item.year ? String(item.year) : undefined}
                blurhash={item.images.find((img) => img.kind === "poster")?.blurhash ?? null}
                href={`/restricted/scenes/${item.id}`}
              />
            ))}
          </Row>

          <Row
            heading="Studios"
            action={{ label: "ALL →", href: "/restricted/studios" }}
            empty="No studios in this zone yet."
          >
            {home.studios.map((studio) => (
              <ZoneStudioTile
                key={studio.id}
                serverUrl={serverUrl}
                accessToken={accessToken}
                studioId={studio.id}
                name={studio.name}
                sceneCount={studio.sceneCount}
                hasLogo={studio.images.some((img) => img.kind === "logo")}
                href={`/restricted/studios/${studio.id}`}
              />
            ))}
          </Row>

          <Row
            heading="Performers"
            action={{ label: "ALL →", href: "/restricted/performers" }}
            empty="No performers in this zone yet."
          >
            {home.performers.map((performer) => (
              <ZonePerformerTile
                key={performer.id}
                serverUrl={serverUrl}
                accessToken={accessToken}
                performerId={performer.id}
                name={performer.name}
                sceneCount={performer.sceneCount}
                hasPortrait={performer.images.some((img) => img.kind === "thumb")}
                href={`/restricted/performers/${performer.id}`}
              />
            ))}
          </Row>
        </div>
      )}
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
