// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/support/require-wg.ts
//
// Same posture as apps/server/test/support/require-pebble.ts and
// apps/worker/test/support/require-ffmpeg.ts (Phase 3 step 7's lesson: a
// silent skip can masquerade as a green run forever). This lane's own
// packages/wg-native/test/support/require-wg.ts is the canonical version
// (mirrored here, not imported — apps/server's wg-gated e2e suites need
// the SAME detection + LOOMBRE_REQUIRE_WG escalation without adding a
// devDependency edge back onto @loombre/wg-native's test-only exports).

import { WgNativeClient } from "@loombre/wg-native";

export function wgAvailable(): boolean {
  const client = WgNativeClient.load();
  const ok = client !== undefined;
  if (!ok && process.env["LOOMBRE_REQUIRE_WG"]) {
    throw new Error(
      "LOOMBRE_REQUIRE_WG is set but the native wg-native library is not built/found " +
        "(packages/wg-native/dist/wg-native-<platform>-<arch>.*) — refusing to silently " +
        "skip the wg-gated e2e suite. Build it with: pnpm --filter @loombre/wg-native build " +
        "(requires a Go toolchain on PATH).",
    );
  }
  return ok;
}
