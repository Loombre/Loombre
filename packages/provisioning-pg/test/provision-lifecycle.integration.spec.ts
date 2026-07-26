// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/test/provision-lifecycle.integration.spec.ts
//
// THE exit-bar test (this lane's mission, deliverable 5, item 1): real
// first-boot provision on this host (darwin-arm64) -> connect -> run the
// repo's migrations against it -> seed -> guarded query works. No mocks —
// real downloaded PostgreSQL binaries, a real spawned postmaster, real
// migrations/seed scripts run as real child processes, a real @loombre/db
// guarded query proving the restricted-content guard fires against data
// this instance itself owns.
//
// Gated per test/support/real-binaries.ts's convention: loud skip off the
// proven host (darwin-arm64), hard-fail escalation behind
// LOOMBRE_REQUIRE_PG_PROVISIONING_INTEGRATION=1.

import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedPostgres } from "../src/supervisor.js";
import { socketScratchBase } from "../src/scratch-paths.js";
import type { ListenStrategy } from "@loombre/provisioning";
import { ensureRealBinaries, isProvenIntegrationHost, requireEnvSet, REPO_ROOT, PG_CURRENT_VERSION } from "./support/real-binaries.js";

const execFileAsync = promisify(execFile);

const RUN = isProvenIntegrationHost() || requireEnvSet();

const describeReal = RUN ? describe : describe.skip;

