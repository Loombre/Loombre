// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/people/[id]/page.tsx
//
// /people/[id] (Phosphor Wave 2 lane L3, README route table "NEW" — README
// "Navigation": "Cast opens Person"). Portrait, name, filmography grid, one
// responsive tree (U2) — the grid reflows via CSS at the mobile breakpoint,
// no separate mobile branch.
//
// Ground truth (this lane): GET /people/{id} already existed (P1.17) but
// only ever returned {id, name, contentClass, creditCount} — no actual
// items. Filmography is this lane's gap-closure: GET /people/{id}/items
// (packages/db/src/query/people.ts's listItemsForPerson), same leak model
// as GET /people itself.

import { use, useCallback, useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../../components/shell/AppShell.js";
import { ChildPosterGrid } from "../../../components/detail/ChildPosterGrid.js";
import { Skeleton } from "../../../components/skeleton/Skeleton.js";
import { useCursorFeed, type CursorPage } from "../../../components/browse/useCursorFeed.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import { buildImageUrl } from "../../../lib/image-url.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./page.module.css";

type Person = components["schemas"]["Person"];
type PersonItemEntry = components["schemas"]["PersonItemEntry"];
type ImageDescriptor = components["schemas"]["ImageDescriptor"];

interface FilmographyCard {
  id: string;
  title: string;
  subtitle?: string | undefined;
  blurhash: string | null;
  href: string;
  entityType: string;
}

function posterBlurhash(images: ImageDescriptor[] | undefined): string | null {
  return images?.find((img) => img.kind === "poster")?.blurhash ?? null;
}

function toCard(entry: PersonItemEntry): FilmographyCard {
  const item = entry.item;
  return {
    id: item.id,
    title: item.title,
    subtitle: item.year ? String(item.year) : undefined,
    blurhash: posterBlurhash(item.images),
    href: `/items/${entry.itemType}/${item.id}`,
    entityType: entry.itemType,
  };
}

const FILMOGRAPHY_PAGE_LIMIT = 100;

function PersonContent({ id }: { id: string }): React.JSX.Element {
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [personNotFound, setPersonNotFound] = useState(false);
  // browser-shell-browse-F7: the .catch below used to handle ONLY 404 —
  // any other failure (a transient 5xx, a network error) left `person`
  // null forever with `personNotFound` also false, so the render fell
  // into the `!person` skeleton branch below permanently: no error, no
  // retry, indistinguishable from "still loading". Same error+retry-key
  // shape as HomeContent.tsx's/browse's own fix for the identical class
  // of bug (confirmed[16]).
  const [personError, setPersonError] = useState<string | null>(null);
  const [personRetryKey, setPersonRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPersonError(null);
    getAuthStore()
      .getAccessToken()
      .then((token) => {
        if (!cancelled) setAccessToken(token);
      });
    apiGet("/people/{id}", { params: { path: { id } } })
      .then((p) => {
        if (!cancelled) setPerson(p);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof LoombreApiError && err.status === 404) {
          setPersonNotFound(true);
        } else {
          setPersonError(apiErrorCopy(err, "Failed to load this person."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, personRetryKey]);

  const fetchFilmographyPage = useCallback(
    async (cursor: string | null): Promise<CursorPage<FilmographyCard>> => {
      const page = await apiGet("/people/{id}/items", {
        params: { path: { id }, query: { limit: FILMOGRAPHY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) } },
      });
      return { items: page.items.map(toCard), nextCursor: page.nextCursor };
    },
    [id],
  );

  // resetKey mirrors app/browse/page.tsx's pattern: null until we know the
  // person actually resolved (no point fetching a filmography page for a
  // person we're about to 404), then a stable key that only changes if the
  // route's own id changes.
  const { items, hasMore, loading: filmographyLoading, loadingMore, error, loadMoreError, loadMore } = useCursorFeed<FilmographyCard>(
    fetchFilmographyPage,
    person ? id : null,
  );

  if (personNotFound) {
    return <div className={styles.notFound}>Person not found.</div>;
  }

  if (personError) {
    return (
      <div className={styles.loadMoreError}>
        {personError}
        <button type="button" className={styles.loadMore} onClick={() => setPersonRetryKey((k) => k + 1)}>
          Retry
        </button>
      </div>
    );
  }

  if (!person || accessToken === null) {
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

  const portraitSrc = buildImageUrl({
    serverUrl,
    accessToken,
    entityType: "person",
    entityId: person.id,
    kind: "thumb",
    width: 320,
  });

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        {/* No blurhash surfaced on Person today (contract has no images[]
            on Person — only Movie/Series/Episode/Artist/Album/Track carry
            one); a plain <img> with the shared avatar-fallback background
            is the honest treatment rather than inventing a placeholder. */}
        <img className={styles.portrait} src={portraitSrc} alt="" />
        <h1 className={styles.name}>{person.name}</h1>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Filmography</h2>
        {filmographyLoading ? (
          <Skeleton radius="md" height={200} />
        ) : error ? (
          <div className={styles.notFoundInline}>{error}</div>
        ) : (
          <>
            <ChildPosterGrid
              emptyMessage="No visible credits found."
              serverUrl={serverUrl}
              accessToken={accessToken}
              items={items}
            />
            {hasMore && (
              <button type="button" className={styles.loadMore} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
            {/* Non-destructive, same reasoning as watchlist/page.tsx — the
                button above is already the retry (cursor/hasMore survive a
                failed loadMore in useCursorFeed). */}
            {loadMoreError && <div className={styles.loadMoreError}>{loadMoreError}</div>}
          </>
        )}
      </section>
    </div>
  );
}

export default function PersonPage({ params }: { params: Promise<{ id: string }> }): React.JSX.Element {
  const { id } = use(params);
  return (
    <AppShell>
      <PersonContent id={id} />
    </AppShell>
  );
}
