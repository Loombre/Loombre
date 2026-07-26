// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";

/**
 * Default test project — runs in `pnpm gate` (`pnpm run test`). Includes the
 * green matrix-meta.spec.ts (STATE.md D22) but deliberately excludes
 * matrix.spec.ts, which is the genuinely-red Phase-0 exit proof and runs
 * only via `pnpm run test:matrix` (vitest.matrix.config.ts).
 */
export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts", "matrix/matrix-meta.spec.ts"],
  },
});
