// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";

/**
 * Matrix project — `pnpm run test:matrix`. Runs matrix.spec.ts (the
 * burn-up runner, docs/PLAYBACK.md §11 step 1 / STATE.md P3.2 — fully
 * burned up: 512/512 cases green, tracked by matrix/burnup.json) and
 * properties.spec.ts (the §10 property-test harness). Both are kept out
 * of the default `test` project (vitest.config.ts, which only includes
 * matrix-meta.spec.ts) so the two projects stay independently runnable —
 * originally so `pnpm gate` stayed green while the matrix was still
 * burning up.
 */
export default defineConfig({
  test: {
    include: ["matrix/matrix.spec.ts", "matrix/properties.spec.ts"],
  },
});
