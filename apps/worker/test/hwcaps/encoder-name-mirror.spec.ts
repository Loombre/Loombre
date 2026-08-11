// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/hwcaps/encoder-name-mirror.spec.ts
//
// C1 fable-review finding 3 (LOW, owner-adopted 2026-08-11). The probe
// battery's encoder-name table (src/hwcaps/tables.ts) is a MIRROR of the
// plan arg builder's (packages/playback-engine/src/args/builder.ts): the
// battery spawns those names to VERIFY a capability, and the builder emits
// those names to USE it. Diverge by one character and the box verifies one
// encoder while every plan runs another — the exact failure the
// probe-proves-the-shipped-plumbing rule (docs/PLAYBACK.md §7.3, and
// interpretation D before it) exists to prevent.
//
// Until this spec, that mirror was enforced only by comments in the two
// files pointing at each other. The engine now EXPORTS its table from the
// public barrel (same reasoning as dv.ts/av1.ts: the worker asserts against
// the engine's own definition, never a re-derivation), so the agreement is
// mechanical in both directions — a rename on either side fails here.
//
// ONE deliberate asymmetry, asserted rather than excused: the worker's
// `software` row carries no `av1` key, because owner-decision D4
// (docs/PLAYBACK.md §7.3) narrowed the software av1 ENCODE test to
// `libsvtav1` alone and resolves the name through `resolveEncoderName`
// (which also feature-checks the resolved ffmpeg's `-encoders` listing).
// The name that resolver produces must still be the engine's — checked
// below against the real function, not against a copied literal.

import { describe, expect, it } from "vitest";
import { VIDEO_ENCODER_NAMES as ENGINE_ENCODER_NAMES } from "@loombre/playback-engine";
import { VIDEO_ENCODER_NAMES as PROBE_ENCODER_NAMES } from "../../src/hwcaps/tables.js";
import { resolveEncoderName } from "../../src/hwcaps/args.js";
import { ENCODE_TEST_CODECS, type HwBackend, type ProbeEncodeCodec } from "../../src/hwcaps/types.js";

/** Every backend either table may name (§8.2's full candidate list). Taken
 *  from the UNION of both tables' own keys rather than from a third literal
 *  list, so a backend added to one side and forgotten on the other is a
 *  failure here rather than an untested pair. */
const ALL_BACKENDS: HwBackend[] = Array.from(
  new Set([...Object.keys(PROBE_ENCODER_NAMES), ...Object.keys(ENGINE_ENCODER_NAMES)]),
) as HwBackend[];

/** The one pair the two tables deliberately express differently (D4, see
 *  the header): the worker resolves it dynamically. */
function isDynamicallyResolved(backend: HwBackend, codec: ProbeEncodeCodec): boolean {
  return backend === "software" && codec === "av1";
}

describe("probe battery <-> arg builder encoder-name mirror (C1 finding 3)", () => {
  it("the two tables name the same backends", () => {
    expect(Object.keys(PROBE_ENCODER_NAMES).sort()).toEqual(Object.keys(ENGINE_ENCODER_NAMES).sort());
  });

  it("every (backend x codec) pair resolves to the SAME encoder name in both tables", () => {
    const mismatches: string[] = [];
    for (const backend of ALL_BACKENDS) {
      for (const codec of ENCODE_TEST_CODECS) {
        if (isDynamicallyResolved(backend, codec)) continue;
        const probeName = PROBE_ENCODER_NAMES[backend]?.[codec];
        const engineName = ENGINE_ENCODER_NAMES[backend]?.[codec];
        if (probeName !== engineName) {
          mismatches.push(`${backend}/${codec}: probe=${String(probeName)} engine=${String(engineName)}`);
        }
      }
    }
    expect(mismatches, `encoder-name mirror drifted:\n${mismatches.join("\n")}`).toEqual([]);
  });

  it("the D4-narrowed software av1 resolver produces the engine's own software av1 encoder name", () => {
    const engineSoftwareAv1 = ENGINE_ENCODER_NAMES["software"]?.["av1"];
    expect(engineSoftwareAv1, "the engine must name a software av1 encoder").toBeTruthy();

    // Present in the resolved ffmpeg -> that exact name.
    expect(resolveEncoderName("software", "av1", new Set([engineSoftwareAv1!]))).toBe(engineSoftwareAv1);

    // D4's teeth: libaom-av1 alone is NOT the builder's encoder, so the
    // battery must report software av1 encode ABSENT rather than verifying
    // a capability the builder can never name.
    expect(resolveEncoderName("software", "av1", new Set(["libaom-av1"]))).toBeNull();

    // And the worker's static table deliberately leaves the pair out.
    expect(PROBE_ENCODER_NAMES["software"]?.["av1"]).toBeUndefined();
  });

  it("backends with NO av1 encoder are absent on BOTH sides (videotoolbox by construction, d3d11va decode-only)", () => {
    expect(ENGINE_ENCODER_NAMES["videotoolbox"]?.["av1"]).toBeUndefined();
    expect(PROBE_ENCODER_NAMES["videotoolbox"]?.["av1"]).toBeUndefined();
    expect(ENGINE_ENCODER_NAMES["d3d11va"]).toBeUndefined();
    expect(PROBE_ENCODER_NAMES["d3d11va"]).toBeUndefined();
  });

  it("every name either table does carry is a plausible ffmpeg encoder token (no empty strings, no whitespace)", () => {
    for (const table of [PROBE_ENCODER_NAMES, ENGINE_ENCODER_NAMES]) {
      for (const row of Object.values(table)) {
        for (const name of Object.values(row ?? {})) {
          expect(name).toMatch(/^[a-z0-9_-]+$/);
        }
      }
    }
  });
});
