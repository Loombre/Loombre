// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `plan()` — the pure PlaybackPlan decision function (docs/PLAYBACK.md).
 * All seven stages (A-G) are real as of Phase 3 §11 step 3; the arg
 * builder + 25 goldens landed at step 4 (27 goldens since step 7b fix F4
 * added the two vaapi burn-in graphs; 28 since the step-7 owner-smoke VT
 * tone-map real-execution fix added the hybrid-deinterlace graph); the
 * hardware capability probe at step 5. `plan()` is TOTAL — it never throws on any structurally valid
 * PlanInput (docs/PLAYBACK.md §10 property 3).
 *
 * Phase 3 §11 step 6b (this package's LAST Phase-2 seam removed):
 * `src/compat-preview.ts`'s `checkStaticCompat()` (STATE.md P2.17 — a thin,
 * SIMPLIFIED preview of Stages A-D/subtitle-renderability, built because
 * Phase 2 had no real `plan()` to call) is DELETED, along with its test
 * file and this barrel's export line. apps/server's playback module now
 * calls the real `plan()` for every request (POST /playback/plan, session
 * create) — the engine no longer has a Phase-2-only stand-in seam at all.
 */
export * from "./types.js";
export * from "./reasons.js";

export * from "./plan.js";

/** LD-3: the ONE definition of "this copy must be stripped of Dolby
 *  Vision", shared by Stage C (the reason) and the arg builder (the flags)
 *  so the two can never again disagree. Exported so the worker's
 *  real-ffmpeg regression fence can assert against the same predicate the
 *  engine decides with. */
export * from "./dv.js";

/** LD-7/LD-16: the ONE definition of "may this box encode AV1, and what
 *  happens to a rung when it may not" (docs/PLAYBACK.md §7.2), shared by
 *  ladder construction and Stage G exactly as `dv.ts` is shared by Stage C
 *  and the arg builder. Exported so the worker's real-ffmpeg fences and
 *  apps/server's contract drift guard can assert against the same
 *  predicate the engine decides with, rather than a re-derivation. */
export * from "./av1.js";

/**
 * Phase 3 §11 step 6a (worker-side transcode session runtime) BARREL
 * ADDITION — reported per this step's purity fence ("if a builder OPTION
 * is genuinely missing for seek/readrate, report — do NOT edit
 * playback-engine"): `buildFfmpegArgs` (src/args/builder.ts, landed Step 4)
 * was never re-exported from this package's public entry point at all —
 * `plan()`'s own internal call site was the only consumer. The session
 * layer's seek-restart path (docs/PLAYBACK.md §9, this step's binding
 * constraint 5: "regenerate args via buildFfmpegArgs with withSeek true")
 * needs to call the SAME pure function directly. This is an export-only
 * addition — zero lines of src/args/builder.ts, src/plan.ts, matrix cases,
 * or goldens changed; the function's behavior, signature, and every
 * existing golden/property test are untouched.
 */
export { buildFfmpegArgs } from "./args/builder.js";
export type { FfmpegPlanShape, BuildFfmpegArgsOptions } from "./args/builder.js";

/**
 * C1 fable-review finding 3 (LOW, owner-adopted 2026-08-11): the worker's
 * probe battery carries a MIRROR of the builder's encoder-name table
 * (apps/worker/src/hwcaps/tables.ts) — the names it spawns to VERIFY a
 * capability must be the names this package spawns to USE it, or the box
 * verifies one encoder and runs another. Until now that mirror was
 * enforced by comments in both files pointing at each other. Exporting the
 * table lets `apps/worker/test/hwcaps/encoder-name-mirror.spec.ts` assert
 * the equality per backend × codec against the real thing, the same way
 * `dv.ts`/`av1.ts` are exported so the worker's fences can assert against
 * the engine's own predicates rather than a re-derivation.
 */
export { VIDEO_ENCODER_NAMES } from "./args/builder.js";

/**
 * Kept exported for source compatibility with the Phase-0/Wave-1 scaffold
 * (matrix-meta.spec.ts and matrix.spec.ts both import this class and check
 * `err instanceof NotImplementedError`). Nothing in src throws it anymore
 * as of Phase 3 Step 2a — plan() is total — but the class stays available
 * so those "if it ever throws NotImplementedError, treat that specific
 * case as red" call sites keep type-checking without edits.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