if (!RUN) {
  console.warn(
    `provision-lifecycle.integration.spec.ts: SKIPPED — not the proven integration host (darwin-arm64), host is ${process.platform}/${process.arch}. ` +
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

/** Short-based scratch dir for anything that will host a unix socket file
 *  (~104-byte sun_path cap — see src/scratch-paths.ts). */
function shortSocketDir(): string {
  const dir = mkdtempSync(join(socketScratchBase(), "loombre-pg-"));
  cleanupDirs.push(dir);
  return dir;
}

async function runNodeScript(scriptPath: string, args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("node", [scriptPath, ...args], { env: { ...process.env, ...env }, timeout: 60_000 });
}

describeReal("EmbeddedPostgres — real first-boot lifecycle (TCP loopback strategy, port 35010)", () => {
  it(
    "provision -> start -> migrate -> seed -> guarded query works -> stop",
    async () => {
      const { binaries } = await ensureRealBinaries(PG_CURRENT_VERSION);
      const dataDir = join(scratchDir("lifecycle-data"), "data");
      const secretDir = scratchDir("lifecycle-secret");

      const strategy: ListenStrategy = { kind: "tcp-loopback", port: 35010 };
      const instance = new EmbeddedPostgres({
        binaries,
        pgMajor: 18,
        pgFullVersion: PG_CURRENT_VERSION,
        dataDir,
        listenStrategy: strategy,
        locale: "en_US.UTF-8",
        encoding: "UTF8",
        superuserSecretRef: { backend: "file0600", key: join(secretDir, "superuser.secret") },
      });

      // absent -> provisioning
      expect(instance.getCurrentProvisioningStatus().state).toBe("absent");

      const afterProvision = await instance.provision();
      expect(afterProvision.state).toBe("provisioning");
      expect(afterProvision.dataDir).toBe(dataDir);
      expect(afterProvision.pgVersion).toBe(PG_CURRENT_VERSION);

      // provisioning -> ready
      const afterStart = await instance.start();
      expect(afterStart.state).toBe("ready");
      expect(afterStart.pgVersion).toBe(PG_CURRENT_VERSION);

      const databaseUrl = instance.getDatabaseUrl();
      expect(databaseUrl).toMatch(/^postgres:\/\/loombre:.+@127\.0\.0\.1:35010\/loombre$/);

      try {
        // Real migrations, run as the repo's own real script — the exact
        // command an installer/operator would run.
        const migratePath = join(REPO_ROOT, "packages", "db", "scripts", "migrate.mjs");
        const migrateResult = await runNodeScript(migratePath, ["migrate"], { DATABASE_URL: databaseUrl });
        expect(migrateResult.stdout + migrateResult.stderr).not.toMatch(/error/i);

        // Real seed data.
        const seedPath = join(REPO_ROOT, "packages", "db", "seed", "seed.mjs");
        await runNodeScript(seedPath, [], { DATABASE_URL: databaseUrl });

        // Real guarded query, using @loombre/db's public (guarded) barrel —
        // never db/internal. Proves this embedded instance is a fully
        // functional Postgres the rest of Loombre can run against.
        const { createDb, getUserByUsername, getLibraryPermissionSummary, listItems } = await import("@loombre/db");
        const db = createDb(databaseUrl);
        try {
          const admin = await getUserByUsername(db, "admin");
          expect(admin).toBeDefined();
          if (!admin) throw new Error("unreachable");

          const permissions = await getLibraryPermissionSummary(db, admin.id);
          const ctx = {
            userId: admin.id,
            allowedLibraryIds: [...permissions.generalLibraryIds, ...permissions.restrictedLibraryIds],
            restrictedCleared: true,
          };

          const result = await listItems(db, ctx, { limit: 5 });
          expect(result.rows.length).toBeGreaterThan(0);

          // Guard proof: an admin with restrictedCleared:false must see
          // STRICTLY FEWER (or equal, if the seed's restricted item titles
          // don't overlap this page) items than one with it true — the
          // seed script (packages/db/seed/seed.mjs) plants both general
          // and restricted content specifically to make this observable.
          const uncleared = { ...ctx, restrictedCleared: false };
          const unclearedResult = await listItems(db, uncleared, { limit: 1000 });
          const clearedResult = await listItems(db, ctx, { limit: 1000 });
          expect(unclearedResult.rows.length).toBeLessThan(clearedResult.rows.length);
        } finally {
          await db.destroy();
        }
      } finally {
        await instance.stop("fast");
      }

      const afterStop = instance.getCurrentProvisioningStatus();
      expect(afterStop.detail).toBe("stopped (clean shutdown)");
    },
    120_000,
  );

  it("unix-socket ListenStrategy also really works (provision -> start -> pg_isready-equivalent healthy -> stop)", async () => {
    const { binaries } = await ensureRealBinaries(PG_CURRENT_VERSION);
    const dataDir = join(scratchDir("unix-data"), "data");
    const secretDir = scratchDir("unix-secret");
    const socketDir = shortSocketDir();

    const instance = new EmbeddedPostgres({
      binaries,
      pgMajor: 18,
      pgFullVersion: PG_CURRENT_VERSION,
      dataDir,
      listenStrategy: { kind: "unix-socket", socketDir },
      locale: "en_US.UTF-8",
      encoding: "UTF8",
      superuserSecretRef: { backend: "file0600", key: join(secretDir, "superuser.secret") },
    });

    await instance.provision();
    const status = await instance.start();
    expect(status.state).toBe("ready");
    expect(instance.getDatabaseUrl()).toMatch(/^postgres:\/\/loombre:.+@.+\/loombre$/);

    await instance.stop("smart");
  }, 60_000);

  it("provision() is idempotent — a second provision() against an already-initialized cluster does not re-run initdb or lose the secret", async () => {
    const { binaries } = await ensureRealBinaries(PG_CURRENT_VERSION);
    const dataDir = join(scratchDir("idempotent-data"), "data");
    const secretDir = scratchDir("idempotent-secret");
    const config = {
      binaries,
      pgMajor: 18,
      pgFullVersion: PG_CURRENT_VERSION,
      dataDir,
      listenStrategy: { kind: "unix-socket" as const, socketDir: shortSocketDir() },
      locale: "en_US.UTF-8",
      encoding: "UTF8" as const,
      superuserSecretRef: { backend: "file0600" as const, key: join(secretDir, "superuser.secret") },
    };

    const first = new EmbeddedPostgres(config);
    await first.provision();
    const firstReady = await first.start();
    expect(firstReady.state).toBe("ready");
    const firstUrl = first.getDatabaseUrl();
    await first.stop("fast");

    // A brand-new instance object pointed at the SAME dataDir/secretRef —
    // simulating a server restart.
    const second = new EmbeddedPostgres(config);
    const status = await second.provision();
    expect(status.state).toBe("provisioning");
    expect(status.pgVersion).toBe(PG_CURRENT_VERSION);
    const secondReady = await second.start();
    expect(secondReady.state).toBe("ready");
    expect(second.getDatabaseUrl()).toBe(firstUrl);
    await second.stop("fast");
  }, 60_000);
});
