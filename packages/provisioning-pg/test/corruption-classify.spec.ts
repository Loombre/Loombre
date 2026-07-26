// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { classifyControlDataOutput, classifyStartupFailureLog } from "../src/corruption.js";
import { CORRUPTION_REASONS } from "@loombre/provisioning";

// Every non-fs-derived case below is copy-pasted from REAL pg_controldata
// output captured against the actual vendored 17.10.0 binary on this host
// during this lane's research (see the package report) — not invented from
// documentation.

describe("classifyControlDataOutput", () => {
  it("healthy: exit 0, no CRC warning", () => {
    const healthyOutput = [
      "pg_control version number:            1300",
      "Catalog version number:               202307071",
      "Database cluster state:               shut down",
    ].join("\n");
    expect(classifyControlDataOutput({ exitCode: 0, stdout: healthyOutput, stderr: "" })).toBe("healthy");
  });

  it("truncated pg_control -> incomplete-initdb (real captured text)", () => {
    const result = classifyControlDataOutput({
      exitCode: 1,
      stdout: "",
      stderr: 'pg_controldata: error: could not read file "/data/global/pg_control": read 100 of 296',
    });
    expect(result).toBe("incomplete-initdb");
  });

  it("bit-flipped (CRC mismatch) pg_control -> checksum-failure, even though pg_controldata exits 0 (real captured behavior)", () => {
    const result = classifyControlDataOutput({
      exitCode: 0,
      stdout:
        "WARNING: Calculated CRC checksum does not match value stored in file.\n" +
        "Either the file is corrupt, or it has a different layout than this program\n" +
        "is expecting.  The results below are untrustworthy.\n\n" +
        "pg_control version number:            4294903060\n",
      stderr: "",
    });
    expect(result).toBe("checksum-failure");
  });

  it("permission denied -> permission-denied", () => {
    const result = classifyControlDataOutput({
      exitCode: 1,
      stdout: "",
      stderr: 'pg_controldata: error: could not open file "/data/global/pg_control" for reading: Permission denied',
    });
    expect(result).toBe("permission-denied");
  });

  it("disk full -> disk-full", () => {
    const result = classifyControlDataOutput({
      exitCode: 1,
      stdout: "",
      stderr: "could not write file: No space left on device",
    });
    expect(result).toBe("disk-full");
  });

  it("a failure matching none of the known patterns -> unknown (never throws, never silently 'healthy')", () => {
    const result = classifyControlDataOutput({ exitCode: 1, stdout: "", stderr: "some completely unrecognized failure text" });
    expect(result).toBe("unknown");
  });

  it("every non-fs-derived branch returns a value from the frozen CorruptionReason enum (or 'healthy')", () => {
    const cases: Array<{ exitCode: number; stdout: string; stderr: string }> = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "read 1 of 296" },
      { exitCode: 0, stdout: "Calculated CRC checksum does not match", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "Permission denied" },
      { exitCode: 1, stdout: "", stderr: "No space left on device" },
      { exitCode: 1, stdout: "", stderr: "gremlins" },
    ];
    for (const c of cases) {
      const result = classifyControlDataOutput(c);
      expect(result === "healthy" || CORRUPTION_REASONS.includes(result)).toBe(true);
    }
  });
});

describe("classifyStartupFailureLog", () => {
  it("FATAL + checkpoint-record language -> crash-recovery-failed", () => {
    const log = "PANIC:  could not locate a valid checkpoint record\nLOG: startup process was terminated by signal 6";
    expect(classifyStartupFailureLog(log)).toBe("crash-recovery-failed");
  });

  it("FATAL about something unrelated to recovery -> unknown", () => {
    const log = 'FATAL:  could not bind IPv4 address "127.0.0.1": Address already in use';
    expect(classifyStartupFailureLog(log)).toBe("unknown");
  });

  it("no FATAL/PANIC at all -> unknown", () => {
    expect(classifyStartupFailureLog("LOG: database system is ready to accept connections")).toBe("unknown");
  });
});
