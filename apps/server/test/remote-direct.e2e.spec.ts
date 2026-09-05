// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-direct.e2e.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5, RG12, RG15, this lane's mission).
// HTTP-level proof for the Direct path's three ops:
//   - POST /admin/remote/direct/acme-test   testRemoteDirectAcme
//   - POST /admin/remote/direct/enable      enableRemoteDirect
//   - POST /admin/remote/direct/disable     disableRemoteDirect
//
// SCOPE SPLIT (deliberate, per this lane's report): the REAL end-to-end
// ACME issuance proof against a live ACME server lives in
// test/tls/remote-direct-acme-feasibility.integration.spec.ts (pebble-
// gated, "RG12 feasibility"). This file proves the ADMIN HTTP SURFACE —
// auth walls, request validation, the settings commit + cross-field
// invariant interplay, the internal-state snapshot/revert, and the 409/422
// error shapes — using a REAL self-signed certificate pre-seeded into the
// cert store (apps/server/src/tls/test-support/self-signed-cert.ts) for
// the enable/disable happy paths, which need "a valid cert for this
// domain exists" to be true WITHOUT needing a real CA round-trip. The one
// exception: testRemoteDirectAcme's own success path genuinely needs a
// real ACME server (that's the OTHER file's job); this file instead proves
// its FAILURE path deterministically (an unreachable ACME directory URL —
// no pebble dependency, no network flake risk).
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed, own
// throwaway LOOMBRE_DATA_DIR).

import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { generateSelfSignedCert, type SelfSignedCert } from "../src/tls/test-support/self-signed-cert.js";
import { persistIssuedCertificate } from "../src/tls/acme/cert-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
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

let app: INestApplication;
let adminToken: string;
let casualToken: string;
let dataDir: string;
let settingsService: SettingsService;

