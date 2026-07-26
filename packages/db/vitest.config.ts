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

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
