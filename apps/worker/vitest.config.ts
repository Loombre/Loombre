// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/vitest.config.ts
//
// Mirrors packages/db/vitest.config.ts: the scan/probe/metadata/image
// live-DB specs each reset the database schema in their own beforeAll
// (self-sufficient, same convention as packages/db/test/*.spec.ts), which
// would race if vitest ran test files in parallel — so this package forces
// sequential file execution too. turbo's `test` task depends on `^test`
// (workspace dependencies' test tasks), and this package depends on
// @loombre/db, so packages/db's own schema-resetting specs finish before
// this package's specs start.

import { configDefaults, defineConfig } from "vitest/config";

// CI-runner time scaling, same mechanism as apps/worker/test/transcode/
// session.integration.spec.ts's per-test deadlines (which ci.yml already
// feeds via LOOMBRE_TEST_TIME_SCALE=3, macOS 10, passed through turbo's
// globalEnv). This package's image specs do REAL sharp encode work —
// variant-job.spec.ts runs 9 tests in ~0.7s on real hardware but took
// 13.4s on a 3-core virtualized ubuntu runner, blowing vitest's fixed 5s
// default on a single AVIF-heavy case. Scaling the default timeout keeps
// every assertion identical and only widens the patience on slow runners;
// locally the scale is 1, so the timeout stays exactly 5s.
const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 5_000 * TIME_SCALE,
    hookTimeout: 10_000 * TIME_SCALE,
    // Never collect a worktree's copy of these live-DB specs (see
    // apps/server/vitest.config.ts's exclude comment).
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
  },
});
