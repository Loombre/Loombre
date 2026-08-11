// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/vitest.config.ts
//
// Several suites here are self-sufficient live-DB tests (mirroring
// packages/db/vitest.config.ts's rationale): each resets+reseeds the shared
// database in its own beforeAll. Vitest runs test FILES in parallel by
// default, which would race concurrent `DROP SCHEMA public CASCADE` calls
// against the same database — so this package also forces sequential file
// execution.

// CI-runner time scaling, the same mechanism apps/worker/vitest.config.ts
// and the transcode integration suites already use (ci.yml sets
// LOOMBRE_TEST_TIME_SCALE=3, macOS 10; turbo passes it through globalEnv).
//
// HOOKS are the binding constraint here, not tests: nearly every e2e suite
// in this package resets and reseeds a live database from its beforeAll by
// spawning packages/db's migrate.mjs + seed.mjs. Vitest's fixed 10s default
// hookTimeout is comfortable on real hardware and NOT comfortable on a
// windows-latest runner — repeated Windows gate runs failed with
// "Hook timed out in 10000ms", and a hook killed mid-setup takes its fork
// down with it, which is what surfaced as the "Worker exited unexpectedly"
// pool errors in those same runs (all 943 tests passed; the run failed
// anyway). Locally the scale is 1, so both limits keep their stock values.
import { configDefaults, defineConfig } from "vitest/config";

const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 5_000 * TIME_SCALE,
    hookTimeout: 10_000 * TIME_SCALE,
    // Never collect a worktree's copy of these specs: a stray `.claude/
    // worktrees/**` collection would run a DUPLICATE of these live-DB suites
    // and race a concurrent `DROP SCHEMA public CASCADE` against the same
    // Postgres, dropping the schema out from under a live suite (the exact
    // mid-suite-401 flake this exclude — alongside the per-suite distinct DB
    // names — closes by construction).
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
  },
});
