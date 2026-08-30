// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/tls/ws-over-tls.e2e.spec.ts
//
// Remote-access verification finding (2026-08-30): the /v1/events
// WebSocket upgrade handler was attached ONLY to the http.Server
// NestFactory creates (ws-broadcaster.service.ts) — but in TLS mode
// (P4.4, docs/PLAN.md §10) main.ts serves from a SEPARATE https.Server
// built by tls/runtime.ts, which had no "upgrade" listener at all, so
// Node destroyed every WS handshake socket. Live events silently died on
// the exact deployment shape (built-in TLS for direct exposure) that IS
// remote access. This suite drives the REAL entrypoint sequence via
// main.ts's exported listenWithTls() (applyTrustProxy's own
// export-for-tests precedent) against a real self-signed cert:
//   1. sanity — plain HTTPS request works over the TLS listener,
//   2. the /v1/events WS upgrade completes (the defect's pin),
//   3. a token-less upgrade still gets the broadcaster's 401, proving the
//      SAME handler (not a permissive fallback) answers on the TLS path.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed) per
// this package's established live-DB test convention.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { WebSocket } from "ws";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../../src/app.module.js";
import { listenWithTls, type TlsListenResult } from "../../src/main.js";
import { generateSelfSignedCert, type SelfSignedCert } from "../../src/tls/test-support/self-signed-cert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function buildDeviceProfile(profileId: string) {
  return {
    profileId,
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function httpsGet(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      // agent:false — Node's default global agent keeps the connection
      // alive, which would park an idle socket on the https.Server and
      // stall afterAll's tlsListen.close() (server.close() waits for it).
      { host: "127.0.0.1", port, path: urlPath, method: "GET", rejectUnauthorized: false, agent: false },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let app: INestApplication;
let tlsListen: TlsListenResult;
let adminToken: string;
let cert: SelfSignedCert;
let certDir: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "ws-over-tls-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "ws_tls_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  cert = generateSelfSignedCert("localhost");
  certDir = mkdtempSync(path.join(tmpdir(), "loombre-ws-tls-test-"));
  const certPath = path.join(certDir, "cert.pem");
  const keyPath = path.join(certDir, "key.pem");
  writeFileSync(certPath, cert.cert);
  writeFileSync(keyPath, cert.key);

  app = await NestFactory.create(AppModule, { logger: false });
  // The EXACT production sequence for LOOMBRE_TLS_MODE=manual — see
  // main.ts's bootstrap(): init (never app.listen), TLS runtime around the
  // Express instance, listen. httpsPort 0 = ephemeral (TlsListenResult's
  // boundPort doc comment).
  tlsListen = await listenWithTls(app, {
    mode: "manual",
    httpsPort: 0,
    certPath,
    keyPath,
    reloadDebounceMs: 500,
  });

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "ws-tls-test-admin",
    deviceProfile: buildDeviceProfile("ws-tls-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await tlsListen?.close();
  await app?.close();
  cert?.cleanup();
  if (certDir) rmSync(certDir, { recursive: true, force: true });
}, 30_000);

describe("WS /v1/events over built-in TLS (manual mode, real https.Server)", () => {
  it("sanity: a plain HTTPS request is served by the TLS listener", async () => {
    const res = await httpsGet(tlsListen.boundPort, "/healthz");
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { status: string }).status).toBe("ok");
  });

  it("completes the /v1/events WebSocket upgrade over the TLS listener", async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${tlsListen.boundPort}/v1/events?token=${adminToken}`, {
      rejectUnauthorized: false,
    });
    try {
      await expect(waitForOpen(ws)).resolves.toBeUndefined();
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      // Await the FULL close handshake: an upgraded socket is exempt from
      // Node's idle-connection reaping, so afterAll's server.close() waits
      // forever on a socket the test merely started closing.
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
    }
  });

  it("still 401s a token-less upgrade — the broadcaster's own handler answers on the TLS path, not a permissive fallback", async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${tlsListen.boundPort}/v1/events`, {
      rejectUnauthorized: false,
    });
    const failure = await new Promise<Error>((resolve) => {
      ws.once("open", () => resolve(new Error("unexpected open")));
      ws.once("error", (err) => resolve(err));
    });
    expect(failure.message).toContain("401");
  });
});
