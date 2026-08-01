// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/restricted/studios/page.tsx
//
// STATE.md Stash run (S9/K2/S6): the zone's studio index — GET
// /restricted/studios (q, cursor), keyset-paginated. Studios are
// kind=studio tags (S6); logo comes straight off each row's own
// `images` (entity_type='tag') — no per-row image fetch needed.

import { useEffect, useState } from "react";
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

type RestrictedStudio = components["schemas"]["RestrictedStudio"];

const PAGE_LIMIT = 100;

async function fetchStudiosPage(q: string, cursor: string | null): Promise<CursorPage<RestrictedStudio>> {
  const page = await apiGet("/restricted/studios", {
    params: { query: { limit: PAGE_LIMIT, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) } },
  });
  return { items: page.items, nextCursor: page.nextCursor };
}

function StudioLogo({ studio, serverUrl, accessToken }: { studio: RestrictedStudio; serverUrl: string; accessToken: string }): React.JSX.Element {
  const logo = studio.images.find((img) => img.kind === "logo");
  if (!logo) return <Avatar label={studio.name} size={96} />;
  const src = buildImageUrl({ serverUrl, accessToken, entityType: "tag", entityId: studio.id, kind: "logo", width: 192 });
  return <img className={styles.logo} src={src} alt="" width={96} height={96} loading="lazy" />;
}

function StudiosContent(): React.JSX.Element | null {
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
  const { items, hasMore, loading, loadingMore, loadMore } = useCursorFeed<RestrictedStudio>(
    (cursor) => fetchStudiosPage(q, cursor),
    resetKey,
  );

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
      <h1 className={styles.title}>Studios</h1>
      <input
        type="search"
        className={styles.search}
        placeholder="Search studios…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {loading || accessToken === null ? (
        <div className={styles.grid}>
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} radius="md" width={96} height={96} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>No studios found.</div>
      ) : (
        <>
          <div className={styles.grid}>
            {items.map((s) => (
              <Link key={s.id} href={`/restricted/studios/${s.id}`} className={styles.card}>
                <StudioLogo studio={s} serverUrl={serverUrl} accessToken={accessToken} />
                <span className={styles.name}>{s.name}</span>
                <span className={styles.count}>
                  {s.sceneCount} {s.sceneCount === 1 ? "scene" : "scenes"}
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

export default function RestrictedStudiosPage(): React.JSX.Element {
  return (
    <AppShell>
      <StudiosContent />
    </AppShell>
  );
}