const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_direct_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-direct-test-secret-not-for-production";

  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-remote-direct-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  settingsService = app.get(SettingsService);

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "remote-direct-test-admin",
    deviceProfile: buildDeviceProfile("remote-direct-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "remote-direct-test-casual",
    deviceProfile: buildDeviceProfile("remote-direct-test-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

/** Resets every settings key this suite touches back to the registry
 *  default, and disables the Direct path, between tests — a real DB shared
 *  across `it` blocks in this file (not a fresh service per test, unlike
 *  settings.service.spec.ts, since this suite exercises the REAL HTTP
 *  surface end-to-end). */
beforeEach(async () => {
  await request(app.getHttpServer()).post("/admin/remote/direct/disable").set("Authorization", `Bearer ${adminToken}`);
  for (const key of ["tls.acmeDomains", "tls.acmeChallengeType", "tls.acmeTosAgreed", "network.trustProxy"] as const) {
    const current = settingsService.getEffective(key);
    if (current?.source === "database") {
      const registryDefault = key === "tls.acmeDomains" ? [] : key === "tls.acmeChallengeType" ? "http-01" : key === "tls.acmeTosAgreed" ? false : "";
      await request(app.getHttpServer())
        .put(`/admin/settings/${key}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ value: registryDefault });
    }
  }
});

function callerFor(token: string) {
  const server = () => app.getHttpServer();
  return {
    post: (url: string, body?: unknown) => {
      const req = request(server()).post(url).set("Authorization", `Bearer ${token}`);
      return body === undefined ? req : req.send(body as Record<string, unknown>);
    },
  };
}
function asAdmin() {
  return callerFor(adminToken);
}
function asCasual() {
  return callerFor(casualToken);
}

const OPS = ["admin/remote/direct/acme-test", "admin/remote/direct/enable", "admin/remote/direct/disable"];

describe("auth walls", () => {
  it("every op 401s unauthenticated with an RFC 9457 problem body", async () => {
    for (const op of OPS) {
      const res = await request(app.getHttpServer()).post(`/${op}`);
      expect(res.status, op).toBe(401);
      expect(res.headers["content-type"], op).toMatch(/^application\/problem\+json/);
    }
  });

  it("every op 403s for a non-admin (casual) token", async () => {
    for (const op of OPS) {
      const res = await asCasual().post(`/${op}`);
      expect(res.status, op).toBe(403);
      expect(res.headers["content-type"], op).toMatch(/^application\/problem\+json/);
    }
  });
});

describe("POST /admin/remote/direct/acme-test", () => {
  it("422s bodyless — domain is required", async () => {
    const res = await asAdmin().post("/admin/remote/direct/acme-test");
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("422s on a syntactically invalid domain (bare IP)", async () => {
    const res = await asAdmin().post("/admin/remote/direct/acme-test", { domain: "203.0.113.10" });
    expect(res.status).toBe(422);
  });

  it("422s on an unknown property (additionalProperties:false made real)", async () => {
    const res = await asAdmin().post("/admin/remote/direct/acme-test", { domain: "media.example.com", challengeType: "dns-01" });
    expect(res.status).toBe(422);
  });

  it("200s with {success:false, detail} when the http-01 listener port is already bound — never a 500, never touches tls.mode", async () => {
    // A deterministic, FAST failure mode (unlike a network-unreachable ACME
    // directory, which drives acme-client's own multi-attempt retry/backoff
    // policy well past any sane test timeout) — this is also a REAL
    // production failure shape (docs/ops/remote-access/acme.md's whole "the port story,
    // honestly" section): something else already has LOOMBRE_HTTP_PORT.
    // The blocker takes an OS-assigned port (0), never a fixed one: a fixed
    // number in Linux's ephemeral range (32768–60999) is exactly what any
    // concurrently running test's outgoing connection can be holding, and
    // the blocker's own bind then fails with EADDRINUSE before the request
    // under test is ever made.
    const { createServer } = await import("node:net");
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "0.0.0.0", () => resolve());
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") throw new Error("blocker did not bind a TCP port");
    const original = process.env["LOOMBRE_HTTP_PORT"];
    process.env["LOOMBRE_HTTP_PORT"] = String(address.port);
    try {
      const res = await asAdmin().post("/admin/remote/direct/acme-test", { domain: "port-in-use.example.com" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.detail).toBe("string");
      expect(res.body.detail.length).toBeGreaterThan(0);
    } finally {
      if (original === undefined) delete process.env["LOOMBRE_HTTP_PORT"];
      else process.env["LOOMBRE_HTTP_PORT"] = original;
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    expect(settingsService.getEffective("tls.mode")?.value).toBe("off");
  });
});

describe("POST /admin/remote/direct/enable — mode: acme", () => {
  let cert: SelfSignedCert;
  beforeEach(() => {
    cert = generateSelfSignedCert("staged-test-domain.example.com");
  });

  it("422s bodyless — mode is required", async () => {
    const res = await asAdmin().post("/admin/remote/direct/enable");
    expect(res.status).toBe(422);
  });

  it("422s an unknown mode value", async () => {
    const res = await asAdmin().post("/admin/remote/direct/enable", { mode: "bogus" });
    expect(res.status).toBe(422);
  });

  it("422s mode:acme with no domain", async () => {
    const res = await asAdmin().post("/admin/remote/direct/enable", { mode: "acme" });
    expect(res.status).toBe(422);
  });

  it("422s mode:acme when no staged cert exists for that domain yet — the acme-test-first requirement", async () => {
    const res = await asAdmin().post("/admin/remote/direct/enable", { mode: "acme", domain: "never-tested.example.com" });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/staged ACME test/i);
    cert.cleanup();
  });

  it("succeeds once a valid staged cert for the exact domain is present — commits tls.mode/acmeDomains/acmeChallengeType/acmeTosAgreed, returns RemoteDirectStatus", async () => {
    persistIssuedCertificate(dataDir, { certPem: cert.cert, keyPem: cert.key, notBeforeMs: 0, notAfterMs: 0 });

    const res = await asAdmin().post("/admin/remote/direct/enable", { mode: "acme", domain: "staged-test-domain.example.com" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, mode: "acme", domain: "staged-test-domain.example.com", certValid: true });
    expect(res.body.certExpiresAtMs).toBeGreaterThan(Date.now());

    expect(settingsService.getEffective("tls.mode")?.value).toBe("acme");
    expect(settingsService.getEffective("tls.acmeDomains")?.value).toEqual(["staged-test-domain.example.com"]);
    expect(settingsService.getEffective("tls.acmeChallengeType")?.value).toBe("http-01");
    expect(settingsService.getEffective("tls.acmeTosAgreed")?.value).toBe(true);

    cert.cleanup();
  });

  it("422s when the persisted cert doesn't cover the requested domain (real X509 checkHost, never trusts 'a cert exists')", async () => {
    persistIssuedCertificate(dataDir, { certPem: cert.cert, keyPem: cert.key, notBeforeMs: 0, notAfterMs: 0 });
    const res = await asAdmin().post("/admin/remote/direct/enable", { mode: "acme", domain: "a-completely-different-domain.example.com" });
    expect(res.status).toBe(422);
    cert.cleanup();
  });
});

describe("POST /admin/remote/direct/enable — mode: reverse-proxy", () => {
  it("422s when network.trustProxy is not yet configured", async () => {
    const res = await asAdmin().post("/admin/remote/direct/enable", { mode: "reverse-proxy" });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/trustProxy/);
  });

  it("succeeds once network.trustProxy is configured via the general settings screen; domain is ignored", async () => {
    const put = await request(app.getHttpServer())
      .put("/admin/settings/network.trustProxy")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: "1" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const res = await asAdmin().post("/admin/remote/direct/enable", { mode: "reverse-proxy", domain: "ignored.example.com" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ enabled: true, mode: "reverse-proxy", domain: null, certValid: null, certExpiresAtMs: null });
  });
});

describe("POST /admin/remote/direct/disable", () => {
  it("is idempotent — 200 with a disabled status when nothing is enabled", async () => {
    const res = await asAdmin().post("/admin/remote/direct/disable");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null });
  });

  it("reverts tls.mode to its PRE-enable value (off) after an acme enable", async () => {
    const cert = generateSelfSignedCert("disable-revert-tls.example.com");
    try {
      persistIssuedCertificate(dataDir, { certPem: cert.cert, keyPem: cert.key, notBeforeMs: 0, notAfterMs: 0 });
      const enableRes = await asAdmin().post("/admin/remote/direct/enable", { mode: "acme", domain: "disable-revert-tls.example.com" });
      expect(enableRes.status, JSON.stringify(enableRes.body)).toBe(200);
      expect(settingsService.getEffective("tls.mode")?.value).toBe("acme");

      const disableRes = await asAdmin().post("/admin/remote/direct/disable");
      expect(disableRes.status).toBe(200);
      expect(disableRes.body).toEqual({ enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null });
      expect(settingsService.getEffective("tls.mode")?.value).toBe("off");
    } finally {
      cert.cleanup();
    }
  });

  it("reverts network.trustProxy to its PRE-enable value on disable, even when it was edited AGAIN while Direct stayed active", async () => {
    // enableRemoteDirect(reverse-proxy) never WRITES trustProxy itself (the
    // frozen EnableRemoteDirectRequest carries no such field — see this
    // file's header adjudication); an admin sets it via the general
    // settings screen, both before AND potentially again during. This test
    // proves disable's revert targets the snapshot taken at enable TIME,
    // not whatever trustProxy happens to hold at disable time.
    await request(app.getHttpServer())
      .put("/admin/settings/network.trustProxy")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: "10.0.0.0/8" }); // the PRE-enable value — this is what disable must restore

    const enableRes = await asAdmin().post("/admin/remote/direct/enable", { mode: "reverse-proxy" });
    expect(enableRes.status, JSON.stringify(enableRes.body)).toBe(200);

    // Admin edits it again WHILE Direct is still active (mid-flight, via
    // the general settings screen — not through this controller at all).
    await request(app.getHttpServer())
      .put("/admin/settings/network.trustProxy")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: "loopback" });
    expect(settingsService.getEffective("network.trustProxy")?.value).toBe("loopback");

    const disableRes = await asAdmin().post("/admin/remote/direct/disable");
    expect(disableRes.status).toBe(200);
    // Reverted to the ORIGINAL pre-enable snapshot, not the mid-flight edit.
    expect(settingsService.getEffective("network.trustProxy")?.value).toBe("10.0.0.0/8");
  });

  it("a re-entry (mode switch within Direct) then disable reverts to the ORIGINAL pre-Direct snapshot, not an intermediate one", async () => {
    // The ORIGINAL pre-Direct value for THIS test — must be non-empty
    // because the FIRST enable below is reverse-proxy mode (which requires
    // it), so it's ALSO what the successful first enable call snapshots.
    await request(app.getHttpServer())
      .put("/admin/settings/network.trustProxy")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: "original-pre-direct-value" });
    const cert = generateSelfSignedCert("reentry-snapshot.example.com");
    try {
      const first = await asAdmin().post("/admin/remote/direct/enable", { mode: "reverse-proxy" });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(settingsService.getEffective("tls.mode")?.value).toBe("off"); // reverse-proxy never touches tls.mode

      // Re-entry: switch to acme WITHOUT ever going through disable first —
      // must reuse the ORIGINAL snapshot taken at the FIRST enable, not
      // re-snapshot Direct's own already-applied values.
      persistIssuedCertificate(dataDir, { certPem: cert.cert, keyPem: cert.key, notBeforeMs: 0, notAfterMs: 0 });
      const second = await asAdmin().post("/admin/remote/direct/enable", { mode: "acme", domain: "reentry-snapshot.example.com" });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(settingsService.getEffective("tls.mode")?.value).toBe("acme");
      // trustProxy is untouched by the acme branch — still the original
      // pre-Direct value, never re-snapshotted mid-streak.
      expect(settingsService.getEffective("network.trustProxy")?.value).toBe("original-pre-direct-value");

      const disableRes = await asAdmin().post("/admin/remote/direct/disable");
      expect(disableRes.status).toBe(200);
      // The snapshot must be the ORIGINAL pre-Direct values from the FIRST
      // enable call, not anything the SECOND (acme) enable itself applied.
      expect(settingsService.getEffective("tls.mode")?.value).toBe("off");
      expect(settingsService.getEffective("network.trustProxy")?.value).toBe("original-pre-direct-value");
    } finally {
      cert.cleanup();
    }
  });
});
