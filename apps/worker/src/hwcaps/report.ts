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

/** How much of a failed test's stderr tail the report prints — the last
 *  few lines are where ffmpeg states the actual reason ("No device
 *  available for decoder", "Impossible to convert between the formats").
 *  An exit code alone sent a real diagnosis back to square one. */
const STDERR_TAIL_LINES = 4;

function formatResults<Subject extends string>(label: string, results: TestResult<Subject>[]): string[] {
  if (results.length === 0) return [`  ${label}: (no candidates)`];
  return results.flatMap((r) => {
    const base = `  ${label} ${r.subject}: ${OUTCOME_GLYPH[r.outcome]}`;
    const lines = [r.detail ? `${base} — ${r.detail}` : base];
    if (r.outcome !== "pass" && r.stderrTail) {
      const tail = r.stderrTail
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(-STDERR_TAIL_LINES);
      for (const line of tail) lines.push(`      | ${line}`);
    }
    return lines;
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
 *  @loombre/worker run hwprobe`) prints exactly this to stdout, and the
 *  worker's hwprobe job logs it, so a software-only outcome always arrives
 *  with its per-test reasons (and, on Linux, the device-access hints that
 *  usually explain them) instead of a bare "no accelerated paths". */
export function formatProbeReport(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push(`Loombre hardware capability self-test — ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push(`platform:           ${report.platform}`);
  lines.push(`ffmpeg path:        ${report.ffmpegPath}`);
  lines.push(`ffmpeg build hash:  ${report.ffmpegBuildHash}`);
  lines.push(`gpu fingerprint:    ${report.gpuFingerprint || "(unavailable — '' sentinel)"}`);
  lines.push("");
  if (report.deviceAccess) {
    lines.push("gpu device nodes (as seen by this process):");
    if (report.deviceAccess.devices.length === 0) {
      lines.push("  (none — no /dev/dri or /dev/nvidia* nodes)");
    }
    for (const d of report.deviceAccess.devices) {
      const vendor = d.vendor ?? d.vendorId ?? "-";
      lines.push(`  ${d.path}  ${d.kind}  ${vendor}  ${d.access === "rw" ? "accessible" : "DENIED"}${d.group ? `  (group ${d.group})` : ""}`);
    }
    for (const hint of report.deviceAccess.hints) {
      lines.push(`  ! ${hint}`);
    }
    lines.push("");
  }
  for (const backend of report.backends) {
    lines.push(...formatBackend(backend));
    lines.push("");
  }
  return lines.join("\n");
}
