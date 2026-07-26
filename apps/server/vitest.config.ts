// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/vitest.config.ts
//
// Several suites here are self-sufficient live-DB tests (mirroring
// packages/db/vitest.config.ts's rationale): each resets+reseeds the shared
// database in its own beforeAll. Vitest runs test FILES in parallel by
// default, which would race concurrent `DROP SCHEMA public CASCADE` calls
// against the same database — so this package also forces sequential file
// execution.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
