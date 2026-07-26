// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turns a `BatteryResult` (battery.ts) into the §2.5 `VerifiedCapabilities`
 * shape (PASS-only subjects — persisted + handed to the engine) and into a
 * human-readable text table (the operator script's stdout, and the source
 * material for reports/hw-verify-<platform>.md).
 */
import type { BatteryResult } from "./battery.js";
import type { BackendReport, ProbeReport, TestOutcome, TestResult } from "./types.js";

export interface VerifiedCapabilitiesBackendLike {
  backend: string;
  decode: string[];
  encode: string[];
  toneMap: string[];
  verifiedAtMs: number;
}

export interface VerifiedCapabilitiesLike {
  backends: VerifiedCapabilitiesBackendLike[];
}

function passedSubjects<Subject extends string>(results: TestResult<Subject>[]): Subject[] {
  return results.filter((r) => r.outcome === "pass").map((r) => r.subject);
}

/** Extracts the §2.5 `VerifiedCapabilities` shape from a battery result —
 *  only PASSing tests contribute a capability; fail/timeout/skipped all
 *  mean "capability absent" (docs/PLAYBACK.md §8.1: "any failure or
 *  timeout = capability absent"). Backend order is preserved exactly
 *  (already platform-candidate order by construction — battery.ts never
 *  reorders `deps.backends`). */
export function toVerifiedCapabilities(result: BatteryResult): VerifiedCapabilitiesLike {
  return {
    backends: result.backends.map((b) => ({
      backend: b.backend,
      decode: passedSubjects(b.decode),
      encode: passedSubjects(b.encode),
      toneMap: passedSubjects(b.toneMap),
      verifiedAtMs: b.verifiedAtMs,
    })),
  };
}

const OUTCOME_GLYPH: Record<TestOutcome, string> = {
  pass: "PASS",
  fail: "FAIL",
  timeout: "TIMEOUT",
  skipped: "SKIP",
};

function formatResults<Subject extends string>(label: string, results: TestResult<Subject>[]): string[] {
  if (results.length === 0) return [`  ${label}: (no candidates)`];
  return results.map((r) => {
    const base = `  ${label} ${r.subject}: ${OUTCOME_GLYPH[r.outcome]}`;
    return r.detail ? `${base} — ${r.detail}` : base;
  });
}

function formatBackend(report: BackendReport): string[] {
  const lines: string[] = [`[${report.position}] ${report.backend}`];
  lines.push(...formatResults("decode ", report.decode));
  lines.push(...formatResults("encode ", report.encode));
  lines.push(...formatResults("tonemap", report.toneMap));
  return lines;
}

/** Human-readable report text — the operator script (`pnpm --filter
 *  @loombre/worker run hwprobe`) prints exactly this to stdout. */
export function formatProbeReport(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push(`Loombre hardware capability self-test — ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push(`platform:           ${report.platform}`);
  lines.push(`ffmpeg path:        ${report.ffmpegPath}`);
  lines.push(`ffmpeg build hash:  ${report.ffmpegBuildHash}`);
  lines.push(`gpu fingerprint:    ${report.gpuFingerprint || "(unavailable — '' sentinel)"}`);
  lines.push("");
  for (const backend of report.backends) {
    lines.push(...formatBackend(backend));
    lines.push("");
  }
  return lines.join("\n");
}
