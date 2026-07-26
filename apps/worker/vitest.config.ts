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

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
