// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/test/support/require-wg.ts
//
// Same posture as apps/worker/test/support/require-ffmpeg.ts and
// apps/server/test/support/require-pebble.ts (Phase 3 step 7's lesson: a
// silent skip can masquerade as a green run forever). Every wg-gated suite
// needs a REAL Go toolchain to have built native/ into dist/ — most
// environments won't have Go installed, so the default posture is a
// graceful, LOUD skip. LOOMBRE_REQUIRE_WG=1 (ci.yml's gate job, after
// actions/setup-go + the wg-native build step) escalates an unresolvable
// library to a hard failure, so a misconfigured runner can never silently
// report these suites as "0 tests, fine" again.

import { WgNativeClient } from "../../src/index.js";

export function wgAvailable(): boolean {
  const client = WgNativeClient.load();
  const ok = client !== undefined;
  if (!ok && process.env["LOOMBRE_REQUIRE_WG"]) {
    throw new Error(
      "LOOMBRE_REQUIRE_WG is set but the native wg-native library is not built/found " +
        "(packages/wg-native/dist/wg-native-<platform>-<arch>.*) — refusing to silently " +
        "skip the wg-gated test suite. Build it with: pnpm --filter @loombre/wg-native build " +
        "(requires a Go toolchain on PATH).",
    );
  }
  return ok;
}
