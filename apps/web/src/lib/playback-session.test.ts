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
import { applyDirectPlayOnlyGuard, type CreateSessionResult } from "./playback-session.js";

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
    expect(applyDirectPlayOnlyGuard(result)).toEqual({ ok: false, wouldBeReasons: reasons, status: 409 });
  });

  it("downgrades a remux session the same way", () => {
    const result: CreateSessionResult = { ok: true, session: fakeSession("remux") };
    expect(applyDirectPlayOnlyGuard(result)).toEqual({ ok: false, wouldBeReasons: [], status: 409 });
  });

  it("downgrades a transcode session the same way", () => {
    const result: CreateSessionResult = { ok: true, session: fakeSession("transcode") };
    expect(applyDirectPlayOnlyGuard(result)).toEqual({ ok: false, wouldBeReasons: [], status: 409 });
  });

  it("passes an already-unavailable result through unchanged", () => {
    const result: CreateSessionResult = { ok: false, wouldBeReasons: [], status: 429 };
    expect(applyDirectPlayOnlyGuard(result)).toBe(result);
  });
});
