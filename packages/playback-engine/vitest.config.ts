// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";

/**
 * Default test project — runs in `pnpm gate` (`pnpm run test`). Includes
 * matrix-meta.spec.ts (STATE.md D22) but deliberately excludes
 * matrix.spec.ts — the burn-up runner, which runs only via
 * `pnpm run test:matrix` (vitest.matrix.config.ts). Historical note: the
 * split dates from Phase 0, when matrix.spec.ts was the genuinely-red
 * exit proof; the matrix has long since burned up (513/513 green — see
 * matrix/burnup.json for the current state) and the split is kept so the
 * two projects stay independently runnable.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts", "matrix/matrix-meta.spec.ts"],
  },
});
