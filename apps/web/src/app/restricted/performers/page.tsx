// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/restricted/performers/page.tsx
//
// STATE.md Stash run (S9): the zone's performer index — GET
// /restricted/performers (q, cursor), keyset-paginated. Gate/entitlement
// posture identical to every other zone route (see app/restricted/
// browse/page.tsx's header). FX2 fix wave: portrait comes straight off
// each row's own `images` (entity_type='person', kind='thumb') — same
// "no per-row image fetch needed" shape studios/page.tsx's StudioLogo
// already establishes for logos.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "../../../components/shell/AppShell.js";
import { RestrictedGate } from "../../../components/restricted/RestrictedGate.js";
import { Avatar } from "../../../components/ui/Card.js";
import { Skeleton } from "../../../components/skeleton/Skeleton.js";
import { useRestricted } from "../../../components/restricted/RestrictedProvider.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../../lib/restricted-zone-count.js";
import { useCursorFeed, type CursorPage } from "../../../components/browse/useCursorFeed.js";
import { apiGet } from "../../../lib/api-client.js";
import { buildImageUrl } from "../../../lib/image-url.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import type { components } from "@loombre/sdk";
import styles from "./page.module.css";

type RestrictedPerformer = components["schemas"]["RestrictedPerformer"];

const PAGE_LIMIT = 100;

async function fetchPerformersPage(q: string, cursor: string | null): Promise<CursorPage<RestrictedPerformer>> {
  const page = await apiGet("/restricted/performers", {
    params: { query: { limit: PAGE_LIMIT, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) } },
  });
  return { items: page.items, nextCursor: page.nextCursor };
}

function PerformerPortrait({
  performer,
  serverUrl,
  accessToken,
}: {
  performer: RestrictedPerformer;
  serverUrl: string;
  accessToken: string;
}): React.JSX.Element {
  const portrait = performer.images.find((img) => img.kind === "thumb");
  if (!portrait) return <Avatar label={performer.name} size={96} />;
  const src = buildImageUrl({ serverUrl, accessToken, entityType: "person", entityId: performer.id, kind: "thumb", width: 192 });
  return <img className={styles.portrait} src={src} alt="" width={96} height={96} loading="lazy" />;
}

function PerformersContent(): React.JSX.Element | null {
  const router = useRouter();
  const { state: restrictedState } = useRestricted();
  const { count, loading: countLoading } = useRestrictedZoneCount();
  const entitled = hasRestrictedZoneEntitlement(count);
  const [q, setQ] = useState("");
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    if (!countLoading && !entitled) router.replace("/home");
  }, [countLoading, entitled, router]);

  useEffect(() => {
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  const resetKey = restrictedState.locked ? null : q;
  const { items, hasMore, loading, loadingMore, loadMore } = useCursorFeed<RestrictedPerformer>(
    (cursor) => fetchPerformersPage(q, cursor),
    resetKey,
  );

  const sorted = useMemo(() => items, [items]);

  if (countLoading || !entitled) return null;

  if (restrictedState.locked) {
    return (
      <div className={styles.page}>
        <RestrictedGate itemCount={count} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Performers</h1>
      <input
        type="search"
        className={styles.search}
        placeholder="Search performers…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {loading || accessToken === null ? (
        <div className={styles.grid}>
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} radius="full" width={96} height={96} />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className={styles.empty}>No performers found.</div>
      ) : (
        <>
          <div className={styles.grid}>
            {sorted.map((p) => (
              <Link key={p.id} href={`/restricted/performers/${p.id}`} className={styles.card}>
                <PerformerPortrait performer={p} serverUrl={serverUrl} accessToken={accessToken} />
                <span className={styles.name}>{p.name}</span>
                <span className={styles.count}>
                  {p.sceneCount} {p.sceneCount === 1 ? "scene" : "scenes"}
                </span>
              </Link>
            ))}
          </div>
          {hasMore && (
            <button type="button" className={styles.loadMore} onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function RestrictedPerformersPage(): React.JSX.Element {
  return (
    <AppShell>
      <PerformersContent />
    </AppShell>
  );
}
