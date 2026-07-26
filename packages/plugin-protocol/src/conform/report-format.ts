// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/conform/report-format.ts
//
// Human-readable pass/fail report for the CLI (mission: "Human-readable
// pass/fail report, non-zero exit on failure").

import { summarizeSeverity, type LppConformanceReport } from "./types.js";

const SEVERITY_MARK: Record<string, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

export function formatLppConformanceReport(report: LppConformanceReport): string {
  const lines: string[] = [];
  lines.push(`LPP conformance report — ${report.targetUrl}`);
  lines.push("");
  for (const suite of report.suites) {
    lines.push(`## ${suite.suite}`);
    for (const check of suite.checks) {
      const mark = SEVERITY_MARK[check.severity] ?? check.severity.toUpperCase();
      const detail = check.detail ? ` — ${check.detail}` : "";
      lines.push(`  [${mark}] ${check.id}: ${check.description}${detail}`);
    }
    lines.push("");
  }
  const { pass, warn, fail } = summarizeSeverity(report);
  lines.push(`${pass} passed, ${warn} warned, ${fail} failed`);
  lines.push(report.ok ? "RESULT: PASS" : "RESULT: FAIL");
  return lines.join("\n");
}
