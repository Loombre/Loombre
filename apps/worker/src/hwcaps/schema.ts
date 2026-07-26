// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The ONE shared structural validator for docs/PLAYBACK.md §2.5's
 * `VerifiedCapabilities` shape (binding constraint 6 — Phase 3 §11 step 5,
 * P3.3 exit-gate item). Used by test/hwcaps/conformance.spec.ts to validate
 * BOTH every packages/playback-engine/matrix/fixtures/caps.yaml fixture set
 * AND a real probe-produced `VerifiedCapabilities` object through the exact
 * same code path — proving the probe reproduces the fixture schema exactly,
 * rather than merely "looking similar" by eye.
 *
 * Deliberately reimplemented from first principles (no ajv/zod/yup
 * dependency): the closed value sets are five short literal arrays, and a
 * hand-rolled structural check is both trivial to get right here and keeps
 * this package's dependency footprint unchanged (CLAUDE.md invariant on
 * license-clean, minimal deps — see also caps-yaml.ts's header for the
 * matching decision on the YAML side).
 */

const VALID_BACKENDS = ["videotoolbox", "qsv", "vaapi", "nvenc", "amf", "d3d11va", "software"] as const;
const VALID_DECODE_CODECS = ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4", "unknown"] as const;
const VALID_ENCODE_CODECS = ["h264", "hevc", "av1"] as const;
const VALID_TONE_MAP_METHODS = ["opencl", "vulkan", "videotoolbox", "cuda", "none"] as const;

export interface SchemaViolation {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: SchemaViolation[];
}

function isStringArraySubsetOf(value: unknown, allowed: readonly string[]): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && (allowed as readonly string[]).includes(v));
}

function checkStringArraySubset(
  value: unknown,
  allowed: readonly string[],
  path: string,
  violations: SchemaViolation[]
): void {
  if (!Array.isArray(value)) {
    violations.push({ path, message: `expected an array, got ${typeof value}` });
    return;
  }
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== "string" || !(allowed as readonly string[]).includes(entry)) {
      violations.push({ path: `${path}[${i}]`, message: `"${String(entry)}" is not one of ${allowed.join(", ")}` });
    }
  }
}

/**
 * Validates one candidate object against the §2.5 `VerifiedCapabilities`
 * shape: `{ backends: Array<{ backend: <enum>, decode: <VideoCodec[]>,
 * encode: <{h264,hevc,av1}[]>, toneMap: <{opencl,vulkan,videotoolbox,cuda,
 * none}[]>, verifiedAtMs: number }> }`. Structural only (extra unknown
 * properties on an object are ignored, matching how the real DB-round-trip
 * and YAML-parsed shapes both carry a couple of harmless extras) — every
 * REQUIRED field and its closed value set is checked exhaustively.
 */
export function validateVerifiedCapabilities(candidate: unknown): ValidationResult {
  const violations: SchemaViolation[] = [];

  if (typeof candidate !== "object" || candidate === null) {
    return { valid: false, violations: [{ path: "$", message: "expected an object" }] };
  }
  const obj = candidate as Record<string, unknown>;
  if (!Array.isArray(obj["backends"])) {
    return { valid: false, violations: [{ path: "$.backends", message: "expected an array" }] };
  }

  for (const [i, entry] of (obj["backends"] as unknown[]).entries()) {
    const path = `$.backends[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      violations.push({ path, message: "expected an object" });
      continue;
    }
    const b = entry as Record<string, unknown>;

    if (typeof b["backend"] !== "string" || !(VALID_BACKENDS as readonly string[]).includes(b["backend"])) {
      violations.push({ path: `${path}.backend`, message: `"${String(b["backend"])}" is not one of ${VALID_BACKENDS.join(", ")}` });
    }
    checkStringArraySubset(b["decode"], VALID_DECODE_CODECS, `${path}.decode`, violations);
    checkStringArraySubset(b["encode"], VALID_ENCODE_CODECS, `${path}.encode`, violations);
    checkStringArraySubset(b["toneMap"], VALID_TONE_MAP_METHODS, `${path}.toneMap`, violations);
    if (typeof b["verifiedAtMs"] !== "number" || !Number.isFinite(b["verifiedAtMs"])) {
      violations.push({ path: `${path}.verifiedAtMs`, message: `expected a finite number, got ${typeof b["verifiedAtMs"]}` });
    }
  }

  return { valid: violations.length === 0, violations };
}

// Re-exported for tests that want to assert against the closed sets
// directly (e.g. "every fixture's backend values are drawn from exactly
// this list, no more no less").
export { VALID_BACKENDS, VALID_DECODE_CODECS, VALID_ENCODE_CODECS, VALID_TONE_MAP_METHODS, isStringArraySubsetOf };
