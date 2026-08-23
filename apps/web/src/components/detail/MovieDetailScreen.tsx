// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/detail/MovieDetailScreen.tsx
//
// Full Phosphor movie-detail screen (design/phosphor/README.md "Movie
// detail" — the prototype's exact structure: 340px scene banner + "←
// LIBRARY" glass pill, -190px content pull-up, 218px poster, accent
// eyebrow, 52px display title, blurb, Play/watchlist-slot/Mark-watched
// actions, two-column VERSIONS+CAST / METADATA body). Desktop and mobile
// trees both render (coexist in the DOM, CSS-swapped at 767.98px — the
// same convention AppShell's sidebar/mobile-chrome pair already uses),
// sharing every data-fetch and sub-component.
//
// Data-source ground truth (Phosphor W2 L4 brief, restated per field):
//   - Eyebrow (MOVIE · year · rating · runtime · genres): all real
//     CatalogItemBase/Movie fields.
//   - Capability line ("DIRECT PLAY OK ON THIS DEVICE"): OMITTED. Nothing
//     on this screen holds a PlaybackPlan/decision — the client's one
//     pre-play plan-preview path was deliberately removed in Phase 3 Step
//     6c (lib/playback-session.ts's header: "VideoPlayer.tsx now goes
//     straight to createPlaybackSession() and branches on the real
//     session's own plan.decision"). Building a new approximate preview
//     here would resurrect exactly the pattern that removal retired, for a
//     screen that never itself plays anything. Logged in the freeze
//     report as a real gap, not silently dropped.
//   - VERSIONS/METADATA's codec/path/audio/subtitle data: this lane's
//     additive MediaFileSummary contract extension — see VersionCard.tsx
//     and MetadataCard.tsx's own headers for the exact ground-truth per
//     field (Match confidence + Studio are OMITTED, nothing backs them).
//   - Mark watched: real, PUT /progress/{itemId} — MarkWatchedButton.tsx.
//   - EDIT: disabled-with-tooltip — no item-update endpoint exists.
//   - FIX MATCH: L2's real FixMatch (swapped in at Wave-2 landing), and
//     ADMIN-ONLY — both endpoints behind it are /admin/*, so this screen
//     resolves the viewer's admin flag once and MetadataCard renders the
//     action only for an admin (QA browser-casual-F1; see MetadataCard.tsx).
//
// Watchlist slot (sibling lane L3's component lands in the marked spot
// below — do not build a watchlist button here, per this lane's
// coordination-seam instruction).

import type { components } from "@loombre/sdk";
import { apiGet } from "../../lib/api-client.js";
import { pickHeroImage } from "../../lib/pick-hero-image.js";
import { useWatchedState } from "../../lib/use-watched-state.js";
import { useIsAdmin } from "../../lib/use-is-admin.js";
import { useDetailFetch } from "./useDetailFetch.js";
import { DetailNotFound, DetailLoadError } from "./DetailFetchStatus.js";
import { PlayLink } from "./PlayLink.js";
import { MarkWatchedButton } from "./MarkWatchedButton.js";
import { SceneBanner } from "./SceneBanner.js";
import { MobileSceneCard } from "./MobileSceneCard.js";
import { DetailPoster } from "./DetailPoster.js";
import { VersionCard } from "./VersionCard.js";
import { MetadataCard } from "./MetadataCard.js";
import { PersonCard } from "./PersonCard.js";
import { formatRating, formatRuntime } from "./format.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import { RestrictedZoneChip } from "../restricted/RestrictedZoneChip.js";
import { WatchlistToggle } from "./WatchlistToggle.js";
import styles from "./MovieDetailScreen.module.css";

type Movie = components["schemas"]["Movie"];

