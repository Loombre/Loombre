// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/media-session-url.ts
//
// GET /playback/sessions/{id}/file accepts `?token=<accessJWT>` (P2.18)
// since <video>/<audio> elements can't send an Authorization header. Access
// tokens are short-lived (15 min, P2.1); a movie longer than that needs its
// `src` refreshed mid-playback or subsequent Range requests 401. This hook
// re-derives the token periodically via the (already proactively-refreshing,
// single-flight) AuthStore and hands the caller a new URL when the embedded
// token actually changes — the caller (VideoPlayer/MusicPlayerProvider) is
// responsible for the "swap src without losing position" dance (capture
// currentTime + paused state, set src, seek+resume on loadedmetadata) since
// that's DOM-element-specific.
//
// Phase 3 Step 6c additions (STATE.md Step 6b's manifestUrl/subtitles
// surfaces, now consumed): `buildHlsManifestUrl`/`buildHlsSubtitleUrl` are
// the same `?token=` pattern applied to the two other P2.18-scoped GETs a
// video/audio session can need (docs/PLAYBACK.md §9's `hls/media.m3u8` and
// `subtitles/{file}` families — see apps/server/src/playback/hls-file.
// controller.ts + subtitle-file.controller.ts). `useHlsManifestUrl` reuses
// this file's own token-refresh hook for the Safari-native HLS path, which
// (unlike hls.js) has no per-request xhrSetup hook to re-authenticate a
// long-running EVENT playlist poll — it re-fetches the exact URL handed to
// `video.src` repeatedly, so that URL's token must stay fresh the same way
// the direct-play file URL's does.
//
// `appendTokenParam` is the third URL kind (VideoPlayer.tsx's hls.js
// xhrSetup): the worker's served HLS playlist writes run-relative segment
// URIs with NO token embedded (apps/worker/src/transcode/playlist.ts's
// `renderServedPlaylist` — a segment URI is a bare `run0/s000000.m4s`), so
// hls.js's own URL resolution (unlike Safari's native HLS engine, which
// documented-behavior-propagates the manifest URL's query string onto
// every sub-request it makes for that same playback) never carries a token
// through to a segment GET on its own. Every hls.js request must have the
// token appended by hand, at request time, via xhrSetup — this is that
// per-request append.
//
// `isSameUrlIgnoringToken` (task #6, 2026-08-08/10 HLS-stall recon): the
// direct-play/native-HLS attach guard in VideoPlayer.tsx used to compare
// `currentSrc === activeSrcUrl` verbatim, which trips on every token
// rotation this file's `useTokenUrl` hands back — access tokens are
// 15-minute JWTs with NO server-side grace window (apps/server/src/
// session/token.service.ts's `ACCESS_TOKEN_TTL_MS`/`verifyAccessToken`,
// jose's `jwtVerify` with no `clockTolerance`), and the AuthStore rotates
// ~30s before its OWN expiry (apps/web/src/lib/auth-store.ts's
// `EXPIRY_SKEW_MS`), so a new token — and thus a new URL from this file's
// builders — appears roughly every ~14.5 minutes, not every 60s
// (CHECK_INTERVAL_MS below is a POLL interval, not a refresh interval; see
// `useTokenUrl`'s own comment). A verbatim comparison forced a full
// `video.src` reset + `load()` + reseek on every one of those rotations
// even though the underlying stream never changed. This helper lets the
// caller tell "the token rotated" apart from "this is genuinely a
// different resource" (a new session/file).

import { useEffect, useState } from "react";
import { getAuthStore } from "./auth-store.js";

/** How often to re-check the token. Well inside the 15-minute access-token
 *  lifetime and the AuthStore's own 30s pre-expiry refresh skew. */
const CHECK_INTERVAL_MS = 60_000;

export function buildSessionFileUrl(serverUrl: string, sessionId: string, token: string): string {
  const base = serverUrl.replace(/\/$/, "");
  const url = new URL(`${base}/playback/sessions/${encodeURIComponent(sessionId)}/file`);
  url.searchParams.set("token", token);
  return url.toString();
}

/** `GET /playback/sessions/{id}/hls/media.m3u8?token=` (docs/PLAYBACK.md
 *  §9) — the live HLS media playlist for a direct-stream/remux/transcode
 *  session. Used directly as `video.src` on the Safari-native branch, and
 *  as the one-shot `hls.loadSource()` argument on the hls.js branch. */
