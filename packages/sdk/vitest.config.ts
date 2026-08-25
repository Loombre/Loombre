// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/sdk/vitest.config.ts
//
// d3-e6: this package had no runtime test runner at all — its `test` script
// was `tsc -p tsconfig.test.json`, which typechecks src + test and executes
// nothing. The hand-authored half of the SDK (src/client.ts:
// LoombreApiError's RFC 9457 message precedence, LoombreClient's single
// fetch seam) could therefore only be guarded from apps/web's specs, at a
// distance, against the BUILT dist — so a regression in the wrapper showed
// up as a failure in another package, or not at all.
//
// The type-level half is NOT replaced by this: `pnpm --filter @loombre/sdk
// test` now runs `tsc -p tsconfig.test.json && vitest run`, both halves, in
// that order. test/success-response-for.test-d.ts stays exactly what it was
// (a `.test-d.ts` file, deliberately outside vitest's default `include`
// pattern, with nothing to execute).
//
// `include` is pinned to `test/` rather than left at the default glob for
// one reason worth stating: `src/generated/` is codegen output (packages/
// contract/scripts/codegen.mjs rewrites that directory wholesale on every
// `pnpm --filter @loombre/contract codegen`). Tests live in `test/`, which
// codegen never touches, and this config makes that separation the runner's
// rule rather than a convention someone could drift from.

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Never collect a worktree's copy of these specs (see
    // apps/server/vitest.config.ts's exclude comment).
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**", "dist/**"],
  },
});
