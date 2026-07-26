// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/test/corruption.integration.spec.ts
//
// THE corruption exit-bar test (this lane's mission, deliverable 5, item
// 3): truncate/damage a control file -> typed CorruptionReport. Real
// initdb'd cluster, real damage to the real global/pg_control file, real
// pg_controldata invocation via the vendored binary.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedPostgres } from "../src/supervisor.js";
import { detectCorruption } from "../src/corruption.js";
import { CORRUPTION_REASONS } from "@loombre/provisioning";
import { ensureRealBinaries, isProvenIntegrationHost, requireEnvSet, PG_CURRENT_VERSION, PG_UPGRADE_FROM_VERSION } from "./support/real-binaries.js";

const RUN = isProvenIntegrationHost() || requireEnvSet();
const describeReal = RUN ? describe : describe.skip;

if (!RUN) {
  console.warn(
    `corruption.integration.spec.ts: SKIPPED — not the proven integration host (darwin-arm64), host is ${process.platform}/${process.arch}. ` +
      "Set LOOMBRE_REQUIRE_PG_PROVISIONING_INTEGRATION=1 to hard-fail here instead of skipping.",
  );
}

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `loombre-provisioning-pg-${prefix}-`));
  cleanupDirs.push(dir);
  return dir;
}

describeReal("detectCorruption() — real damaged control file", () => {
  it("a TRUNCATED global/pg_control -> typed CorruptionReport (reason from the closed enum, never a bare string)", async () => {
    const { binaries } = await ensureRealBinaries(PG_CURRENT_VERSION);
    const dataDir = join(scratchDir("corrupt-data"), "data");
    const secretDir = scratchDir("corrupt-secret");

    const instance = new EmbeddedPostgres({
      binaries,
      pgMajor: 18,
      pgFullVersion: PG_CURRENT_VERSION,
      dataDir,
      listenStrategy: { kind: "unix-socket", socketDir: scratchDir("corrupt-sock") },
      locale: "en_US.UTF-8",
      encoding: "UTF8",
      superuserSecretRef: { backend: "file0600", key: join(secretDir, "superuser.secret") },
    });

    // Real initdb — genuinely healthy cluster first.
    await instance.provision();
    const healthyReport = await detectCorruption({ dataDir, pinnedMajor: 18, binaries });
    expect(healthyReport).toBeNull();

    // Real damage: truncate the real pg_control file to a fraction of its
    // real size — the exact "process killed / disk full mid-write"
    // signature @loombre/provisioning's CorruptionReason doc comment
    // describes for 'incomplete-initdb'.
    const controlFilePath = join(dataDir, "global", "pg_control");
    const originalBytes = readFileSync(controlFilePath);
    expect(originalBytes.length).toBeGreaterThan(100);
    writeFileSync(controlFilePath, originalBytes.subarray(0, 100));

    const report = await detectCorruption({ dataDir, pinnedMajor: 18, binaries });
    expect(report).not.toBeNull();
    if (!report) throw new Error("unreachable");

    // The core contract: a TYPED reason from the closed enum, not a raw
    // error string — `report.reason` must be usable in an exhaustive
    // switch by a caller (lane D's admin UI, lane C's wizard).
    expect(CORRUPTION_REASONS).toContain(report.reason);
    expect(report.reason).toBe("incomplete-initdb");
    expect(report.dataDir).toBe(dataDir);
    expect(typeof report.detectedAtMs).toBe("number");
    expect(report.detail).toBeDefined();
  });

  it("a BIT-FLIPPED (CRC-mismatched but full-size) global/pg_control -> 'checksum-failure' (real captured pg_controldata behavior: exits 0 with a WARNING, not a nonzero exit)", async () => {
    const { binaries } = await ensureRealBinaries(PG_CURRENT_VERSION);
    const dataDir = join(scratchDir("crc-data"), "data");
    const secretDir = scratchDir("crc-secret");

    const instance = new EmbeddedPostgres({
      binaries,
      pgMajor: 18,
      pgFullVersion: PG_CURRENT_VERSION,
      dataDir,
      listenStrategy: { kind: "unix-socket", socketDir: scratchDir("crc-sock") },
      locale: "en_US.UTF-8",
      encoding: "UTF8",
      superuserSecretRef: { backend: "file0600", key: join(secretDir, "superuser.secret") },
    });

    await instance.provision();

    const controlFilePath = join(dataDir, "global", "pg_control");
    const originalBytes = readFileSync(controlFilePath);
    const corrupted = Buffer.from(originalBytes);
    // Flip bytes well past the header, keeping the file FULL SIZE (unlike
    // the truncation case above) — this is what makes pg_controldata take
    // the CRC-mismatch-but-still-parses branch instead of a read error.
    corrupted[10] = corrupted[10]! ^ 0xff;
    corrupted[11] = corrupted[11]! ^ 0xff;
    writeFileSync(controlFilePath, corrupted);

    const report = await detectCorruption({ dataDir, pinnedMajor: 18, binaries });
    expect(report).not.toBeNull();
    expect(report?.reason).toBe("checksum-failure");
  });

  it("a missing data directory entirely -> 'missing-data-dir' (fs-derived, never even shells out to pg_controldata)", async () => {
    const { binaries } = await ensureRealBinaries(PG_CURRENT_VERSION);
    const neverCreatedDataDir = join(scratchDir("missing"), "does-not-exist");
    const report = await detectCorruption({ dataDir: neverCreatedDataDir, pinnedMajor: 18, binaries });
    expect(report?.reason).toBe("missing-data-dir");
  });

  it("a data dir with no PG_VERSION -> 'missing-version-file'", async () => {
    const { binaries } = await ensureRealBinaries(PG_CURRENT_VERSION);
    const emptyDataDir = scratchDir("empty-data");
    const report = await detectCorruption({ dataDir: emptyDataDir, pinnedMajor: 18, binaries });
    expect(report?.reason).toBe("missing-version-file");
  });

  it("a real 17.x-initialized cluster checked against pinnedMajor=18 -> 'pg-version-mismatch'", async () => {
    const { binaries: binariesOld } = await ensureRealBinaries(PG_UPGRADE_FROM_VERSION);
    const dataDir = join(scratchDir("mismatch-data"), "data");
    const secretDir = scratchDir("mismatch-secret");

    const instance = new EmbeddedPostgres({
      binaries: binariesOld,
      pgMajor: 17,
      pgFullVersion: PG_UPGRADE_FROM_VERSION,
      dataDir,
      listenStrategy: { kind: "unix-socket", socketDir: scratchDir("mismatch-sock") },
      locale: "en_US.UTF-8",
      encoding: "UTF8",
      superuserSecretRef: { backend: "file0600", key: join(secretDir, "superuser.secret") },
    });
    await instance.provision();

    const { binaries: binariesNew } = await ensureRealBinaries(PG_CURRENT_VERSION);
    const report = await detectCorruption({ dataDir, pinnedMajor: 18, binaries: binariesNew });
    expect(report?.reason).toBe("pg-version-mismatch");
  });

  it("start() on a corrupted data directory surfaces the SAME typed CorruptionReport through ProvisioningStatus.state='corrupt' (crash-of-child / startup-failure detection)", async () => {
    const { binaries } = await ensureRealBinaries(PG_CURRENT_VERSION);
    const dataDir = join(scratchDir("start-corrupt-data"), "data");
    const secretDir = scratchDir("start-corrupt-secret");

    const instance = new EmbeddedPostgres({
      binaries,
      pgMajor: 18,
      pgFullVersion: PG_CURRENT_VERSION,
      dataDir,
      listenStrategy: { kind: "unix-socket", socketDir: scratchDir("start-corrupt-sock") },
      locale: "en_US.UTF-8",
      encoding: "UTF8",
      superuserSecretRef: { backend: "file0600", key: join(secretDir, "superuser.secret") },
      startTimeoutMs: 5000,
    });

    await instance.provision();
    const controlFilePath = join(dataDir, "global", "pg_control");
    const originalBytes = readFileSync(controlFilePath);
    writeFileSync(controlFilePath, originalBytes.subarray(0, 50));

    const status = await instance.start();
    expect(status.state).toBe("corrupt");
    expect(status.detail).toBeDefined();
  }, 30_000);
});