function eyebrowLine(movie: Movie): string {
  const parts = [
    "MOVIE",
    movie.year ? String(movie.year) : null,
    movie.contentRating,
    formatRuntime(movie.runtimeMs),
    movie.genres.length > 0 ? movie.genres.join(" / ") : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function mobileMetaLine(movie: Movie): string {
  const parts = [
    movie.year ? String(movie.year) : null,
    formatRuntime(movie.runtimeMs),
    formatRating(movie.communityRating) ? `★ ${formatRating(movie.communityRating)}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

export function MovieDetailScreen({
  id,
  serverUrl,
  accessToken,
}: {
  id: string;
  serverUrl: string;
  accessToken: string;
}): React.JSX.Element {
  const {
    entity: movie,
    notFound,
    error,
    retry,
  } = useDetailFetch<Movie>(() => apiGet("/movies/{id}", { params: { path: { id } } }), id);

  // Called unconditionally (rules-of-hooks) — the hook itself no-ops until
  // movie.id is known (see use-watched-state.ts's `itemId: null` case). One
  // call here, shared by BOTH the desktop and mobile action rows below
  // (they coexist in the DOM), so the real GET /progress/{itemId} fires
  // exactly once per page load, not twice.
  const watched = useWatchedState(movie?.id ?? null, movie?.runtimeMs ?? null);

  // browser-casual-F1: the METADATA card's FIX MATCH action is an /admin/*
  // flow (requireAdmin server-side), so it must not be offered to a
  // non-admin at all. Resolved ONCE here — both MetadataCards below
  // (desktop + mobile trees coexist in the DOM) share this single
  // GET /users/me, exactly like the useWatchedState call above shares one
  // GET /progress/{itemId}. `null` (still in flight) collapses to false:
  // fail closed, no flash of admin-only chrome. UX only — see
  // lib/use-is-admin.ts's header for the security posture.
  const isAdmin = useIsAdmin() === true;

  if (notFound) return <DetailNotFound label="Movie" />;
  if (error) return <DetailLoadError message={error} onRetry={retry} />;

  if (!movie) {
    return (
      <div className={styles.page}>
        <Skeleton radius="lg" height={340} />
        <Skeleton radius="sm" height={16} width="40%" />
        <Skeleton radius="sm" height={16} width="70%" />
      </div>
    );
  }

  const hero = pickHeroImage(movie.images);
  const posterImage = movie.images?.find((img) => img.kind === "poster");
  const people = movie.people;
  const cast = (people ?? []).filter((p) => p.role === "actor");
  const files = movie.mediaFiles ?? [];
  const defaultFile = files.find((f) => f.isDefault) ?? files[0];
  const restricted = movie.contentClass === "restricted";

  return (
    <div className={styles.page}>
      {/* ── Desktop tree (CSS-hidden below 767.98px) ── */}
      <div className={styles.desktopOnly}>
        <SceneBanner
          serverUrl={serverUrl}
          accessToken={accessToken}
          entityType="movie"
          title={movie.title}
          dominantColor={hero.dominantColor}
          entityId={movie.id}
          backdropKind={hero.kind}
          desktopHeight={340}
        />
        <div className={styles.pullUp}>
          <DetailPoster
            serverUrl={serverUrl}
            accessToken={accessToken}
            entityType="movie"
            entityId={movie.id}
            title={movie.title}
            blurhash={posterImage?.blurhash ?? null}
            dominantColor={hero.dominantColor}
          />
          <div className={styles.metaColumn}>
            <div className={styles.eyebrowRow}>
              <span className={styles.eyebrow}>{eyebrowLine(movie)}</span>
              {restricted && <RestrictedZoneChip />}
            </div>
            <h1 className={styles.title}>{movie.title}</h1>
            {movie.overview && <p className={styles.blurb}>{movie.overview}</p>}
            <div className={styles.actionRow}>
              <PlayLink itemId={movie.id} />
              <WatchlistToggle itemId={movie.id} />
              <MarkWatchedButton state={watched.state} busy={watched.busy} onToggle={watched.toggle} />
              {/* Capability line ("DIRECT PLAY OK ON THIS DEVICE") intentionally
                  omitted — see this file's header for the ground-truth reasoning. */}
            </div>
            <div className={styles.body}>
              <div className={styles.leftColumn}>
                <div className={styles.sectionEyebrow}>
                  VERSIONS · {files.length} {files.length === 1 ? "FILE" : "FILES"}
                </div>
                <div className={styles.versionsList}>
                  {files.length === 0 ? (
                    <div className={styles.emptyNote}>No files on record for this item.</div>
                  ) : (
                    files.map((file) => <VersionCard key={file.id} file={file} />)
                  )}
                </div>
                {cast.length > 0 && (
                  <>
                    <div className={styles.sectionEyebrow}>CAST</div>
                    <div className={styles.castRail}>
                      {cast.map((person) => (
                        <PersonCard key={person.id} person={person} />
                      ))}
                    </div>
                  </>
                )}
              </div>
              <MetadataCard itemId={movie.id} itemTitle={movie.title} isAdmin={isAdmin} people={people} defaultFile={defaultFile} addedAtMs={movie.addedAtMs} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Mobile tree (CSS-hidden at/above 767.98px) ── */}
      <div className={styles.mobileOnly}>
        <MobileSceneCard
          serverUrl={serverUrl}
          accessToken={accessToken}
          entityType="movie"
          dominantColor={hero.dominantColor}
          entityId={movie.id}
          backdropKind={hero.kind}
          title={movie.title}
          metaLine={mobileMetaLine(movie)}
        />
        {restricted && <RestrictedZoneChip />}
        <div className={styles.mobileActionRow}>
          <PlayLink itemId={movie.id} />
          <WatchlistToggle itemId={movie.id} />
        </div>
        <MarkWatchedButton state={watched.state} busy={watched.busy} onToggle={watched.toggle} variant="mobile" />
        {movie.overview && <p className={styles.mobileBlurb}>{movie.overview}</p>}
        <div className={styles.sectionEyebrow}>VERSIONS</div>
        <div className={styles.versionsList}>
          {files.map((file) => (
            <VersionCard key={file.id} file={file} />
          ))}
        </div>
        {cast.length > 0 && (
          <>
            <div className={styles.sectionEyebrow}>CAST</div>
            <div className={styles.castRail}>
              {cast.map((person) => (
                <PersonCard key={person.id} person={person} />
              ))}
            </div>
          </>
        )}
        <MetadataCard itemId={movie.id} itemTitle={movie.title} isAdmin={isAdmin} people={people} defaultFile={defaultFile} addedAtMs={movie.addedAtMs} />
      </div>
    </div>
  );
}