export function buildHlsManifestUrl(serverUrl: string, sessionId: string, token: string): string {
  const base = serverUrl.replace(/\/$/, "");
  const url = new URL(`${base}/playback/sessions/${encodeURIComponent(sessionId)}/hls/media.m3u8`);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * `GET /playback/sessions/{id}/hls/master.m3u8?token=` (docs/PLAYBACK.md
 * §9.1.1, Wave C2) — the MULTI-VARIANT master playlist, and as of
 * owner-decision V5 the attach point for EVERY HLS session, ladder-empty
 * ones included (they render a single-variant master, so the client has one
 * path and no branch).
 *
 * Its variant URIs are relative `v{K}/media.m3u8`, which both engines
 * resolve against THIS url — so the `?token=` here is also what the
 * variant-playlist request inherits on the native path (Safari's documented
 * query-string propagation, see this file's header), while the hls.js path
 * re-appends per request through `xhrSetup` regardless.
 */
export function buildHlsMasterUrl(serverUrl: string, sessionId: string, token: string): string {
  const base = serverUrl.replace(/\/$/, "");
  const url = new URL(`${base}/playback/sessions/${encodeURIComponent(sessionId)}/hls/master.m3u8`);
  url.searchParams.set("token", token);
  return url.toString();
}

/** `GET /playback/sessions/{id}/subtitles/sub0.vtt?token=` (STATE.md
 *  P3.9(e)) — the single-segment extracted WebVTT file a `subtitle.strategy
 *  === 'hls-vtt'` plan side-track serves. The filename is always literally
 *  `sub0.vtt` (apps/server/src/playback/subtitle-file.controller.ts's
 *  `VTT_SEGMENT_FILENAME` — a single-segment side-track has no other
 *  file), never derived from client input. */
export function buildHlsSubtitleUrl(serverUrl: string, sessionId: string, token: string): string {
  const base = serverUrl.replace(/\/$/, "");
  const url = new URL(`${base}/playback/sessions/${encodeURIComponent(sessionId)}/subtitles/sub0.vtt`);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Appends/replaces `?token=` on an arbitrary ABSOLUTE url — used by
 *  VideoPlayer.tsx's hls.js `xhrSetup` to re-authenticate every manifest
 *  reload and every segment/init-segment GET individually (see this file's
 *  header). `url` must already be absolute — hls.js always resolves
 *  fragment/level/init URIs against the (absolute) manifest URL before a
 *  loader ever sees them, so this is never handed a bare relative path. */
export function appendTokenParam(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

/** Structural URL equality that ignores `?token=` — "same underlying
 *  resource, only the auth token differs" (see this file's header, task #6).
 *  Compares origin + pathname + every OTHER query param (order-insensitive:
 *  `token`'s position in the URL is not guaranteed, and nothing here
 *  guarantees the two inputs were built the same way) + hash. `token` is
 *  dropped from BOTH sides before comparing, so its value never matters and
 *  its absence on one or both sides never by itself makes two otherwise-
 *  identical URLs register as different. Returns `false` (never "same") for
 *  an unparseable input — a malformed URL must never be silently treated as
 *  a no-op by a caller using this as an "already attached, skip the reload"
 *  guard. */
export function isSameUrlIgnoringToken(a: string, b: string): boolean {
  let urlA: URL;
  let urlB: URL;
  try {
    urlA = new URL(a);
    urlB = new URL(b);
  } catch {
    return false;
  }
  urlA.searchParams.delete("token");
  urlB.searchParams.delete("token");
  // Query param order can legitimately differ (URLSearchParams preserves
  // insertion order; nothing guarantees `token` was appended last) — sort
  // both before comparing so a reordering alone never registers as
  // "different".
  urlA.searchParams.sort();
  urlB.searchParams.sort();
  return (
    urlA.origin === urlB.origin &&
    urlA.pathname === urlB.pathname &&
    urlA.searchParams.toString() === urlB.searchParams.toString() &&
    urlA.hash === urlB.hash
  );
}

/** Shared implementation behind `useSessionFileUrl`/`useHlsManifestUrl`:
 *  re-derives `token` on an interval via the AuthStore and hands back a
 *  freshly-built URL only when the token actually changed. `build` is
 *  always one of this module's own top-level exported functions (stable
 *  identity across renders), so including it in the effect's dependency
 *  array never causes a spurious re-subscription. */
function useTokenUrl(
  serverUrl: string,
  sessionId: string | null,
  build: (serverUrl: string, sessionId: string, token: string) => string,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setUrl(null);
      return;
    }
    const activeSessionId = sessionId; // narrowed to `string`, captured for the closure below
    let cancelled = false;
    let lastToken: string | null = null;

    async function refresh(): Promise<void> {
      const token = await getAuthStore().getAccessToken();
      if (cancelled || !token || token === lastToken) return;
      lastToken = token;
      setUrl(build(serverUrl, activeSessionId, token));
    }

    void refresh();
    const interval = setInterval(() => void refresh(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [serverUrl, sessionId, build]);

  return url;
}

/** Returns the current session file URL, re-issuing it whenever the access
 *  token changes. `null` while the token isn't known yet (e.g. still
 *  resolving on mount). */
export function useSessionFileUrl(serverUrl: string, sessionId: string | null): string | null {
  return useTokenUrl(serverUrl, sessionId, buildSessionFileUrl);
}

/** Same token-freshness contract as `useSessionFileUrl`, for the Safari-
 *  native HLS `video.src` (VideoPlayer.tsx) — `sessionId` should be `null`
 *  whenever the session isn't an HLS one (mirrors `useSessionFileUrl`'s own
 *  null-means-inactive convention).
 *
 *  Wave C2 re-pointed it at the MASTER playlist (owner-decision V5): the
 *  native engine follows the master's relative `v{K}/media.m3u8` URIs by
 *  itself, and a fresh token on THIS url is what its documented
 *  query-string propagation carries onto that hop. The paused-boundary src
 *  refresh this hook already drives is therefore also the mechanism that
 *  re-reads the master with a rotated token — no new auth surface, exactly
 *  as §9.1.9 requires. */
export function useHlsManifestUrl(serverUrl: string, sessionId: string | null): string | null {
  return useTokenUrl(serverUrl, sessionId, buildHlsMasterUrl);
}
