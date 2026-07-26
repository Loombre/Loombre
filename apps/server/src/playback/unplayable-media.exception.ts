// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/unplayable-media.exception.ts
//
// RFC 9457 409 for POST /playback/sessions (Phase 3 §11 step 6b — REPLACES
// the Phase 2 requires-transcoding.exception.ts concept, deleted). Fires
// ONLY when the computed PlaybackPlan is genuinely unplayable: `decision
// === 'transcode'` but `ffmpegArgs` is empty (tone-map-refused-by-policy,
// or a degenerate empty-ladder plan — docs/PLAYBACK.md §3's "the session
// layer surfaces the failure" seam; packages/playback-engine/src/plan.ts's
// own assembly comment names both cases). Every OTHER non-direct-play
// decision (direct-stream, remux, a real transcode with a real ladder) now
// succeeds (201) instead — the old Phase 2 "not direct-playable -> 409 for
// literally any transcode-requiring media" behavior is gone.
//
// Carries the plan's own REAL (not hypothetical) `PlanReason[]` as an
// additive Problem extension member (RFC 9457 §3.2 allows extension
// members; packages/contract/openapi.yaml's Problem schema is
// additionalProperties: true for exactly this reason).

import { HttpException, HttpStatus } from "@nestjs/common";
import type { PlanReason } from "@loombre/playback-engine";

export class UnplayableMediaException extends HttpException {
  constructor(reasons: PlanReason[], instance: string) {
    super(
      {
        type: "urn:loombre:problem:unplayable-media",
        title: "Media cannot be played",
        status: HttpStatus.CONFLICT,
        detail:
          "This media's computed transcode plan was refused (e.g. tone-mapping refused by policy) or produced no usable output — it cannot be played on this device.",
        instance,
        code: "media-unplayable",
        reasons,
      },
      HttpStatus.CONFLICT,
    );
  }
}
