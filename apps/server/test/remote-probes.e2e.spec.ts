// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-probes.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for STATE.md "Loombre Remote — embedded WireGuard + three-path
// wizard + reachability proof + posture card" (R6/RG6/RG11, Lane P1's
// mission: "the one-time-token reachability proof, end to end").
//
// Covers: full lifecycle (mint -> visit -> arrived -> second visit 404 ->
// poll shows arrived), expiry (direct-DB short-expiry injection, the SAME
// pattern password-recovery.e2e.spec.ts's issuePasswordResetToken calls
// establish — no fake timers anywhere in this repo's e2e suites), single-
// use race (two concurrent first visits), byte-identical-404, 429 rate
// limit (env-pinned-capacity second app instance, password-recovery.e2e.
// spec.ts's own pattern), Tunnel-path connector-health short-circuit and
// DNS-failure diagnosis (both via `vi.spyOn(app.get(...), ...)`, the
// MailConfigService seam-testing precedent), and the guidance-mapping
// wiring (packages/shared/test/remote/diagnosis-guidance.test.ts owns the
// exhaustive PathId × DiagnosisCode matrix; this suite only proves the
// HTTP surface actually renders it).
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase, getUserByUsername, mintProbeToken } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { applySecurityHeaders, disableXPoweredBy } from "../src/main.js";
import { ConnectorHealthReaderService } from "../src/remote/connector-health.service.js";
import { RemoteDnsResolverService } from "../src/remote/remote-dns-resolver.service.js";
import { PROBE_SUCCESS_HTML } from "../src/remote/probe-page.controller.js";

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

