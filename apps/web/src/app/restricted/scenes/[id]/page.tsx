// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/restricted/scenes/[id]/page.tsx
//
// STATE.md Stash run (S9): scene detail — cover, editorial metadata,
// performer chips, tag chips, markers list, play/resume -> /watch/{id}
// (design/phosphor README "Restricted content": "Detail pages of zone
// titles carry a RESTRICTED · PIN HOLDERS ONLY chip beside the eyebrow" —
// RestrictedZoneChip.tsx, reused verbatim). GET /restricted/scenes/{id}
// is byte-identical-404 for nonexistent/invisible/locked (house pattern —
// see restricted-browse.ts's getRestrictedSceneDetail), so this page's
// 404 branch covers all three the same way app/items/[itemType]/[id]
// already does for the general catalog.

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../../../components/shell/AppShell.js";
import { RestrictedGate } from "../../../../components/restricted/RestrictedGate.js";
import { RestrictedZoneChip } from "../../../../components/restricted/RestrictedZoneChip.js";
import { PlayLink } from "../../../../components/detail/PlayLink.js";
import { ZoneWatchlistToggle } from "../../../../components/restricted/ZoneWatchlistToggle.js";
import { Skeleton } from "../../../../components/skeleton/Skeleton.js";
import { useRestricted } from "../../../../components/restricted/RestrictedProvider.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../../../lib/restricted-zone-count.js";
import { apiGet, LoombreApiError } from "../../../../lib/api-client.js";
import { buildImageUrl } from "../../../../lib/image-url.js";
import { getAuthStore } from "../../../../lib/auth-store.js";
import styles from "./page.module.css";

type RestrictedScene = components["schemas"]["RestrictedScene"];

function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  const totalMinutes = Math.round(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatMarkerTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function SceneContent({ id }: { id: string }): React.JSX.Element | null {
  const router = useRouter();
  const { state: restrictedState } = useRestricted();
  const { count, loading: countLoading } = useRestrictedZoneCount();
  const entitled = hasRestrictedZoneEntitlement(count);

  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [scene, setScene] = useState<RestrictedScene | null>(null);
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
    apiGet("/restricted/scenes/{id}", { params: { path: { id } } })
      .then((s) => {
        if (!cancelled) setScene(s);
      })
      .catch((err: unknown) => {
        if (!cancelled && err instanceof LoombreApiError && err.status === 404) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, restrictedState.locked, entitled]);

  if (countLoading || !entitled) return null;

  if (restrictedState.locked) {
    return (
      <div className={styles.page}>
        <RestrictedGate itemCount={count} />
      </div>
    );
  }

  if (notFound) {
    return <div className={styles.notFound}>Scene not found.</div>;
  }

  if (!scene || accessToken === null) {
    return (
      <div className={styles.page}>
        <Skeleton radius="lg" height={340} />
        <Skeleton radius="sm" height={32} width={320} />
        <Skeleton radius="md" height={160} />
      </div>
    );
  }

  const coverSrc = buildImageUrl({ serverUrl, accessToken, entityType: "movie", entityId: scene.id, kind: "backdrop", width: 1280 });
  const duration = formatDuration(scene.durationMs);

  return (
    <div className={styles.page}>
      <div className={styles.cover}>
        <img className={styles.coverImage} src={coverSrc} alt="" />
        <div className={styles.coverScrim} />
      </div>

      <div className={styles.body}>
        <div className={styles.eyebrowRow}>
          <span className={styles.eyebrow}>
            Scene
            {scene.year && ` · ${scene.year}`}
            {scene.contentRating && ` · ${scene.contentRating}`}
            {duration && ` · ${duration}`}
            {scene.quality.resolution && ` · ${scene.quality.resolution}`}
          </span>
          <RestrictedZoneChip />
        </div>

        <h1 className={styles.title}>{scene.title}</h1>

        {/* next/link, never a raw <a href> (QA browser-restricted-settings-F1):
            a full document load restarts RestrictedProvider at locked=true and
            nothing rehydrates the live server-side unlock, so a document
            navigation inside the zone lands on the PIN gate. */}
        {scene.studio && (
          <Link href={`/restricted/studios/${scene.studio.id}`} className={styles.studioLink}>
            {scene.studio.name}
          </Link>
        )}

        {scene.overview && <p className={styles.overview}>{scene.overview}</p>}

        <div className={styles.actions}>
          <PlayLink itemId={scene.id} />
          {/* RZI-D2a: zone-scoped toggle — key on scene id so navigating
              between scenes reseeds the membership state. */}
          <ZoneWatchlistToggle key={scene.id} itemId={scene.id} initialWatchlisted={scene.watchlisted} />
        </div>

        {scene.performers.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Performers</h2>
            <div className={styles.chipRow}>
              {scene.performers.map((p) => (
                <Link key={p.id} href={`/restricted/performers/${p.id}`} className={styles.chip}>
                  {p.name}
                </Link>
              ))}
            </div>
          </section>
        )}

        {scene.tags.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Tags</h2>
            <div className={styles.chipRow}>
              {scene.tags.map((t) => (
                <span key={t.id} className={styles.tagChip}>
                  {t.name}
                </span>
              ))}
            </div>
          </section>
        )}

        {scene.markers.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Chapters</h2>
            <ol className={styles.markerList}>
              {scene.markers.map((marker) => (
                <li key={marker.id}>
                  {/* next/link, never a raw <a href> — see
                      components/detail/PlayLink.tsx's header (QA
                      browser-items-F1): every /watch entry is client-side
                      so the route mounts and unmounts inside one document. */}
                  <Link href={`/watch/${scene.id}?t=${Math.floor(marker.startMs / 1000)}`} className={styles.markerRow}>
                    <span className={styles.markerTime}>{formatMarkerTime(marker.startMs)}</span>
                    <span className={styles.markerTitle}>{marker.title}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

export default function RestrictedScenePage({ params }: { params: Promise<{ id: string }> }): React.JSX.Element {
  const { id } = use(params);
  return (
    <AppShell>
      <SceneContent id={id} />
    </AppShell>
  );
}
