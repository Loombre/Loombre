// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/conform/types.ts
//
// Result shapes shared by every conformance suite (manifest-checks.ts,
// metadata-provider-suite.ts, event-subscriber-suite.ts) and their
// orchestrator (run.ts). Three severities, not two: `warn` exists
// specifically for the mission's SHOULD-level checks (event-subscriber
// tamper/replay rejection) — a plugin that doesn't reject a tampered batch
// is not LPP-INVALID, just less defensive than recommended, and the CLI
// must not fail a build over it.

export type LppCheckSeverity = "pass" | "warn" | "fail";

export interface LppCheckResult {
  /** Stable dotted id, e.g. "metadata-provider.search.schema". */
  id: string;
  description: string;
  severity: LppCheckSeverity;
  detail?: string;
}

export interface LppSuiteReport {
  suite: string;
  checks: LppCheckResult[];
}

export interface LppConformanceReport {
  targetUrl: string;
  generatedAtMs: number;
  manifest: unknown;
  suites: LppSuiteReport[];
  /** false iff any check across any suite is "fail". `warn` never flips this. */
  ok: boolean;
}

export function summarizeSeverity(report: LppConformanceReport): { pass: number; warn: number; fail: number } {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const suite of report.suites) {
    for (const check of suite.checks) {
      if (check.severity === "pass") pass++;
      else if (check.severity === "warn") warn++;
      else fail++;
    }
  }
  return { pass, warn, fail };
}

export function isConformanceOk(report: LppConformanceReport): boolean {
  return report.suites.every((suite) => suite.checks.every((check) => check.severity !== "fail"));
}
