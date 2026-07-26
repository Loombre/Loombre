// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/transcode-slots-exhausted.exception.ts
//
// RFC 9457 429 for POST /playback/sessions (docs/PLAYBACK.md §9,
// Phase 3 §11 step 6b): fires when the global count of active-ish
// transcode sessions (packages/db's countActiveTranscodeSessions — any
// non-terminal status whose stored plan's decision isn't 'direct-play')
// already meets or exceeds the resolved policy's
// `maxSimultaneousTranscodes`. Clients are expected to fall back to a
// lower-bitrate direct attempt or queue (docs/PLAYBACK.md §9's own
// language).

import { HttpException, HttpStatus } from "@nestjs/common";

export class TranscodeSlotsExhaustedException extends HttpException {
  constructor(instance: string) {
    super(
      {
        type: "urn:loombre:problem:transcode-slots-exhausted",
        title: "Transcode slots exhausted",
        status: HttpStatus.TOO_MANY_REQUESTS,
        detail:
          "The maximum number of simultaneous transcoding sessions is already in use. Try again shortly, or fall back to a lower-bitrate direct attempt.",
        instance,
        code: "transcode-slots-exhausted",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
