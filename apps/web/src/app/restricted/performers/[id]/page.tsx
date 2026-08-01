// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/restricted/performers/[id]/page.tsx
//
// STATE.md Stash run (S9): performer detail — portrait, metadata, and a
// filmography grid, imitating app/people/[id]/page.tsx's structure (see
// that file's header) with the zone's own GET /restricted/performers/{id}
// + GET /restricted/performers/{id}/scenes and amber ZoneBrowseGrid
// instead of the general ChildPosterGrid.

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../../../components/shell/AppShell.js";
import { RestrictedGate } from "../../../../components/restricted/RestrictedGate.js";
import { ZoneBrowseGrid } from "../../../../components/restricted/ZoneBrowseGrid.js";
import { Avatar } from "../../../../components/ui/Card.js";
import { Skeleton } from "../../../../components/skeleton/Skeleton.js";
import { useRestricted } from "../../../../components/restricted/RestrictedProvider.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../../../lib/restricted-zone-count.js";
import { useCursorFeed, type CursorPage } from "../../../../components/browse/useCursorFeed.js";
import { apiGet, LoombreApiError } from "../../../../lib/api-client.js";
import { getAuthStore } from "../../../../lib/auth-store.js";
import styles from "./page.module.css";

type RestrictedPerformer = components["schemas"]["RestrictedPerformer"];
type RestrictedBrowseItem = components["schemas"]["RestrictedBrowseItem"];

const SCENES_PAGE_LIMIT = 60;

async function fetchScenesPage(id: string, cursor: string | null): Promise<CursorPage<RestrictedBrowseItem>> {
  const page = await apiGet("/restricted/performers/{id}/scenes", {
    params: { path: { id }, query: { limit: SCENES_PAGE_LIMIT, ...(cursor ? { cursor } : {}) } },
  });
  return { items: page.items, nextCursor: page.nextCursor };
}

function PerformerContent({ id }: { id: string }): React.JSX.Element | null {
  const router = useRouter();
  const { state: restrictedState } = useRestricted();
  const { count, loading: countLoading } = useRestrictedZoneCount();
  const entitled = hasRestrictedZoneEntitlement(count);

  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [performer, setPerformer] = useState<RestrictedPerformer | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!countLoading && !entitled) router.replace("/home");
  }, [countLoading, entitled, router]);

  useEffect(() => {
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  useEffect(() => {
    if (restrictedState.locked || !entitled) return;
    let cancelled = false;
    apiGet("/restricted/performers/{id}", { params: { path: { id } } })
      .then((p) => {
        if (!cancelled) setPerformer(p);
      })
      .catch((err: unknown) => {
        if (!cancelled && err instanceof LoombreApiError && err.status === 404) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, restrictedState.locked, entitled]);

  const resetKey = performer ? id : null;
  const { items, hasMore, loading, loadingMore, loadMoreError, loadMore } = useCursorFeed<RestrictedBrowseItem>(
    (cursor) => fetchScenesPage(id, cursor),
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

  if (notFound) {
    return <div className={styles.notFound}>Performer not found.</div>;
  }

  if (!performer || accessToken === null) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <Skeleton radius="full" width={140} height={140} />
          <Skeleton radius="sm" height={24} width={220} />
        </div>
        <Skeleton radius="md" height={200} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Avatar label={performer.name} size={140} />
        <h1 className={styles.name}>{performer.name}</h1>
        <p className={styles.meta}>
          {performer.sceneCount} {performer.sceneCount === 1 ? "scene" : "scenes"}
        </p>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Filmography</h2>
        <ZoneBrowseGrid
          items={items}
          hasMore={hasMore}
          loading={loading}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          onLoadMore={loadMore}
          density="wall"
          serverUrl={serverUrl}
          accessToken={accessToken}
          ariaLabel={`${performer.name}'s scenes`}
          emptyMessage="No visible scenes found."
        />
      </section>
    </div>
  );
}

export default function RestrictedPerformerPage({ params }: { params: Promise<{ id: string }> }): React.JSX.Element {
  const { id } = use(params);
  return (
    <AppShell>
      <PerformerContent id={id} />
    </AppShell>
  );
}
