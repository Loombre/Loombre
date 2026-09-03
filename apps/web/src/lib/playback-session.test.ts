// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-session.test.ts
//
// `applyDirectPlayOnlyGuard` is the pure core of the music-scoped interim
// decline shim (createDirectPlaySession) — the impure orchestration
// (calling createPlaybackSession, ending the session on a downgrade) needs
// a real network/AuthStore and is exercised by the browser E2E lane
// instead, per this step's "compile-true wiring + pure-logic coverage"
// scope (no vi.mock in this codebase's test suite — see e.g.
// device-profile.test.ts's ProbeEnv-injection pattern for why).

import { describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { LoombreApiError } from "@loombre/sdk";
import { applyDirectPlayOnlyGuard, classifyCreateSessionError, endPlaybackSessionOnUnload, type CreateSessionResult } from "./playback-session.js";

type PlaybackSession = components["schemas"]["PlaybackSession"];

function fakeSession(decision: string, reasons: PlaybackSession["plan"]["reasons"] = []): PlaybackSession {
  return {
    id: "session-1",
    itemId: "item-1",
    userId: "user-1",
    deviceId: "device-1",
    plan: {
      decision: decision as PlaybackSession["plan"]["decision"],
      reasons,
      container: "source",
      video: { action: "none" },
      audio: { action: "none" },
      subtitle: { strategy: "none" },
      ladder: [],
      ffmpegArgs: [],
      engineVersion: "1.0.0",
    },
    status: "created",
    errorCode: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

describe("applyDirectPlayOnlyGuard", () => {
  it("passes a direct-play session through unchanged", () => {
    const result: CreateSessionResult = { ok: true, session: fakeSession("direct-play") };
    expect(applyDirectPlayOnlyGuard(result)).toBe(result);
  });

  it("downgrades a direct-stream session to ok:false, carrying the plan's real reasons", () => {
    const reasons: PlaybackSession["plan"]["reasons"] = [{ code: "video-codec-unsupported", streamIndex: 0, detail: null }];
    const result: CreateSessionResult = { ok: true, session: fakeSession("direct-stream", reasons) };
    expect(applyDirectPlayOnlyGuard(result)).toEqual({ ok: false, reasons, status: 409 });
  });

  it("downgrades a remux session the same way", () => {
    const result: CreateSessionResult = { ok: true, session: fakeSession("remux") };
    expect(applyDirectPlayOnlyGuard(result)).toEqual({ ok: false, reasons: [], status: 409 });
  });

  it("downgrades a transcode session the same way", () => {
    const result: CreateSessionResult = { ok: true, session: fakeSession("transcode") };
    expect(applyDirectPlayOnlyGuard(result)).toEqual({ ok: false, reasons: [], status: 409 });
  });

  it("passes an already-unavailable result through unchanged", () => {
    const result: CreateSessionResult = { ok: false, reasons: [], status: 429 };
    expect(applyDirectPlayOnlyGuard(result)).toBe(result);
  });
});

// SPF-7 Phase B (peer review, CONFIRMED BUG): the 409 media-unplayable
// problem body carries `reasons` (packages/contract/openapi.yaml's
// createPlaybackSession 409 doc; apps/server/src/playback/
// unplayable-media.exception.ts sends `reasons`) but the client used to
// read `problem?.wouldBeReasons` — a field the wire never actually sent —
// so every genuine refusal rendered "No specific reason was reported."
// `classifyCreateSessionError` is the pure core of createPlaybackSession's
// catch branch, split out so this is testable without a network call (the
// impure `createPlaybackSession` itself is exercised by the browser E2E
// lane, per this file's header).
describe("classifyCreateSessionError (SPF-7 Phase B)", () => {
  it("reads the problem body's REAL `reasons` extension member on a 409", () => {
    const reasons: PlaybackSession["plan"]["reasons"] = [
      { code: "hdr-tone-map-required", streamIndex: 0, detail: null },
      { code: "tone-map-refused-by-policy", streamIndex: null, detail: null },
    ];
    const err = new LoombreApiError(409, {
      type: "urn:loombre:problem:unplayable-media",
      title: "Media cannot be played",
      status: 409,
      code: "media-unplayable",
      reasons,
    });
    expect(classifyCreateSessionError(err)).toEqual({ ok: false, reasons, status: 409 });
  });

  it("falls back to the legacy `wouldBeReasons` key when a problem body still carries only that (defensive, not the real wire shape)", () => {
    const reasons: PlaybackSession["plan"]["reasons"] = [{ code: "video-codec-unsupported", streamIndex: 0, detail: null }];
    const err = new LoombreApiError(409, {
      type: "urn:loombre:problem:unplayable-media",
      title: "Media cannot be played",
      status: 409,
      wouldBeReasons: reasons,
    });
    expect(classifyCreateSessionError(err)).toEqual({ ok: false, reasons, status: 409 });
  });

  it("a 429 with no reasons at all (the documented shape — no such extension member) classifies with an empty array", () => {
    const err = new LoombreApiError(429, {
      type: "urn:loombre:problem:too-many-requests",
      title: "Too Many Requests",
      status: 429,
    });
    expect(classifyCreateSessionError(err)).toEqual({ ok: false, reasons: [], status: 429 });
  });

  it("a 422 also classifies (validation refusal)", () => {
    const err = new LoombreApiError(422, { type: "urn:loombre:problem:validation", title: "Unprocessable Entity", status: 422 });
    expect(classifyCreateSessionError(err)?.status).toBe(422);
  });

  it("returns null for a status this classifier doesn't own (404/5xx) — the caller re-throws", () => {
    const err = new LoombreApiError(500, { type: "urn:loombre:problem:internal", title: "Internal Server Error", status: 500 });
    expect(classifyCreateSessionError(err)).toBeNull();
  });

  it("returns null for a non-LoombreApiError (a network-layer rejection) — the caller re-throws", () => {
    expect(classifyCreateSessionError(new TypeError("Failed to fetch"))).toBeNull();
  });
});

// browser-player-F5: the keepalive-DELETE unload sender. Impure edges
// (AuthStore token, global fetch) are injected per this file's header;
// the component-level wiring (which pagehide fires it, the double-DELETE
// guard against the unmount path) lives in VideoPlayer.test.tsx.
describe("endPlaybackSessionOnUnload", () => {
  function captureFetch(): { calls: { url: string; init: RequestInit | undefined }[]; fetchFn: typeof fetch } {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  it("dispatches a keepalive DELETE with the Bearer token, tolerating a trailing serverUrl slash", () => {
    const { calls, fetchFn } = captureFetch();
    const dispatched = endPlaybackSessionOnUnload("http://server:3001/", "session-1", {
      accessToken: "tok-1",
      fetchFn,
    });
    expect(dispatched).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://server:3001/playback/sessions/session-1");
    expect(calls[0]?.init).toMatchObject({
      method: "DELETE",
      keepalive: true,
      headers: { Authorization: "Bearer tok-1" },
    });
  });

  it("dispatches nothing without an access token, reporting it so the caller keeps unmount-DELETE duty", () => {
    const { calls, fetchFn } = captureFetch();
    expect(endPlaybackSessionOnUnload("http://server:3001", "session-1", { accessToken: null, fetchFn })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never throws when the send itself throws synchronously, and reports the non-dispatch", () => {
    const fetchFn = (() => {
      throw new Error("document already tearing down");
    }) as unknown as typeof fetch;
    expect(endPlaybackSessionOnUnload("http://server:3001", "session-1", { accessToken: "tok-1", fetchFn })).toBe(
      false,
    );
  });

  it("swallows an async network rejection (nothing is left to catch it on unload)", async () => {
    const fetchFn = (() => Promise.reject(new Error("net down"))) as typeof fetch;
    expect(endPlaybackSessionOnUnload("http://server:3001", "session-1", { accessToken: "tok-1", fetchFn })).toBe(true);
    // Settle the microtask queue — an unhandled rejection here would fail
    // the run via vitest's unhandled-error reporter.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