function buildDeviceProfile(profileId = "web-chrome") {
  return {
    profileId,
    directPlayContainers: ["mp4", "mkv"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let databaseUrl: string;
let adminAccessToken: string;
let casualAccessToken: string;

async function loginAs(username: string, password: string): Promise<{ accessToken: string }> {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `e2e-${username}-${Date.now()}`, deviceProfile: buildDeviceProfile(username) });
  expect(res.status, `login as ${username} failed: ${JSON.stringify(res.body)}`).toBe(200);
  return { accessToken: res.body.accessToken };
}

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_probes_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-probes-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "1000";
  process.env["LOOMBRE_RATE_REFRESH"] = "1000";
  process.env["LOOMBRE_RATE_PROBE"] = "1000";

  app = await NestFactory.create(AppModule, { logger: false });
  applySecurityHeaders(app);
  disableXPoweredBy(app);
  await app.init();

  const admin = await loginAs("admin", "loombre-seed-admin");
  adminAccessToken = admin.accessToken;
  const casual = await loginAs("casual", "loombre-seed-casual");
  casualAccessToken = casual.accessToken;
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /admin/remote/probes (createRemoteProbe) — auth wall + validation", () => {
  it("401 unauthenticated", async () => {
    const res = await request(app.getHttpServer()).post("/admin/remote/probes").send({ expectedEndpoint: "x", path: "direct" });
    expect(res.status).toBe(401);
  });

  it("403 for a non-admin caller", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${casualAccessToken}`)
      .send({ expectedEndpoint: "x", path: "direct" });
    expect(res.status).toBe(403);
  });

  it("422 bodyless", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send();
    expect(res.status).toBe(422);
  });

  it("422 on missing path", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com" });
    expect(res.status).toBe(422);
  });

  it("422 on path='none' (not a real setup-flow path)", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com", path: "none" });
    expect(res.status).toBe(422);
  });

  it("422 on an unknown body property", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com", path: "direct", extra: true });
    expect(res.status).toBe(422);
  });

  it("201 with {id, probeUrl, qrPayload, expiresAtMs} — the plaintext token appears exactly once, embedded in probeUrl/qrPayload", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com", path: "direct" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(typeof res.body.id).toBe("string");
    expect(res.body.probeUrl).toBe(res.body.qrPayload);
    expect(res.body.probeUrl).toMatch(/^https:\/\/loombre\.example\.com\/probe\/[A-Za-z0-9_-]+$/);
    expect(typeof res.body.expiresAtMs).toBe("number");
    // 15-minute expiry (R6), generous bounds for test-run jitter.
    expect(res.body.expiresAtMs).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(res.body.expiresAtMs).toBeLessThan(Date.now() + 16 * 60 * 1000);
  });
});

describe("full lifecycle: mint -> visit -> arrived -> second visit 404 -> poll shows arrived", () => {
  it("end to end", async () => {
    const minted = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com", path: "direct" });
    expect(minted.status).toBe(201);
    const probeId: string = minted.body.id;
    const token: string = minted.body.probeUrl.split("/probe/")[1];

    const pendingPoll = await request(app.getHttpServer())
      .get(`/admin/remote/probes/${probeId}`)
      .set("Authorization", `Bearer ${adminAccessToken}`);
    expect(pendingPoll.status).toBe(200);
    expect(pendingPoll.body).toEqual({ id: probeId, status: "pending", arrivedAtMs: null, diagnosis: null });

    const firstVisit = await request(app.getHttpServer()).get(`/probe/${token}`);
    expect(firstVisit.status).toBe(200);
    expect(firstVisit.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(firstVisit.text).toBe(PROBE_SUCCESS_HTML);

    const secondVisit = await request(app.getHttpServer()).get(`/probe/${token}`);
    expect(secondVisit.status).toBe(404);

    const arrivedPoll = await request(app.getHttpServer())
      .get(`/admin/remote/probes/${probeId}`)
      .set("Authorization", `Bearer ${adminAccessToken}`);
    expect(arrivedPoll.status).toBe(200);
    expect(arrivedPoll.body.status).toBe("arrived");
    expect(typeof arrivedPoll.body.arrivedAtMs).toBe("number");
    expect(arrivedPoll.body.diagnosis).toBeNull();
  });

  // The probe.arrived event's own shape (admin-only, no token/hash/
  // expectedEndpoint in the payload — R9), the atomic single-use consume,
  // and the concurrency race are all covered at the DB layer, closer to
  // the mechanism: packages/db/test/remote-probes.spec.ts.
});

describe("byte-identical 404 (unknown/expired/used tokens, and the catch-all)", () => {
  it("an unknown/never-issued token 404s byte-identically to the catch-all route", async () => {
    const unknownRoute = await request(app.getHttpServer())
      .get("/this-route-does-not-exist-remote-probes")
      .set("Authorization", `Bearer ${adminAccessToken}`);
    const res = await request(app.getHttpServer()).get("/probe/garbage-token-never-issued");

    expect(res.status).toBe(404);
    expect(unknownRoute.status).toBe(404);
    expect(res.headers["content-type"]).toBe(unknownRoute.headers["content-type"]);
    expect(res.text).toBe(unknownRoute.text);
    expect(JSON.parse(res.text)).toEqual({ type: "about:blank", title: "Not Found", status: 404 });
  });

  it("expired, already-used, and garbage tokens are byte-identical to each other", async () => {
    const db = createDb(databaseUrl);
    const expiredToken = "expired-plaintext-remote-probe-0123456789abcdef";
    const usedToken = "used-plaintext-remote-probe-0123456789abcdef";
    try {
      const admin = await getUserByUsername(db, "admin");
      const adminId = admin!.id;

      await mintProbeToken(db, {
        tokenHash: createHash("sha256").update(expiredToken).digest("hex"),
        expectedEndpoint: "loombre.example.com",
        path: "direct",
        createdBy: adminId,
        createdAtMs: Date.now() - 60 * 60 * 1000,
        expiresAtMs: Date.now() - 60 * 1000,
      });
      await mintProbeToken(db, {
        tokenHash: createHash("sha256").update(usedToken).digest("hex"),
        expectedEndpoint: "loombre.example.com",
        path: "direct",
        createdBy: adminId,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      });
    } finally {
      await db.destroy();
    }

    // Burn the "used" token first.
    await request(app.getHttpServer()).get(`/probe/${usedToken}`);

    const expiredAttempt = await request(app.getHttpServer()).get(`/probe/${expiredToken}`);
    const usedAttempt = await request(app.getHttpServer()).get(`/probe/${usedToken}`);
    const garbageAttempt = await request(app.getHttpServer()).get("/probe/totally-unknown-token-xyz");

    expect(expiredAttempt.status).toBe(404);
    expect(usedAttempt.status).toBe(404);
    expect(garbageAttempt.status).toBe(404);
    expect(expiredAttempt.text).toBe(usedAttempt.text);
    expect(usedAttempt.text).toBe(garbageAttempt.text);
  });
});

describe("the success page's exact response headers (V-SEC: zero server info)", () => {
  it("carries no server-identifying header beyond main.ts's global security headers + unavoidable HTTP framing", async () => {
    const minted = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com", path: "direct" });
    const token: string = minted.body.probeUrl.split("/probe/")[1];

    const res = await request(app.getHttpServer()).get(`/probe/${token}`);
    expect(res.status).toBe(200);

    const headerNames = Object.keys(res.headers).sort();
    expect(headerNames).not.toContain("x-powered-by");
    expect(headerNames).not.toContain("etag");
    expect(headerNames).not.toContain("server");
    // The exact, closed allow-list — see this suite's own commentary
    // (report to the orchestrator): main.ts's global security headers
    // (applySecurityHeaders) plus the unavoidable HTTP/Express framing
    // headers for a plain res.end() response.
    for (const name of headerNames) {
      expect(
        [
          "content-type",
          "content-length",
          "date",
          "connection",
          "keep-alive",
          "x-content-type-options",
          "referrer-policy",
          "x-frame-options",
          "permissions-policy",
          "cross-origin-resource-policy",
          "cross-origin-opener-policy",
          "vary",
        ],
        `unexpected header on the probe success page: ${name}`,
      ).toContain(name);
    }
  });
});

describe("single-use race: two concurrent first visits — exactly one 200, one 404", () => {
  it("proven at the HTTP layer", async () => {
    const minted = await request(app.getHttpServer())
      .post("/admin/remote/probes")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com", path: "remote" });
    const token: string = minted.body.probeUrl.split("/probe/")[1];

    const [a, b] = await Promise.all([
      request(app.getHttpServer()).get(`/probe/${token}`),
      request(app.getHttpServer()).get(`/probe/${token}`),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 404]);
  });
});

describe("expiry (direct-DB short-expiry injection — password-recovery.e2e.spec.ts's own time-testing pattern; nowMs() is the seam, no fake timers)", () => {
  it("an expired-but-never-arrived token: GET /probe/{token} 404s, and getRemoteProbe's poll shows status:expired with a populated diagnosis", async () => {
    const db = createDb(databaseUrl);
    const token = "expiry-lifecycle-plaintext-0123456789abcdef";
    let probeId: string;
    try {
      const admin = await getUserByUsername(db, "admin");
      const row = await mintProbeToken(db, {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expectedEndpoint: "loombre.example.com",
        path: "direct",
        createdBy: admin!.id,
        createdAtMs: Date.now() - 20 * 60 * 1000,
        expiresAtMs: Date.now() - 60 * 1000, // expired a minute ago
      });
      probeId = row.id;
    } finally {
      await db.destroy();
    }

    const visit = await request(app.getHttpServer()).get(`/probe/${token}`);
    expect(visit.status).toBe(404);

    const dnsResolver = app.get(RemoteDnsResolverService);
    const spy = vi.spyOn(dnsResolver, "resolvePublicAddress").mockResolvedValue("203.0.113.10");
    try {
      const poll = await request(app.getHttpServer())
        .get(`/admin/remote/probes/${probeId}`)
        .set("Authorization", `Bearer ${adminAccessToken}`);
      expect(poll.status).toBe(200);
      expect(poll.body.status).toBe("expired");
      expect(poll.body.arrivedAtMs).toBeNull();
      expect(poll.body.diagnosis).not.toBeNull();
      expect(typeof poll.body.diagnosis.code).toBe("string");
      expect(typeof poll.body.diagnosis.detail).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /admin/remote/diagnosis (diagnoseRemote) — validation + Tunnel-path short-circuit + DNS-failure handling", () => {
  it("401 unauthenticated / 403 non-admin", async () => {
    const unauth = await request(app.getHttpServer()).post("/admin/remote/diagnosis").send({ expectedEndpoint: "x", path: "direct" });
    expect(unauth.status).toBe(401);
    const forbidden = await request(app.getHttpServer())
      .post("/admin/remote/diagnosis")
      .set("Authorization", `Bearer ${casualAccessToken}`)
      .send({ expectedEndpoint: "x", path: "direct" });
    expect(forbidden.status).toBe(403);
  });

  it("422 bodyless, 422 on missing path, 422 on path='none'", async () => {
    const bodyless = await request(app.getHttpServer())
      .post("/admin/remote/diagnosis")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send();
    expect(bodyless.status).toBe(422);

    const missingPath = await request(app.getHttpServer())
      .post("/admin/remote/diagnosis")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com" });
    expect(missingPath.status).toBe(422);

    const nonePath = await request(app.getHttpServer())
      .post("/admin/remote/diagnosis")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre.example.com", path: "none" });
    expect(nonePath.status).toBe(422);
  });

  it("Tunnel-path short-circuit: a 'down' connector reports tunnelDown WITHOUT ever calling the DNS resolver", async () => {
    const connectorHealthReader = app.get(ConnectorHealthReaderService);
    const dnsResolver = app.get(RemoteDnsResolverService);
    const healthSpy = vi.spyOn(connectorHealthReader, "read").mockResolvedValue("down");
    const dnsSpy = vi.spyOn(dnsResolver, "resolvePublicAddress");
    try {
      const res = await request(app.getHttpServer())
        .post("/admin/remote/diagnosis")
        .set("Authorization", `Bearer ${adminAccessToken}`)
        .send({ expectedEndpoint: "tunnel.example.com", path: "tunnel" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.code).toBe("tunnelDown");
      expect(typeof res.body.detail).toBe("string");
      expect(dnsSpy).not.toHaveBeenCalled();
    } finally {
      healthSpy.mockRestore();
      dnsSpy.mockRestore();
    }
  });

  it("Tunnel-path short-circuit: a 'degraded' connector reports connectorUnhealthy", async () => {
    const connectorHealthReader = app.get(ConnectorHealthReaderService);
    const healthSpy = vi.spyOn(connectorHealthReader, "read").mockResolvedValue("degraded");
    try {
      const res = await request(app.getHttpServer())
        .post("/admin/remote/diagnosis")
        .set("Authorization", `Bearer ${adminAccessToken}`)
        .send({ expectedEndpoint: "tunnel.example.com", path: "tunnel" });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe("connectorUnhealthy");
    } finally {
      healthSpy.mockRestore();
    }
  });

  it("DNS-failure diagnosis: an unresolvable expectedEndpoint -> dnsMismatch with a distinguishing detail", async () => {
    const dnsResolver = app.get(RemoteDnsResolverService);
    const spy = vi.spyOn(dnsResolver, "resolvePublicAddress").mockResolvedValue(null);
    try {
      const res = await request(app.getHttpServer())
        .post("/admin/remote/diagnosis")
        .set("Authorization", `Bearer ${adminAccessToken}`)
        .send({ expectedEndpoint: "does-not-resolve.invalid", path: "direct", wanAddress: "198.51.100.1" });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe("dnsMismatch");
      expect(res.body.detail).toContain("does not resolve at all");
    } finally {
      spy.mockRestore();
    }
  });

  it("real DNS resolution against a genuinely unroutable hostname also NXDOMAINs and reaches the same dnsMismatch signal (proves node:dns wiring end-to-end, not just the stubbed path)", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/remote/diagnosis")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ expectedEndpoint: "loombre-remote-diagnosis-e2e-unresolvable.invalid", path: "direct", wanAddress: "198.51.100.1" });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("dnsMismatch");
    expect(res.body.detail).toContain("does not resolve at all");
  });

  it("guidance-mapping wiring: the response detail matches packages/shared's diagnosisGuidance for the returned (path, code)", async () => {
    const dnsResolver = app.get(RemoteDnsResolverService);
    const spy = vi.spyOn(dnsResolver, "resolvePublicAddress").mockResolvedValue("100.64.5.5"); // CGNAT range
    try {
      const res = await request(app.getHttpServer())
        .post("/admin/remote/diagnosis")
        .set("Authorization", `Bearer ${adminAccessToken}`)
        .send({ expectedEndpoint: "remote.example.com", path: "remote", wanAddress: "100.64.5.5" });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe("cgnat");
      const { diagnosisGuidance } = await import("@loombre/shared");
      expect(res.body.detail).toBe(diagnosisGuidance("remote", "cgnat"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("rate limiting (probe policy, GET /probe/{token}, M12)", () => {
  let lowCapApp: INestApplication;

  beforeAll(async () => {
    process.env["LOOMBRE_RATE_PROBE"] = "2";
    lowCapApp = await NestFactory.create(AppModule, { logger: false });
    await lowCapApp.init();
  });

  afterAll(async () => {
    await lowCapApp.close();
    process.env["LOOMBRE_RATE_PROBE"] = "1000";
  });

  it("trips 429 + Retry-After after LOOMBRE_RATE_PROBE attempts from the same IP", async () => {
    const first = await request(lowCapApp.getHttpServer()).get("/probe/rl-probe-1");
    expect(first.status).toBe(404); // still under the cap, just an unknown token
    const second = await request(lowCapApp.getHttpServer()).get("/probe/rl-probe-2");
    expect(second.status).toBe(404);

    const tripped = await request(lowCapApp.getHttpServer()).get("/probe/rl-probe-3");
    expect(tripped.status).toBe(429);
    expect(tripped.headers["retry-after"]).toBeDefined();
  });
});
