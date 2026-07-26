// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/restricted/page.tsx
//
// The restricted zone route (design/phosphor/README.md "Screens": /restricted
// is NEW; "Interactions -> Restricted content"). STATE.md Phosphor retheme,
// Wave 2 lane L8.
//
// LOCKED (default): RestrictedGate — lock roundel, item count, separation
// rule, session-scoped mono line, "Unlock with PIN" -> the existing
// PinModal (rendered app-wide by AppProviders; this page never renders its
// own PIN UI). UNLOCKED: amber-accented grid + the zone's own toolbar
// (search/genre/quality/sort, all client-side over the full, already-
// guarded zone listing — see lib/restricted-zone-items.ts /
// lib/restricted-zone-toolbar.ts headers for why there is no zone-search
// HTTP call at all). "LOCK NOW" sits in the header on desktop, a
// dedicated row above the grid on mobile (README) — both call the same
// handler (instant relock + the exact toast copy).
//
// Not-entitled viewers (restricted-profile users, docs/PLAN.md §6.4 gates
// 1-4 never all passing — GET /restricted/count 404s) are redirected to
// /home the instant that's known: this route renders NOTHING for them,
// same "the zone does not exist" posture every other zone entry point
// (sidebar, Browse chip, mobile tab, account menu) already enforces by
// simply not rendering an entry point at all.

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { AppShell } from "../../components/shell/AppShell.js";
import { Icon } from "../../components/icon/Icon.js";
import { Skeleton } from "../../components/skeleton/Skeleton.js";
import { RestrictedGate } from "../../components/restricted/RestrictedGate.js";
import { RestrictedZoneToolbar } from "../../components/restricted/RestrictedZoneToolbar.js";
import { RestrictedZoneEmptyState } from "../../components/restricted/RestrictedZoneEmptyState.js";
import { ZonePosterCard } from "../../components/restricted/ZonePosterCard.js";
import { useRestricted } from "../../components/restricted/RestrictedProvider.js";
import { useToast } from "../../components/ui/Toast.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import { useRestrictedZoneItems } from "../../lib/restricted-zone-items.js";
import {
  INITIAL_ZONE_TOOLBAR_STATE,
  clearZoneFilters,
  deriveZoneGenres,
  filterAndSortZoneItems,
  type ZoneToolbarState,
} from "../../lib/restricted-zone-toolbar.js";
import { getAuthStore } from "../../lib/auth-store.js";
import styles from "./page.module.css";

const RELOCK_TOAST = "RESTRICTED ITEMS HIDDEN · PIN TO UNLOCK";

function RestrictedZoneContent(): React.JSX.Element | null {
  const router = useRouter();
  const { state: restrictedState, lock } = useRestricted();
  const { count, loading: countLoading } = useRestrictedZoneCount();
  const entitled = hasRestrictedZoneEntitlement(count);
  const { showToast } = useToast();

  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  useEffect(() => {
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  // Refetches whenever lock state changes (lock -> null, unlock -> a real
  // timestamp) — an entitled-but-locked fetch legitimately gets an empty
  // page (packages/db/src/query/restricted-zone.ts's own header), so this
  // is what turns "you just unlocked" into real content on screen without
  // a route reload.
  const { items, loading: itemsLoading } = useRestrictedZoneItems(restrictedState.unlockedUntilMs);

  const [toolbarState, setToolbarState] = useState<ZoneToolbarState>(INITIAL_ZONE_TOOLBAR_STATE);

  useEffect(() => {
    if (!countLoading && !entitled) {
      router.replace("/home");
    }
  }, [countLoading, entitled, router]);

  const genres = useMemo(() => deriveZoneGenres(items ?? []), [items]);
  const filtered = useMemo(() => (items ? filterAndSortZoneItems(items, toolbarState) : []), [items, toolbarState]);

  if (countLoading || !entitled) {
    // Either still resolving entitlement, or the redirect effect above is
    // about to fire — render nothing rather than a flash of the gate.
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

      <RestrictedZoneToolbar
        state={toolbarState}
        onChange={setToolbarState}
        genres={genres}
        filteredCount={filtered.length}
        totalCount={items?.length ?? count ?? 0}
      />

      {itemsLoading && items === null ? (
        <div className={styles.grid}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} radius="md" height={240} />
          ))}
        </div>
      ) : items && items.length === 0 ? (
        <div className={styles.emptyZone}>This zone has no items yet.</div>
      ) : filtered.length === 0 ? (
        <RestrictedZoneEmptyState onClear={() => setToolbarState((prev) => clearZoneFilters(prev))} />
      ) : (
        <div className={styles.grid}>
          {filtered.map((item) => (
            <ZonePosterCard
              key={item.id}
              serverUrl={serverUrl}
              accessToken={accessToken ?? ""}
              itemId={item.id}
              itemType={item.itemType}
              title={item.title}
              subtitle={item.year ? String(item.year) : undefined}
              blurhash={item.images.find((img) => img.kind === "poster")?.blurhash ?? null}
              href={`/items/${item.itemType}/${item.id}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function RestrictedPage(): React.JSX.Element {
  return (
    <AppShell>
      <RestrictedZoneContent />
    </AppShell>
  );
}
