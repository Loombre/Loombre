// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/vitest.config.ts
//
// Every live-DB spec in test/*.spec.ts is self-sufficient: each resets the
// database schema (`scripts/migrate.mjs reset`) in its own beforeAll (see
// test/leak.spec.ts's header for the rationale). Vitest runs test FILES in
// parallel by default, which would race two concurrent
// `DROP SCHEMA public CASCADE` calls against the same live database — so
// this package forces sequential file execution.

import { defineConfig } from 'vitest/config';

// CI-runner time scaling (same mechanism as apps/server + apps/worker;
// ci.yml sets LOOMBRE_TEST_TIME_SCALE=3, macOS 10, passed through turbo's
// globalEnv). Those per-file `migrate.mjs reset` beforeAll hooks spawn a
// child process and rebuild the whole schema — comfortably under vitest's
// fixed 10s default hookTimeout on real hardware, not comfortably so on a
// slow CI runner. Locally the scale is 1, so both limits keep their stock
// values and nothing about these tests changes.
const TIME_SCALE = Math.max(1, Number(process.env['LOOMBRE_TEST_TIME_SCALE'] ?? '1') || 1);

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 5_000 * TIME_SCALE,
    hookTimeout: 10_000 * TIME_SCALE,
  },
});
