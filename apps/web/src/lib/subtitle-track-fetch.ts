// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/subtitle-track-fetch.ts
//
// Fetches a session's WebVTT side-track and returns a same-origin blob URL
// for the player's `<track>` element.
//
// Why not a plain `<track src="https://server/…/sub0.vtt?token=…">`: a text
// track is CORS-restricted, and a `<track>` on a `<video>` without a
// `crossorigin` attribute fetches in no-cors mode, which browsers refuse
// outright for a cross-origin URL ("Unsafe attempt to load URL … Domains,
// protocols and ports must match" — Chrome, 2026-09-03 live check). The web
// app and the server ARE different origins in every real deployment
// (:3000 vs :3001 in the installers, the same split in dev). Putting
// `crossorigin` on the <video> instead would flip every media request
// (direct-play file ranges, native-HLS playlists and segments) into CORS
// mode too — a much wider blast radius for one small text file. So the
// VTT is fetched here with an ordinary CORS request (the server already
// answers those, it is how every API call works) and handed to <track>
// as a blob: URL, which is same-origin by construction.
//
// Retry: the subtitle-extract worker job runs right after the session is
// created, so the first fetch can race it — the server answers 503
// `subtitle-not-ready` with Retry-After (apps/server/src/playback/
// subtitle-file.controller.ts) until sub0.vtt exists; a 404 is treated the
// same way. Bounded: after `maxAttempts` the caller gets null and simply
// attaches no track, never a broken one.
//
// Every side effect is injectable (fetch, sleep, createObjectURL) so the
// retry ladder is unit-tested without timers or a DOM.

export interface FetchSubtitleTrackOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  createObjectUrl?: (blob: Blob) => string;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_RETRY_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 5_000;

function retryDelayMs(response: Response): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  return DEFAULT_RETRY_DELAY_MS;
}

function isNotReadyYet(status: number): boolean {
  return status === 503 || status === 404;
}

/** Resolves to a `blob:` URL carrying the VTT text, or null when the track
 *  can't be fetched (not extracted within the retry budget, unauthorized,
 *  network failure). Never throws. */
export async function fetchSubtitleTrackObjectUrl(
  url: string,
  options: FetchSubtitleTrackOptions = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const createObjectUrl =
    options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      return null;
    }
    if (response.ok) {
      const text = await response.text();
      return createObjectUrl(new Blob([text], { type: "text/vtt" }));
    }
    if (!isNotReadyYet(response.status) || attempt === maxAttempts) return null;
    await sleep(retryDelayMs(response));
  }
  return null;
}
