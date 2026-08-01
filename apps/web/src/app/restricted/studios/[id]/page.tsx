// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/restricted/studios/[id]/page.tsx
//
// STATE.md Stash run (S9/K2): studio detail — logo + catalog. The catalog
// is GET /restricted/browse?studioTagIds={id} (per the contract's own doc
// comment on GET /restricted/studios/{id}: "Catalog ... is reached via GET
// /restricted/browse's studioTagIds filter, not a dedicated sub-route") —
// this page is the one caller that filter exists for outside
// app/restricted/browse/page.tsx itself.

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../../../components/shell/AppShell.js";
import { RestrictedGate } from "../../../../components/restricted/RestrictedGate.js";
import { ZoneBrowseGrid } from "../../../../components/restricted/ZoneBrowseGrid.js";
import { Skeleton } from "../../../../components/skeleton/Skeleton.js";
import { useRestricted } from "../../../../components/restricted/RestrictedProvider.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../../../lib/restricted-zone-count.js";
import { useCursorFeed, type CursorPage } from "../../../../components/browse/useCursorFeed.js";
import { apiGet, LoombreApiError } from "../../../../lib/api-client.js";
import { buildImageUrl } from "../../../../lib/image-url.js";
import { getAuthStore } from "../../../../lib/auth-store.js";
import styles from "./page.module.css";

type RestrictedStudio = components["schemas"]["RestrictedStudio"];
type RestrictedBrowseItem = components["schemas"]["RestrictedBrowseItem"];

const CATALOG_PAGE_LIMIT = 60;

async function fetchCatalogPage(studioId: string, cursor: string | null): Promise<CursorPage<RestrictedBrowseItem>> {
  const page = await apiGet("/restricted/browse", {
    params: { query: { studioTagIds: studioId, limit: CATALOG_PAGE_LIMIT, ...(cursor ? { cursor } : {}) } },
  });
  return { items: page.items, nextCursor: page.nextCursor };
}

function StudioContent({ id }: { id: string }): React.JSX.Element | null {
  const router = useRouter();
  const { state: restrictedState } = useRestricted();
  const { count, loading: countLoading } = useRestrictedZoneCount();
  const entitled = hasRestrictedZoneEntitlement(count);

  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [studio, setStudio] = useState<RestrictedStudio | null>(null);
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
    apiGet("/restricted/studios/{id}", { params: { path: { id } } })
      .then((s) => {
        if (!cancelled) setStudio(s);
      })
      .catch((err: unknown) => {
        if (!cancelled && err instanceof LoombreApiError && err.status === 404) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, restrictedState.locked, entitled]);

  const resetKey = studio ? id : null;
  const { items, hasMore, loading, loadingMore, loadMoreError, loadMore } = useCursorFeed<RestrictedBrowseItem>(
    (cursor) => fetchCatalogPage(id, cursor),
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
    return <div className={styles.notFound}>Studio not found.</div>;
  }

  if (!studio || accessToken === null) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <Skeleton radius="md" width={140} height={140} />
          <Skeleton radius="sm" height={24} width={220} />
        </div>
        <Skeleton radius="md" height={200} />
      </div>
    );
  }

  const logo = studio.images.find((img) => img.kind === "logo");
  const logoSrc = logo ? buildImageUrl({ serverUrl, accessToken, entityType: "tag", entityId: studio.id, kind: "logo", width: 320 }) : null;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        {logoSrc ? (
          <img className={styles.logo} src={logoSrc} alt="" />
        ) : (
          <div className={styles.logoFallback} aria-hidden="true">
            {studio.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <h1 className={styles.name}>{studio.name}</h1>
        <p className={styles.meta}>
          {studio.sceneCount} {studio.sceneCount === 1 ? "scene" : "scenes"}
        </p>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Catalog</h2>
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
          ariaLabel={`${studio.name}'s catalog`}
          emptyMessage="No visible scenes found."
        />
      </section>
    </div>
  );
}

export default function RestrictedStudioPage({ params }: { params: Promise<{ id: string }> }): React.JSX.Element {
  const { id } = use(params);
  return (
    <AppShell>
      <StudioContent id={id} />
    </AppShell>
  );
}
