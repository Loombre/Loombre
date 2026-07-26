// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/corruption.ts
//
// Classification logic is grounded in REAL captured pg_controldata output
// from the actual vendored 17.10.0/16.14.0 binaries on this host (see this
// lane's report for the raw transcripts), not guessed from documentation:
//
//   - A pg_control file TRUNCATED mid-write (the textbook "disk full /
//     process killed during initdb" signature per @loombre/provisioning's
//     own CorruptionReason doc comment) makes pg_controldata exit 1 with
//     `could not read file "..." : read 100 of 296` — classified
//     'incomplete-initdb'.
//   - A pg_control file that is FULL SIZE but bit-corrupted makes
//     pg_controldata print `WARNING: Calculated CRC checksum does not
//     match value stored in file` and STILL EXIT 0 (it prints the
//     untrustworthy contents anyway) — classified 'checksum-failure'.
//     Exit-code alone is therefore NOT sufficient; every classification
//     rule here inspects combined stdout+stderr text.
//   - A missing pg_control file (existsSync false) makes pg_controldata
//     exit 1 with `could not open file "..." : No such file or directory`
//     — this package never gets that far because detectCorruption()
//     checks file existence itself first (see below) and can therefore
//     report the more specific reason directly from fs state rather than
//     parsing that message.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CorruptionReason, CorruptionReport } from "@loombre/provisioning";
import type { VendorBinaries } from "./binaries.js";
import { runBinary } from "./exec.js";

export interface ControlDataProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SHORT_READ_PATTERN = /could not read file .* read \d+ of \d+/i;
const CRC_MISMATCH_PATTERN = /Calculated CRC checksum does not match/i;
const PERMISSION_DENIED_PATTERN = /permission denied/i;
const DISK_FULL_PATTERN = /no space left on device/i;

/** Pure: classifies an already-captured pg_controldata invocation. Returns
 *  'healthy' when nothing in the output indicates corruption (exit 0, no
 *  CRC warning) — the caller (detectCorruption) treats that as "not
 *  corrupt", not as a CorruptionReason. */
export function classifyControlDataOutput(result: ControlDataProbeResult): CorruptionReason | "healthy" {
  const combined = `${result.stdout}\n${result.stderr}`;

  // Checked BEFORE the exit-code branch: the CRC-mismatch case exits 0.
  if (CRC_MISMATCH_PATTERN.test(combined)) return "checksum-failure";

  if (result.exitCode === 0) return "healthy";

  if (SHORT_READ_PATTERN.test(combined)) return "incomplete-initdb";
  if (PERMISSION_DENIED_PATTERN.test(combined)) return "permission-denied";
  if (DISK_FULL_PATTERN.test(combined)) return "disk-full";
  return "unknown";
}

/** Pure: classifies a failed SERVER STARTUP attempt (postgres exited before
 *  reaching ready, and pg_controldata itself reported a healthy control
 *  file) — the remaining case in @loombre/provisioning's enum this leaves
 *  uncovered is crash-recovery-failed. */
export function classifyStartupFailureLog(log: string): CorruptionReason {
  const looksLikeRecoveryFailure =
    /(FATAL|PANIC)/.test(log) && /(recovery|redo record|checkpoint record|could not locate a valid checkpoint)/i.test(log);
  if (looksLikeRecoveryFailure) return "crash-recovery-failed";
  return "unknown";
}

function nowMs(): number {
  return Date.now();
}

/**
 * I/O: the full corruption-detection sweep. Returns null when the data
 * directory is healthy (from this check's point of view — the caller may
 * still find OTHER problems, e.g. a startup timeout with a healthy control
 * file, which is where classifyStartupFailureLog above comes in instead).
 */
export async function detectCorruption(params: {
  dataDir: string;
  pinnedMajor: number;
  binaries: VendorBinaries;
}): Promise<CorruptionReport | null> {
  const { dataDir, pinnedMajor, binaries } = params;

  if (!existsSync(dataDir)) {
    return { reason: "missing-data-dir", dataDir, detectedAtMs: nowMs() };
  }

  const pgVersionPath = join(dataDir, "PG_VERSION");
  if (!existsSync(pgVersionPath)) {
    return { reason: "missing-version-file", dataDir, detectedAtMs: nowMs() };
  }

  const versionContent = readFileSync(pgVersionPath, "utf8").trim();
  const actualMajor = Number.parseInt(versionContent, 10);
  if (!Number.isInteger(actualMajor) || actualMajor !== pinnedMajor) {
    return {
      reason: "pg-version-mismatch",
      dataDir,
      detectedAtMs: nowMs(),
      detail: `PG_VERSION contains "${versionContent}", pinned major is ${pinnedMajor}`,
    };
  }

  const probe = await runBinary(binaries.pgControldata, ["-D", dataDir], { libDir: binaries.libDir, timeoutMs: 10_000 });
  const classification = classifyControlDataOutput(probe);
  if (classification === "healthy") return null;

  return {
    reason: classification,
    dataDir,
    detectedAtMs: nowMs(),
    detail: `${probe.stdout}\n${probe.stderr}`.trim().slice(0, 2000),
  };
}
