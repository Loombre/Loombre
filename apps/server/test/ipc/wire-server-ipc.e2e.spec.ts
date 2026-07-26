// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/ipc/wire-server-ipc.e2e.spec.ts
//
// The ONE integration point apps/server/src/ipc/listener.e2e.spec.ts
// (dependency-injected IpcListenerDeps directly) cannot reach: proves
// ipc/index.ts's `wireServerIpc` NestJS adapter really resolves a live
// DbProvider from a booted app and that GET /ipc/v1/status's worker field
// flows through a REAL @loombre/db `listJobsAdmin` query against a REAL
// Postgres — not a fake. Self-sufficient (own ensureTestDatabase suffix,
// RESOURCE ISOLATION: `loombre_ipc`, ports left ephemeral) per this
// package's established live-DB test convention (see
// apps/server/test/ws-broadcaster.e2e.spec.ts's own header for the same
// pattern this file mirrors).
//
// Boots CommonModule (apps/server/src/common/common.module.ts), not the
// full AppModule: wireServerIpc's only NestJS-specific need is
// `app.get(DbProvider)`, which CommonModule alone provides — deliberately
// narrower than a full app boot, and (as a concurrent-lane side effect of
// this being a live shared multi-wave checkout, STATE.md's own documented
// hazard) importing the full AppModule at the time this test was written
// transitively pulled in apps/server/src/setup/setup.controller.ts, which
// currently fails to even PARSE (a duplicate `const db` declaration — an
// unrelated, in-progress, uncommitted lane's own bug, not this lane's to
// fix; see this lane's report). Scoping to CommonModule sidesteps that
// entirely while still exercising the real DI + real Postgres path this
// test exists to prove.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
import { CommonModule } from "../../src/common/common.module.js";
import { wireServerIpc } from "../../src/ipc/index.js";
import type { IpcListenerHandle } from "../../src/ipc/listener.js";
import { IPC_BASE_PATH, IPC_LOOPBACK_HOST } from "@loombre/controller-ipc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[], databaseUrl: string): void {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

let app: INestApplication;
let databaseUrl: string;
let dataDir: string;

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "ipc");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  dataDir = mkdtempSync(join(tmpdir(), "loombre-ipc-wire-e2e-"));

  app = await NestFactory.create(CommonModule, { logger: false });
  await app.listen(0);
}, 30_000);

afterAll(async () => {
  await app.close();
  const db = createDb(databaseUrl);
  await db.destroy();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("wireServerIpc — real NestJS app, real Postgres", () => {
  it("returns null and logs why when LOOMBRE_DATA_DIR is unset (kill-switch)", async () => {
    const address = app.getHttpServer().address() as AddressInfo;
    const handle = await wireServerIpc(app, { serverPort: address.port, serverTlsMode: "off" }, {});
    expect(handle).toBeNull();
  });

  it("starts a real listener whose GET /status flows through a real listJobsAdmin query", async () => {
    const address = app.getHttpServer().address() as AddressInfo;
    const handle = (await wireServerIpc(
      app,
      { serverPort: address.port, serverTlsMode: "off" },
      { LOOMBRE_DATA_DIR: dataDir },
    )) as IpcListenerHandle;
    expect(handle).not.toBeNull();

    try {
      const res = await fetch(`http://${IPC_LOOPBACK_HOST}:${handle.port}${IPC_BASE_PATH}/status`, {
        headers: { Authorization: `Bearer ${handle.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // A freshly reset+migrated jobs table has zero rows — the real
      // worker-liveness heuristic (worker-liveness.ts) reports 'stopped'
      // for a genuinely empty ledger, exercised here through the real
      // @loombre/db query path, not a fake.
      expect(body.worker.state).toBe("stopped");
      expect(body.server.state).toBe("running");
      // This test never calls bootstrapProvisioning() (it boots CommonModule
      // directly, not the full server entrypoint), so getProvisioningController()
      // is null here — exercising ipc/index.ts's fallbackProvisioningStatus()
      // 'external' branch for real, not just in a unit test.
      expect(body.provisioning).toEqual({
        state: "external",
        pgVersion: null,
        dataDir: null,
        lastCheckMs: expect.any(Number),
        detail: "bootstrapProvisioning() has not run in this process yet.",
      });
    } finally {
      await handle.stop();
    }
  });
});
