// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Matrix case loader — docs/PLAYBACK.md §10.
 *
 * Cases live one-per-file in `matrix/NNN-*.yaml`. Shared device/policy/caps/
 * network fixtures live in `matrix/fixtures/*.yaml` and are referenced from a
 * case with `{ fixture: "<fixtureFile>.<key>" }` — deliberately the simplest
 * possible mechanism: an exact single-key `fixture` node is replaced with the
 * named fixture's value, recursively (no merging, no overrides). Anything
 * else is passed through untouched.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { LadderRung, PlanDecision, PlanInput, PlaybackPlan, SubtitleStrategy } from "../../src/types.js";
import type { PlanReasonCode } from "../../src/reasons.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MATRIX_DIR = join(__dirname, "..");
const FIXTURES_DIR = join(MATRIX_DIR, "fixtures");

const CASE_FILE_PATTERN = /^\d{3}-.+\.yaml$/;

export interface MatrixCaseExpect {
  decision: PlanDecision;
  reasons: PlanReasonCode[];
  subtitleStrategy?: SubtitleStrategy;
  ladderMaxVideoBitrateBps?: number;
  /** Optional §5 `container` field assertion (Phase 3 Step 2b bonus —
   *  closes the Step 2a "case-schema gap" Open note). One of the closed
   *  `PlaybackPlan.container` enum members: `'source'|'fmp4-hls'|'ts-hls'|
   *  'mp4'`. Asserted by matrix.spec.ts's assertCaseExpectations and
   *  schema-validated by matrix-meta.spec.ts when present; omitted cases are
   *  unaffected (no behavior change for the ~130+ cases that don't use it). */
  container?: PlaybackPlan["container"];
  /** Optional EXACT §7 `ladder` assertion (Phase 3 Step 2f bonus, mirrors
   *  `container` above): a full `LadderRung[]` deep-equal check against the
   *  produced plan's `ladder` field, in exact rung order. Distinct from
   *  `ladderMaxVideoBitrateBps` above (which only bounds the max surviving
   *  rung's bitrate) — this asserts the WHOLE surviving-rung list, used by
   *  cases that need to pin an exact construction result (e.g. the hevc-swap
   *  ordering proofs, a full surviving-rung-list case, and the refused ⇒ []
   *  case re-pinned at the matrix level). Asserted by matrix.spec.ts's
   *  assertCaseExpectations and shape-validated by matrix-meta.spec.ts when
   *  present; omitted cases are unaffected. */
  ladder?: LadderRung[];
}

export interface MatrixCase {
  /** filename, e.g. `001-direct-play-h264-aac-mp4.yaml` */
  file: string;
  name: string;
  why: string;
  input: PlanInput;
  expect: MatrixCaseExpect;
}

interface RawCaseDoc {
  name: string;
  why: string;
  input: unknown;
  expect: unknown;
}

const fixtureFileCache = new Map<string, Record<string, unknown>>();

function loadFixtureFile(fixtureFileName: string): Record<string, unknown> {
  const cached = fixtureFileCache.get(fixtureFileName);
  if (cached) return cached;
  const path = join(FIXTURES_DIR, `${fixtureFileName}.yaml`);
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw) as Record<string, unknown>;
  fixtureFileCache.set(fixtureFileName, parsed);
  return parsed;
}

/** Resolves `{ fixture: "file.key" }` reference nodes anywhere in a parsed document. */
function resolveFixtures(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => resolveFixtures(entry));
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === "fixture" && typeof obj["fixture"] === "string") {
      const ref = obj["fixture"];
      const dotIndex = ref.indexOf(".");
      if (dotIndex === -1) {
        throw new Error(`malformed fixture ref "${ref}" — expected "<file>.<key>"`);
      }
      const fixtureFileName = ref.slice(0, dotIndex);
      const fixtureKey = ref.slice(dotIndex + 1);
      const file = loadFixtureFile(fixtureFileName);
      if (!(fixtureKey in file)) {
        throw new Error(`fixture file "${fixtureFileName}" has no key "${fixtureKey}" (ref: "${ref}")`);
      }
      return resolveFixtures(file[fixtureKey]);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = resolveFixtures(obj[key]);
    }
    return out;
  }
  return node;
}

/** Every case filename in `matrix/`, sorted (the `NNN-` prefix fixes order). */
export function listCaseFiles(): string[] {
  return readdirSync(MATRIX_DIR)
    .filter((entry) => CASE_FILE_PATTERN.test(entry))
    .sort();
}

export function loadCase(file: string): MatrixCase {
  const raw = readFileSync(join(MATRIX_DIR, file), "utf8");
  const doc = parse(raw) as RawCaseDoc;
  const resolvedInput = resolveFixtures(doc.input) as PlanInput;
  const resolvedExpect = resolveFixtures(doc.expect) as MatrixCaseExpect;
  return {
    file,
    name: doc.name,
    why: doc.why,
    input: resolvedInput,
    expect: resolvedExpect,
  };
}

export function loadAllCases(): MatrixCase[] {
  return listCaseFiles().map(loadCase);
}
