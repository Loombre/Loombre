// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-session.ts
//
// Shared session create/end helpers for both the video player
// (components/player/) and the music mini player (components/music/) —
// POST /playback/sessions to start (P2.4/P2.17/D23), DELETE to end.
//
// Phase 3 §11 step 6c (STATE.md Step 6b freeze): the Step 6b interim
// PlanPreview/computePlanPreview (a POST /playback/plan pre-check the
// video player used to short-circuit straight to UnavailableScreen for any
// non-direct-play decision) is REMOVED — VideoPlayer.tsx now goes straight
// to `createPlaybackSession()` and branches on the real session's own
// `plan.decision` (direct-play vs HLS-attach), since the server accepts
// (201s) any decision short of "genuinely unplayable". Nothing else
// consumed `computePlanPreview`/`PlanPreview` (grepped before deleting).
//
// `createPlaybackSession()` itself is now decision-agnostic: it returns
// `ok: true` for ANY 201 (the server itself decides playability; a
// transcode/direct-stream/remux decision is no longer force-ended here).
// Music (components/music/MusicPlayerProvider.tsx) stays direct-play-only
// THIS lane — it calls `createDirectPlaySession()` below instead, which
// layers the OLD end-session-and-decline behavior back on top, now scoped
// to exactly one caller and named for what it actually does.

import type { components } from "@loombre/sdk";
import { apiDelete, apiGet, apiPost, LoombreApiError } from "./api-client.js";
import { resolveSessionDeviceProfile } from "./device-profile-override.js";
import { buildNetworkConditions } from "./network-conditions.js";
import { getAuthStore } from "./auth-store.js";

type PlaybackSession = components["schemas"]["PlaybackSession"];
type PlanReason = components["schemas"]["PlanReason"];

export interface CreateSessionOk {
  ok: true;
  session: PlaybackSession;
}
export interface CreateSessionUnavailable {
  ok: false;
  wouldBeReasons: PlanReason[];
  status: number;
}
export type CreateSessionResult = CreateSessionOk | CreateSessionUnavailable;

/** Extension member per openapi.yaml's createPlaybackSession 409 doc:
 *  "the problem body's `wouldBeReasons` extension member carries the same
 *  reasons POST /playback/plan would have returned." Absent on a 429 (the
 *  transcode-slots-exhausted response documents no such extension) —
 *  lib/playback-reasons.ts's `resolveUnavailableReasons` covers that case
 *  with a client-synthesized reason. */
interface ProblemWithWouldBeReasons {
  wouldBeReasons?: PlanReason[];
}

/**
 * Computes a plan and starts a playback session (docs/PLAYBACK.md §9).
 * Neutral on `decision` — direct-play, direct-stream, remux, and transcode
 * all come back as `ok: true` when the server accepts them (201); only a
 * real 409 (genuinely unplayable)/422/429 comes back `ok: false`. Callers
 * that need to further restrict which decisions they're willing to play
 * (music, this lane) apply that on top — see `createDirectPlaySession`.
 *
 * `mediaFileId` (PlanRequest's own optional field, packages/contract/
 * openapi.yaml — "Defaults to the item's primary media_files row when
 * omitted") is threaded through for the playback-refusal fallback flow
 * (lib/playback-fallback.ts): accepting a fallback re-attempts session
 * creation pinned to that specific alternate file, rather than the item's
 * default one.
 */
export async function createPlaybackSession(
  itemId: string,
  mode: "stream" | "download" = "stream",
  mediaFileId?: string,
): Promise<CreateSessionResult> {
  const serverUrl = getAuthStore().getSnapshot().serverUrl;
  // d3-a6: the live capability probe, with the deliberate per-browser
  // override (localStorage, QA/dev lever) merged above it when one is set —
  // see lib/device-profile-override.ts's header for the recorded decision.
  const device = await resolveSessionDeviceProfile();
  const network = buildNetworkConditions(serverUrl);
  try {
    const body = mediaFileId ? { itemId, mediaFileId, device, network, mode } : { itemId, device, network, mode };
    const session = await apiPost("/playback/sessions", { body });
    return { ok: true, session };
  } catch (err) {
    if (err instanceof LoombreApiError && (err.status === 409 || err.status === 422 || err.status === 429)) {
      const problem = err.problem as ProblemWithWouldBeReasons | undefined;
      return { ok: false, wouldBeReasons: problem?.wouldBeReasons ?? [], status: err.status };
    }
    throw err;
  }
}

