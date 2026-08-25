// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/ipc/listener.e2e.spec.ts
//
// Real listener on a real ephemeral loopback port (this lane's mission
// deliverable 3) — every op's happy path, auth negatives, loopback-only
// proof, stale-discovery recovery, and contract-fixture round-trips
// validated against packages/controller-ipc's REAL Ajv schemas — the same
// schemas installers/macos/menubar/fixtures.json (the Swift/C# clients'
// shared fixture source, verified by that directory's own
// verify-fixtures.mjs) is checked against, imported here through the exact
// the (since-retired) relative-dist shim pattern the
// production listener code uses, so a schema drift shows up identically on
// both sides.
//
// Uses the real global fetch + node:net (not supertest — there is no
// Express/Nest app here at all, deliberately: see listener.ts's own header
// for why this is a standalone node:http server).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import type { ProvisioningStatus } from "@loombre/provisioning";
import { IpcListener, type IpcListenerHandle } from "../../src/ipc/listener.js";
import { discoveryFilePath, tokenFilePath } from "../../src/ipc/discovery-files.js";
import type { RecentJobSignal } from "../../src/ipc/worker-liveness.js";
import type { WorkerLiveness } from "@loombre/db";
import {
  IPC_BASE_PATH,
  IPC_LOOPBACK_HOST,
  CONTROLLER_IPC_CONTRACT_VERSION,
  IPC_STATUS_RESPONSE_SCHEMA,
  IPC_ERROR_BODY_SCHEMA,
  IPC_SERVER_ACTION_RESPONSE_SCHEMA,
  OPEN_WEB_TARGET_RESPONSE_SCHEMA,
  CRASH_FILES_RESPONSE_SCHEMA,
  type IpcStatusResponse,
  type IpcErrorBody,
  type OpenWebTargetResponse,
  type CrashFilesResponse,
} from "@loombre/controller-ipc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function compile(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

const STATUS_VALIDATOR = compile(IPC_STATUS_RESPONSE_SCHEMA);
const ERROR_VALIDATOR = compile(IPC_ERROR_BODY_SCHEMA);
const SERVER_ACTION_VALIDATOR = compile(IPC_SERVER_ACTION_RESPONSE_SCHEMA);
const OPEN_WEB_TARGET_VALIDATOR = compile(OPEN_WEB_TARGET_RESPONSE_SCHEMA);
const CRASH_FILES_VALIDATOR = compile(CRASH_FILES_RESPONSE_SCHEMA);

const VERSION = "0.9.0-test+ipc";
const SERVER_PID = 4242;
const SERVER_STARTED_AT_MS = 1_800_000_000_000;

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor: condition not met within timeout");
}

