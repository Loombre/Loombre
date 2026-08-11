// SPDX-License-Identifier: AGPL-3.0-only
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Matrix project — `pnpm run test:matrix`. Runs matrix.spec.ts (the
 * burn-up runner, docs/PLAYBACK.md §11 step 1 / STATE.md P3.2 — fully
 * burned up, every case green; matrix/burnup.json is the single source of
 * truth for the count, deliberately not restated here) and
 * properties.spec.ts (the §10 property-test harness). Both are kept out
 * of the default `test` project (vitest.config.ts, which only includes
 * matrix-meta.spec.ts) so the two projects stay independently runnable —
 * originally so `pnpm gate` stayed green while the matrix was still
 * burning up.
 */
export default defineConfig({
  test: {
    include: ["matrix/matrix.spec.ts", "matrix/properties.spec.ts"],
    // Never collect a worktree's copy of these specs (see
    // apps/server/vitest.config.ts's exclude comment).
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
  },
});
