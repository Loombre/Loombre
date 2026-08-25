// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/progress-body.test.ts
//
// d3-a4 (verify/gap-F6, P2): the ONE body builder for every PUT /progress
// write. The contract's ProgressUpdate declares integer positionMs and
// integer-or-null durationMs; an HLS element duration is fractional
// (observed live: 773347.5), and the heartbeat send() that passed it raw
// got every in-session write rejected 422 ('durationMs must be an integer
// or null') — 6x in one live session, progress silently frozen. Rounding
// lives HERE, at the source, shared by the heartbeat/pause/seek sends and
// the unload keepalive path alike.

import { describe, expect, it } from "vitest";
import { buildProgressBody } from "./progress-body.js";

describe("buildProgressBody (d3-a4)", () => {
  it("rounds fractional positionMs AND durationMs to integers — the live 422 shape", () => {
    expect(buildProgressBody({ positionMs: 42_000.6, durationMs: 773_347.5, state: "in-progress" })).toEqual({
      positionMs: 42_001,
      durationMs: 773_348,
      state: "in-progress",
    });
  });

  it("passes integer values through unchanged", () => {
    expect(buildProgressBody({ positionMs: 42_000, durationMs: 600_000, state: "played" })).toEqual({
      positionMs: 42_000,
      durationMs: 600_000,
      state: "played",
    });
  });

  it("keeps a null durationMs null (never 0, never dropped)", () => {
    const body = buildProgressBody({ positionMs: 5_000, durationMs: null, state: "in-progress" });
    expect(body.durationMs).toBeNull();
  });

  it("clamps a negative positionMs to 0 (contract minimum)", () => {
    expect(buildProgressBody({ positionMs: -3, durationMs: null, state: "unplayed" }).positionMs).toBe(0);
  });

  it("includes sessionId only when given — additionalProperties:false rejects stray keys", () => {
    const withSession = buildProgressBody({ positionMs: 0, durationMs: null, state: "unplayed" }, "01890000-0000-7000-8000-0000000000aa");
    expect(withSession.sessionId).toBe("01890000-0000-7000-8000-0000000000aa");
    const withoutSession = buildProgressBody({ positionMs: 0, durationMs: null, state: "unplayed" });
    expect("sessionId" in withoutSession).toBe(false);
  });
});
