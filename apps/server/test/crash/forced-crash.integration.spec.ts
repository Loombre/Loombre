// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/crash/forced-crash.integration.spec.ts
//
// The REAL proof (not an in-process simulation like handlers.spec.ts):
// spawns an actual `node` child process running fixtures/throw-entrypoint.ts
// under tsx (same dev-vs-build resolution pattern apps/worker/src/image/
// worker-runner.ts documents for worker_threads, applied here to
// child_process instead), lets it genuinely crash, and asserts on the
// process's REAL exit code plus a REAL redacted JSON file left on disk.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crashDirPath } from "@loombre/shared";
import type { CrashReport } from "../../src/crash/report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "throw-entrypoint.ts");

function runFixture(dataDir: string, mode: "throw" | "reject") {
  return spawnSync(process.execPath, ["--import", "tsx", FIXTURE, dataDir, mode], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15_000,
  });
}

describe("forced crash (real child process)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "loombre-forced-crash-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("a real uncaughtException exits 1 and leaves a redacted crash file under LOOMBRE crashDirPath", () => {
    const result = runFixture(dataDir, "throw");

    expect(result.status).toBe(1);
    expect(existsSync(crashDirPath(dataDir))).toBe(true);

    const files = readdirSync(crashDirPath(dataDir));
    expect(files.length).toBe(1);

    const report = JSON.parse(readFileSync(path.join(crashDirPath(dataDir), files[0]!), "utf8")) as CrashReport;
    expect(report.kind).toBe("error");
    expect(report.version).toBe("test-fixture-1.0.0");
    expect(report.error?.name).toBe("Error");
    expect(report.error?.message).toContain("forced crash for integration test");

    // The fixture's own file:// URL (outside dataDir) must be redacted —
    // both in the message (interpolated verbatim) and the stack.
    expect(report.error?.message).not.toContain(__dirname);
    expect(report.error?.message).toContain("<redacted>/throw-entrypoint.ts");
    expect(JSON.stringify(report)).not.toContain(__dirname);
  });

  it("a real unhandledRejection with a non-Error-shaped path also exits 1 and writes a report", () => {
    const result = runFixture(dataDir, "reject");

    expect(result.status).toBe(1);
    const files = readdirSync(crashDirPath(dataDir));
    expect(files.length).toBe(1);

    const report = JSON.parse(readFileSync(path.join(crashDirPath(dataDir), files[0]!), "utf8")) as CrashReport;
    expect(report.error?.message).toContain("forced unhandled rejection for integration test");
  });

  it("never prints the raw dataDir crash file's absolute path structure to stdout beyond what the handler itself logs (log line does not leak unrelated foreign paths)", () => {
    const result = runFixture(dataDir, "throw");
    // The log line legitimately mentions the crash file's OWN path (inside
    // dataDir, which is fine to log — see redact.ts's header on why
    // in-dataDir paths are not secret) — this assertion is about the
    // FIXTURE's own source path (outside dataDir) never leaking to stdout.
    expect(result.stderr + result.stdout).not.toContain(__dirname);
  });
});