/**
 * Pure core of the music-scoped direct-play-only guard: downgrades an
 * otherwise-ok session to `ok: false` when its plan's decision isn't
 * `'direct-play'`, carrying the plan's own (real) reasons through exactly
 * like a 409 would. An already-unavailable result passes through
 * unchanged. Split out from `createDirectPlaySession` so the DECISION is
 * unit-testable without any network/session-lifecycle I/O.
 */
export function applyDirectPlayOnlyGuard(result: CreateSessionResult): CreateSessionResult {
  if (!result.ok) return result;
  const decision = result.session.plan?.decision;
  if (decision !== undefined && decision !== "direct-play") {
    return { ok: false, wouldBeReasons: result.session.plan?.reasons ?? [], status: 409 };
  }
  return result;
}

/**
 * Phase 3 Step 6c MUSIC-ONLY interim shim (Step 6b's original blanket
 * behavior, now scoped to exactly this one caller —
 * components/music/MusicPlayerProvider.tsx): music stays direct-play-only
 * this lane, so a non-direct-play session is immediately ended (releasing
 * its transcode slot) and surfaced as unavailable, same as every
 * non-direct-play session was treated before 6c. `mediaFileId` is threaded
 * straight through to `createPlaybackSession` above — a track's picked
 * VERSION (components/detail/VersionRow.tsx), same meaning as there.
 *
 * OPEN ITEM (reported, not solved here): "music HLS transcode playback" —
 * gapless dual-<audio> HLS handoff (components/music/MusicPlayerProvider.tsx's
 * own header, the gapless.ts state machine) is its own docs/PLAN.md §3 D.5
 * problem, out of this lane's scope.
 */
export async function createDirectPlaySession(
  itemId: string,
  mode: "stream" | "download" = "stream",
  mediaFileId?: string,
): Promise<CreateSessionResult> {
  const result = await createPlaybackSession(itemId, mode, mediaFileId);
  const guarded = applyDirectPlayOnlyGuard(result);
  if (result.ok && !guarded.ok) {
    await endPlaybackSession(result.session.id);
  }
  return guarded;
}

export async function endPlaybackSession(sessionId: string): Promise<void> {
  try {
    await apiDelete("/playback/sessions/{id}", { params: { path: { id: sessionId } } });
  } catch {
    // Best-effort: the 15-minute idle sweeper (docs/PLAYBACK.md §9) reaps
    // any session this call fails to end (unload race, network blip).
  }
}

/** Injectable seams for `endPlaybackSessionOnUnload` — tests supply both;
 *  production callers omit them and get the real AuthStore token + global
 *  fetch (same "inject the impure edges" pattern as device-profile.ts's
 *  ProbeEnv). */
export interface EndSessionOnUnloadDeps {
  accessToken?: string | null;
  fetchFn?: typeof fetch;
}

/**
 * Best-effort session end for page unload (browser-player-F5) — the DELETE
 * twin of lib/progress-report.ts's `reportProgressOnUnload`, and the ONLY
 * session-end path that can run on a genuine full-document teardown (real
 * navigation, tab close), where React unmount cleanups never execute and
 * `endPlaybackSession` above is unreachable. Same transport reasoning as
 * the progress sender: `navigator.sendBeacon` can't carry a Bearer header
 * (the endpoint is auth-required), so `fetch(…, { keepalive: true })` is
 * the one option browsers keep alive past teardown that can still set
 * Authorization. Never throws (nothing is left to catch it on unload);
 * returns whether a request was actually dispatched, so the caller can
 * mark the session ended only when one was (a missing token dispatches
 * nothing — the 15-minute sweeper stays the fallback).
 */
export function endPlaybackSessionOnUnload(
  serverUrl: string,
  sessionId: string,
  deps: EndSessionOnUnloadDeps = {},
): boolean {
  const accessToken = "accessToken" in deps ? (deps.accessToken ?? null) : getAuthStore().getSnapshot().accessToken;
  if (!accessToken) return false;
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `${serverUrl.replace(/\/$/, "")}/playback/sessions/${encodeURIComponent(sessionId)}`;
  try {
    void fetchFn(url, {
      method: "DELETE",
      keepalive: true,
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => {
      // Best-effort — the sweeper reaps a session this send fails to end.
    });
    return true;
  } catch {
    return false;
  }
}

export async function getPlaybackSession(sessionId: string): Promise<PlaybackSession> {
  return apiGet("/playback/sessions/{id}", { params: { path: { id: sessionId } } });
}
