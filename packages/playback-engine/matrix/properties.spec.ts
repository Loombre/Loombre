// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Property-test harness (docs/PLAYBACK.md §10 "Mandatory property tests" /
 * §11 step 1). Part of `pnpm test:matrix` — NOT the gate (vitest.config.ts's
 * include list only names matrix-meta.spec.ts, never this file).
 *
 * All four §10 properties run against a seeded, deterministic PRNG
 * (mulberry32 — matrix/lib/prng.ts) generating random VALID PlanInputs
 * across the full §2 type space (matrix/lib/generators.ts). No unseeded
 * Math.random anywhere in this file or its generators — same seed, same
 * sequence, forever.
 *
 * Gating (STATE.md P3.9d): matrix/burnup.json is the single source of truth
 * for "has plan() started being implemented yet". While it lists 0 green
 * cases, plan() is NotImplementedError for everything, so each property
 * test runs in "harness-proves-wiring" mode: it asserts plan() throws
 * NotImplementedError on the property's own generated inputs. Once >=1 case
 * is green, the real property assertion runs instead — gated via a single
 * `planImplemented` boolean derived from the manifest, so a future Stage
 * A's PR only has to flip burnup.json entries; this file needs no edits to
 * make that transition.
 *
 * Direct-play bias (property 2) is called out by STATE.md P3.1 as expected
 * to go green starting Stage A specifically — its generator
 * (genDirectPlayInput) constructs inputs where literally every stage should
 * verdict copy/none, which is exactly the behavior Stage A introduces.
 */
import { describe, expect, it } from "vitest";
import { stableStringify } from "@loombre/shared";
import { NotImplementedError, plan } from "../src/index.js";
import { BLOCKING_REASON_CODES } from "../src/reasons.js";
import type { PlanInput } from "../src/types.js";
import { hasAnyGreen, loadBurnupManifest } from "./lib/burnup.js";
import { genDirectPlayInput, genRandomPlanInput } from "./lib/generators.js";
import { mulberry32, type Rng } from "./lib/prng.js";
import { validatePlan } from "./lib/validate-plan.js";

const DETERMINISM_SAMPLE_SIZE = 1000;
const TOTALITY_SAMPLE_SIZE = 1000;
const REASON_COMPLETENESS_SAMPLE_SIZE = 1000;
const DIRECT_PLAY_SAMPLE_SIZE = 500;

const manifest = loadBurnupManifest();
const planImplemented = hasAnyGreen(manifest);

if (!planImplemented) {
  // process.stdout.write, not console.log — collection-time console output
  // is swallowed by vitest's interception.
  process.stdout.write("property harness armed, awaiting Stage A\n");
}

function samples(seed: number, n: number, gen: (rng: Rng) => PlanInput): PlanInput[] {
  const rng = mulberry32(seed);
  const out: PlanInput[] = [];
  for (let i = 0; i < n; i++) out.push(gen(rng));
  return out;
}

describe("playback matrix property tests (docs/PLAYBACK.md §10)", () => {
  it("(1) determinism — 1000 random valid inputs, plan twice, stableStringify byte-equal", () => {
    const inputs = samples(0xd0000001, DETERMINISM_SAMPLE_SIZE, genRandomPlanInput);

    if (!planImplemented) {
      for (const input of inputs) {
        expect(() => plan(input)).toThrow(NotImplementedError);
      }
      return;
    }

    for (const input of inputs) {
      const first = stableStringify(plan(structuredClone(input)));
      const second = stableStringify(plan(structuredClone(input)));
      expect(second).toBe(first);
    }
  });

  it("(2) direct-play bias — every stage passes ⇒ decision==='direct-play' && reasons.length===0", () => {
    const inputs = samples(0xd0000002, DIRECT_PLAY_SAMPLE_SIZE, genDirectPlayInput);

    if (!planImplemented) {
      for (const input of inputs) {
        expect(() => plan(input)).toThrow(NotImplementedError);
      }
      return;
    }

    for (const input of inputs) {
      const result = plan(input);
      expect(result.decision).toBe("direct-play");
      expect(result.reasons).toHaveLength(0);
    }
  });

  it("(3) totality — random inputs never throw, output always validates structurally", () => {
    const inputs = samples(0xd0000003, TOTALITY_SAMPLE_SIZE, genRandomPlanInput);

    if (!planImplemented) {
      for (const input of inputs) {
        expect(() => plan(input)).toThrow(NotImplementedError);
      }
      return;
    }

    for (const input of inputs) {
      let result;
      expect(() => {
        result = plan(input);
      }).not.toThrow();
      expect(() => validatePlan(result!)).not.toThrow();
    }
  });

  it("(4) reason completeness — decision!=='direct-play' ⇒ >=1 blocking-class reason", () => {
    const inputs = samples(0xd0000004, REASON_COMPLETENESS_SAMPLE_SIZE, genRandomPlanInput);

    if (!planImplemented) {
      for (const input of inputs) {
        expect(() => plan(input)).toThrow(NotImplementedError);
      }
      return;
    }

    for (const input of inputs) {
      const result = plan(input);
      if (result.decision !== "direct-play") {
        const hasBlocking = result.reasons.some((r) =>
          (BLOCKING_REASON_CODES as readonly string[]).includes(r.code),
        );
        expect(
          hasBlocking,
          `decision=${result.decision} but no blocking-class reason in ${JSON.stringify(result.reasons)}`,
        ).toBe(true);
      }
    }
  });
});
