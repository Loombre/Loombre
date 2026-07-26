// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/test/upgrade.integration.spec.ts
//
// THE upgrade exit-bar test (this lane's mission, deliverable 5, item 2):
// provision with PG 17 binaries, populate, run the upgrade path to 18 ->
// data intact (row counts + spot values), backup dir exists. Fully real:
// real 17.10.0 AND 18.4.0 binaries, real stop/backup/dumpall/initdb-new/
// restore/verify/swap/restart sequence exactly as @loombre/provisioning's
// frozen UpgradePlan.steps orders it.

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedPostgres } from "../src/supervisor.js";
import { UPGRADE_STEPS, type ListenStrategy } from "@loombre/provisioning";
import {
  ensureRealBinaries,
  isProvenIntegrationHost,
  requireEnvSet,
  PG_CURRENT_VERSION,
  PG_UPGRADE_FROM_VERSION,
} from "./support/real-binaries.js";

const RUN = isProvenIntegrationHost() || requireEnvSet();
const describeReal = RUN ? describe : describe.skip;

if (!RUN) {
  console.warn(
    `upgrade.integration.spec.ts: SKIPPED — not the proven integration host (darwin-arm64), host is ${process.platform}/${process.arch}. ` +
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

describeReal("EmbeddedPostgres.upgrade() — real PG 17 -> 18 dump/restore", () => {
  it(
    "populates real data on 17, upgrades to 18, and proves data intact via row-count + version spot checks; backup dir exists",
    async () => {
      const { binaries: oldBinaries } = await ensureRealBinaries(PG_UPGRADE_FROM_VERSION);
      const { binaries: newBinaries } = await ensureRealBinaries(PG_CURRENT_VERSION);

      const dataDir = join(scratchDir("upgrade-data"), "data");
      const secretDir = scratchDir("upgrade-secret");
      const backupPath = join(scratchDir("upgrade-backup"), "pre-upgrade-backup");

      const strategy: ListenStrategy = { kind: "tcp-loopback", port: 35020 };
      const instance = new EmbeddedPostgres({
        binaries: oldBinaries,
        pgMajor: 17,
        pgFullVersion: PG_UPGRADE_FROM_VERSION,
        dataDir,
        listenStrategy: strategy,
        locale: "en_US.UTF-8",
        encoding: "UTF8",
        superuserSecretRef: { backend: "file0600", key: join(secretDir, "superuser.secret") },
      });

      await instance.provision();
      const started = await instance.start();
      expect(started.state).toBe("ready");
      expect(started.pgVersion).toBe(PG_UPGRADE_FROM_VERSION);

      // Populate real data directly via psql against the OLD (16.x)
      // instance — a small, deterministic dataset this test can spot-check
      // exactly (500 rows, a known checksum-able value column).
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const oldDatabaseUrl = instance.getDatabaseUrl();

      async function psqlExec(databaseUrl: string, sql: string): Promise<string> {
        const url = new URL(databaseUrl);
        const { stdout } = await execFileAsync(
          binForPlatform(),
          [
            "-h",
            url.hostname,
            "-p",
            url.port,
            "-U",
            decodeURIComponent(url.username),
            "-d",
            decodeURIComponent(url.pathname.slice(1)),
            "-t",
            "-A",
            "-c",
            sql,
          ],
          { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, timeout: 15_000 },
        );
        return stdout.trim();
        function binForPlatform(): string {
          return oldBinaries.psql;
        }
      }

      await psqlExec(oldDatabaseUrl, "CREATE TABLE widgets (id serial primary key, name text, value integer)");
      await psqlExec(oldDatabaseUrl, "INSERT INTO widgets (name, value) SELECT 'w' || g, g * 7 FROM generate_series(1, 500) g");
      const preCount = await psqlExec(oldDatabaseUrl, "SELECT count(*) FROM widgets");
      expect(preCount).toBe("500");
      const preSum = await psqlExec(oldDatabaseUrl, "SELECT sum(value) FROM widgets");

      const result = await instance.upgrade({
        toBinaries: newBinaries,
        toPgMajor: 18,
        toPgFullVersion: PG_CURRENT_VERSION,
        backupPath,
        spotChecks: [
          { database: "loombre", query: "SELECT count(*) FROM widgets" },
          { database: "loombre", query: "SELECT sum(value) FROM widgets" },
        ],
      });

      // The FROZEN step enum, executed in the FROZEN order, every step
      // present exactly once.
      expect(result.plan.steps).toEqual([...UPGRADE_STEPS]);
      expect(result.stepResults.map((s) => s.step)).toEqual([...UPGRADE_STEPS]);
      expect(result.plan.fromVersion).toBe(PG_UPGRADE_FROM_VERSION);
      expect(result.plan.toVersion).toBe(PG_CURRENT_VERSION);
      expect(result.plan.backupPath).toBe(backupPath);

      // Pre-upgrade backup dir exists and is a real, intact cluster copy.
      expect(existsSync(backupPath)).toBe(true);
      expect(existsSync(join(backupPath, "PG_VERSION"))).toBe(true);
      expect(readFileSync(join(backupPath, "PG_VERSION"), "utf8").trim()).toBe("17");

      // Spot checks: exact row count AND an aggregate value, both intact.
      expect(result.spotCheckResults).toHaveLength(2);
      for (const spotCheck of result.spotCheckResults) {
        expect(spotCheck.matched).toBe(true);
      }
      expect(result.spotCheckResults[0]?.before).toBe("500");
      expect(result.spotCheckResults[0]?.after).toBe("500");
      expect(result.spotCheckResults[1]?.before).toBe(preSum);

      // The instance is now a REAL, live PG 17 server — verify directly.
      const postUpgradeStatus = instance.getCurrentProvisioningStatus();
      expect(postUpgradeStatus.state).toBe("ready");
      expect(postUpgradeStatus.pgVersion).toBe(PG_CURRENT_VERSION);

      const newDatabaseUrl = instance.getDatabaseUrl();
      const rowCountAfterUpgrade = await execFileAsync(
        newBinaries.psql,
        (() => {
          const url = new URL(newDatabaseUrl);
          return [
            "-h",
            url.hostname,
            "-p",
            url.port,
            "-U",
            decodeURIComponent(url.username),
            "-d",
            "loombre",
            "-t",
            "-A",
            "-c",
            "SELECT count(*) FROM widgets",
          ];
        })(),
        { env: { ...process.env, PGPASSWORD: decodeURIComponent(new URL(newDatabaseUrl).password) }, timeout: 15_000 },
      );
      expect(rowCountAfterUpgrade.stdout.trim()).toBe("500");

      await instance.stop("fast");
    },
    600_000,
  );
});