describe("IPC listener (real HTTP, ephemeral loopback port)", () => {
  let dataDir: string;
  let listener: IpcListener;
  let handle: IpcListenerHandle;
  let recentJobs: RecentJobSignal[];
  /** null = no worker connected; an object = one is; "unavailable" makes the
   *  liveness query REJECT, which is what demotes /status to the ledger. */
  let workerLiveness: WorkerLiveness | null | "unavailable";
  let provisioningStatus: ProvisioningStatus;
  let stopSignalCount: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "loombre-ipc-e2e-"));
    recentJobs = [];
    workerLiveness = null;
    provisioningStatus = { state: "external", pgVersion: null, dataDir: null, lastCheckMs: Date.now() };
    stopSignalCount = 0;

    listener = new IpcListener({
      env: {},
      dataDir,
      serverPort: 3001,
      serverTlsMode: "off",
      version: VERSION,
      serverPid: SERVER_PID,
      serverStartedAtMs: SERVER_STARTED_AT_MS,
      getProvisioningStatus: () => provisioningStatus,
      listRecentJobs: async () => recentJobs,
      getWorkerLiveness: async () => {
        if (workerLiveness === "unavailable") {
          throw new Error("pg_stat_activity unavailable (simulated)");
        }
        return workerLiveness;
      },
      sendStopSignal: () => {
        stopSignalCount += 1;
      },
    });
    handle = await listener.start();
  });

  afterEach(async () => {
    await listener.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function opUrl(suffix: string): string {
    return `http://${IPC_LOOPBACK_HOST}:${handle.port}${IPC_BASE_PATH}${suffix}`;
  }
  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${handle.token}` };
  }

  describe("loopback-only", () => {
    it("binds exactly 127.0.0.1 (never 0.0.0.0/::)", () => {
      expect(listener.boundAddress).toBe(IPC_LOOPBACK_HOST);
    });

    it("is unreachable via any real non-loopback interface address on this host, when one exists", async () => {
      const candidates = Object.values(networkInterfaces())
        .flat()
        .filter((i): i is NonNullable<typeof i> => i !== undefined && i.family === "IPv4" && !i.internal);
      const nonLoopback = candidates[0];
      if (!nonLoopback) return; // sandboxed/offline host with no real interface — nothing to prove here

      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = net.connect({ host: nonLoopback.address, port: handle.port, timeout: 1000 });
          socket.once("connect", () => {
            socket.destroy();
            reject(new Error(`connected to ${nonLoopback.address}:${handle.port} — should have been unreachable`));
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", () => resolve()); // ECONNREFUSED/EHOSTUNREACH/etc — expected
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("GET /status", () => {
    it("200s with a schema-valid, self-consistent response", async () => {
      const res = await fetch(opUrl("/status"), { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as IpcStatusResponse;
      expect(STATUS_VALIDATOR(body), JSON.stringify(STATUS_VALIDATOR.errors)).toBe(true);

      // version field agreement — server AND worker report the same
      // version this test configured, and the contract version matches
      // the package's own constant.
      expect(body.ipcContractVersion).toBe(CONTROLLER_IPC_CONTRACT_VERSION);
      expect(body.server.version).toBe(VERSION);
      expect(body.worker.version).toBe(VERSION);

      expect(body.server.state).toBe("running");
      expect(body.server.pid).toBe(SERVER_PID);
      expect(body.server.startedAtMs).toBe(SERVER_STARTED_AT_MS);
      expect(body.webUrl).toBe("http://localhost:3001");
      expect(body.provisioning).toEqual(provisioningStatus);
    });

    // PRIMARY signal: pg_stat_activity (packages/db/src/query/worker-liveness.ts).
    // The job-ledger heuristic below it is only a fallback now, because it
    // cannot tell an IDLE worker from a dead one — a healthy fresh install
    // reported "stopped" forever, which is what this whole seam exists to stop.
    it("reports worker 'running' with the REAL pid and start time when one is connected", async () => {
      workerLiveness = { pid: 4242, startedAtMs: 1_700_000_000_000, connectedAtMs: 1_700_000_005_000 };
      // Deliberately empty: an idle worker has NO recent ledger activity, and
      // must still be reported as running. This is the exact false negative
      // that was observed on a real macOS install (IPC said stopped while the
      // worker ran as pid 64084).
      recentJobs = [];
      const res = await fetch(opUrl("/status"), { headers: authHeaders() });
      const body = (await res.json()) as IpcStatusResponse;
      expect(body.worker.state).toBe("running");
      expect(body.worker.pid).toBe(4242);
      expect(body.worker.startedAtMs).toBe(1_700_000_000_000);
    });

    it("reports worker 'stopped' when nothing is connected, even with recent ledger activity", async () => {
      workerLiveness = null;
      // A job touched moments ago is NOT evidence the worker is alive now —
      // it may have died mid-run. The connection is the authority.
      recentJobs = [{ status: "active", updatedAtMs: Date.now() }];
      const res = await fetch(opUrl("/status"), { headers: authHeaders() });
      const body = (await res.json()) as IpcStatusResponse;
      expect(body.worker.state).toBe("stopped");
      expect(body.worker.pid).toBeNull();
    });

    it("falls back to the job-ledger heuristic when the liveness query itself fails", async () => {
      workerLiveness = "unavailable";
      recentJobs = [{ status: "active", updatedAtMs: Date.now() }];
      const res = await fetch(opUrl("/status"), { headers: authHeaders() });
      const body = (await res.json()) as IpcStatusResponse;
      expect(body.worker.state).toBe("running");
    });

    it("falls back to 'stopped' when the liveness query fails and the ledger is quiet", async () => {
      workerLiveness = "unavailable";
      recentJobs = [];
      const res = await fetch(opUrl("/status"), { headers: authHeaders() });
      const body = (await res.json()) as IpcStatusResponse;
      expect(body.worker.state).toBe("stopped");
    });

    it("reflects a live provisioning status passthrough change", async () => {
      provisioningStatus = { state: "ready", pgVersion: "18.4.0", dataDir: "/data/postgres", lastCheckMs: Date.now() };
      const res = await fetch(opUrl("/status"), { headers: authHeaders() });
      const body = (await res.json()) as IpcStatusResponse;
      expect(body.provisioning).toEqual(provisioningStatus);
    });
  });

  describe("POST /server/start", () => {
    it("always 409s with code 'server-already-running' (decision a)", async () => {
      const res = await fetch(opUrl("/server/start"), { method: "POST", headers: authHeaders() });
      expect(res.status).toBe(409);
      const body = (await res.json()) as IpcErrorBody;
      expect(ERROR_VALIDATOR(body), JSON.stringify(ERROR_VALIDATOR.errors)).toBe(true);
      expect(body.code).toBe("server-already-running");
    });
  });

  describe("POST /server/stop", () => {
    it("200s accepted+stopping and triggers the (injected) stop signal after the response flushes", async () => {
      const res = await fetch(opUrl("/server/stop"), { method: "POST", headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(SERVER_ACTION_VALIDATOR(body), JSON.stringify(SERVER_ACTION_VALIDATOR.errors)).toBe(true);
      expect(body).toEqual({ accepted: true, state: "stopping" });

      await waitFor(() => stopSignalCount === 1);
      expect(stopSignalCount).toBe(1);
    });
  });

  describe("GET /open-web-target", () => {
    it("200s with the same URL /status reports", async () => {
      const res = await fetch(opUrl("/open-web-target"), { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OpenWebTargetResponse;
      expect(OPEN_WEB_TARGET_VALIDATOR(body), JSON.stringify(OPEN_WEB_TARGET_VALIDATOR.errors)).toBe(true);
      expect(body.url).toBe("http://localhost:3001");
    });
  });

  describe("GET /crash-files", () => {
    it("200s an empty list when no crash directory exists yet", async () => {
      const res = await fetch(opUrl("/crash-files"), { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(CRASH_FILES_VALIDATOR(body), JSON.stringify(CRASH_FILES_VALIDATOR.errors)).toBe(true);
      expect(body).toEqual({ files: [] });
    });

    it("200s real crash files sorted most-recent-first", async () => {
      const crashDir = join(dataDir, "crashes");
      mkdirSync(crashDir, { recursive: true });
      writeFileSync(join(crashDir, "server-1.log"), "x");
      writeFileSync(join(crashDir, "server-2.log"), "y");

      const res = await fetch(opUrl("/crash-files"), { headers: authHeaders() });
      const body = (await res.json()) as CrashFilesResponse;
      expect(CRASH_FILES_VALIDATOR(body), JSON.stringify(CRASH_FILES_VALIDATOR.errors)).toBe(true);
      expect(body.files).toHaveLength(2);
      expect(body.files.map((f) => f.path).sort()).toEqual(
        [join(crashDir, "server-1.log"), join(crashDir, "server-2.log")].sort(),
      );
    });
  });

  describe("auth negatives", () => {
    const ops: [string, string][] = [
      ["GET", "/status"],
      ["POST", "/server/start"],
      ["POST", "/server/stop"],
      ["GET", "/open-web-target"],
      ["GET", "/crash-files"],
    ];

    it.each(ops)("%s %s: 401s with no Authorization header", async (method, path) => {
      const res = await fetch(opUrl(path), { method });
      expect(res.status).toBe(401);
      const body = (await res.json()) as IpcErrorBody;
      expect(ERROR_VALIDATOR(body), JSON.stringify(ERROR_VALIDATOR.errors)).toBe(true);
      expect(body.code).toBe("unauthorized");
    });

    it.each(ops)("%s %s: 401s with a wrong token", async (method, path) => {
      const res = await fetch(opUrl(path), { method, headers: { Authorization: `Bearer ${"0".repeat(64)}` } });
      expect(res.status).toBe(401);
    });

    it("401s with a malformed Authorization header (wrong scheme)", async () => {
      const res = await fetch(opUrl("/status"), { headers: { Authorization: `Basic ${handle.token}` } });
      expect(res.status).toBe(401);
    });

    it("never echoes the token back in an error body", async () => {
      const res = await fetch(opUrl("/status"), { headers: { Authorization: `Bearer ${"0".repeat(64)}` } });
      const text = await res.text();
      expect(text).not.toContain(handle.token);
    });
  });

  describe("unmatched routes", () => {
    it("404s an unknown path (still authenticated + JSON-shaped)", async () => {
      const res = await fetch(`http://${IPC_LOOPBACK_HOST}:${handle.port}${IPC_BASE_PATH}/nope`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(ERROR_VALIDATOR(body), JSON.stringify(ERROR_VALIDATOR.errors)).toBe(true);
    });

    it("404s a recognized path with the wrong HTTP method", async () => {
      const res = await fetch(opUrl("/status"), { method: "POST", headers: authHeaders() });
      expect(res.status).toBe(404);
    });
  });

  describe("discovery + token files", () => {
    it("writes a discovery file whose port/pid match the real listener", async () => {
      const discovery = JSON.parse(readFileSync(discoveryFilePath(dataDir), "utf8"));
      expect(discovery).toEqual({
        port: handle.port,
        host: IPC_LOOPBACK_HOST,
        pid: SERVER_PID,
        startedAtMs: SERVER_STARTED_AT_MS,
      });
    });

    it("writes a token file matching the handle's token", () => {
      expect(readFileSync(tokenFilePath(dataDir), "utf8")).toBe(handle.token);
    });

    it("removes both files on stop()", async () => {
      await listener.stop();
      expect(() => readFileSync(discoveryFilePath(dataDir), "utf8")).toThrow();
      expect(() => readFileSync(tokenFilePath(dataDir), "utf8")).toThrow();
      // Re-start for this test's own afterEach (which also calls stop()) to
      // remain a harmless no-op.
      handle = await listener.start();
    });
  });

  describe("stale-discovery recovery", () => {
    it("boots successfully over a discovery file naming a dead pid, overwriting it", async () => {
      await listener.stop();
      writeFileSync(
        discoveryFilePath(dataDir),
        JSON.stringify({ port: 1, host: IPC_LOOPBACK_HOST, pid: 2_147_483_647, startedAtMs: 0 }),
      );
      writeFileSync(tokenFilePath(dataDir), "stale-token");

      handle = await listener.start();
      const discovery = JSON.parse(readFileSync(discoveryFilePath(dataDir), "utf8"));
      expect(discovery.pid).toBe(SERVER_PID);
      expect(discovery.port).toBe(handle.port);
      expect(readFileSync(tokenFilePath(dataDir), "utf8")).toBe(handle.token);
      expect(readFileSync(tokenFilePath(dataDir), "utf8")).not.toBe("stale-token");
    });

    it("boots successfully even over a discovery file naming a still-alive pid (this test process's own)", async () => {
      await listener.stop();
      writeFileSync(
        discoveryFilePath(dataDir),
        JSON.stringify({ port: 1, host: IPC_LOOPBACK_HOST, pid: process.pid, startedAtMs: 0 }),
      );
      handle = await listener.start();
      expect(handle.port).toBeGreaterThan(0);
    });
  });

  describe("cross-client fixture round-trip (installers/macos/menubar/fixtures.json)", () => {
    // The Windows/macOS clients' own shared fixture source (that
    // directory's verify-fixtures.mjs validates it against these exact
    // schemas already) — proving representative entries validate here too,
    // through the @loombre/controller-ipc package import, ties both
    // sides of the contract to the same runtime schemas.
    const fixtures = JSON.parse(
      readFileSync(join(REPO_ROOT, "installers", "macos", "menubar", "fixtures.json"), "utf8"),
    );

    it("errorBodyServerAlreadyRunning validates against IPC_ERROR_BODY_SCHEMA", () => {
      expect(ERROR_VALIDATOR(fixtures.errorBodyServerAlreadyRunning)).toBe(true);
    });

    it("statusResponseHealthy validates against IPC_STATUS_RESPONSE_SCHEMA", () => {
      expect(STATUS_VALIDATOR(fixtures.statusResponseHealthy)).toBe(true);
    });

    it("serverActionResponseAccepted validates against IPC_SERVER_ACTION_RESPONSE_SCHEMA", () => {
      expect(SERVER_ACTION_VALIDATOR(fixtures.serverActionResponseAccepted)).toBe(true);
    });

    it("crashFilesResponse validates against CRASH_FILES_RESPONSE_SCHEMA", () => {
      expect(CRASH_FILES_VALIDATOR(fixtures.crashFilesResponse)).toBe(true);
    });

    it("openWebTargetResponse validates against OPEN_WEB_TARGET_RESPONSE_SCHEMA", () => {
      expect(OPEN_WEB_TARGET_VALIDATOR(fixtures.openWebTargetResponse)).toBe(true);
    });
  });
});
