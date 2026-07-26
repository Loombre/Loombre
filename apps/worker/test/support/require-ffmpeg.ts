// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/support/require-ffmpeg.ts
//
// Phase 3 step 7 finding: every ffmpeg-gated suite (probe/session/subtitle/
// battery integration) silently `describe.skipIf`-skipped on ALL THREE CI
// runners because ci.yml never installed ffmpeg — while the Phase 3 exit
// gate requires "Session integration green on 3 OS runners". CI now
// installs ffmpeg AND sets LOOMBRE_REQUIRE_FFMPEG=1 on the gate job; under
// that flag, an unresolvable ffmpeg is a HARD FAILURE here (thrown at
// module load, failing the suite loudly) instead of a silent skip — a
// runner misconfiguration can never again masquerade as a green run.
// Local dev without ffmpeg keeps the graceful skip.
import { resolveFfmpeg } from "../../src/probe/ffprobe.js";

export function ffmpegAvailableStrict(): boolean {
  const resolved = resolveFfmpeg();
  if (!resolved.ok && process.env["LOOMBRE_REQUIRE_FFMPEG"]) {
    throw new Error(
      "LOOMBRE_REQUIRE_FFMPEG is set but ffmpeg is not resolvable (LOOMBRE_FFMPEG env / PATH) — " +
        "refusing to silently skip ffmpeg-gated suites (Phase 3 exit gate: integration green on 3 OS runners)",
    );
  }
  return resolved.ok;
}
