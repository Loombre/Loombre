// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/device-access-revocation.e2e.spec.ts
//
// AUD-A7b-001 (audit fafa47f, Fix Wave 3 / FW3-D): logout (POST
// /auth/logout) and per-device revoke (DELETE /devices/{id}) both killed
// the device's REFRESH token but left its already-issued ACCESS token
// live until its own natural ACCESS_TOKEN_TTL_MS expiry (15 minutes) —
// the same bug class R-F7 (STATE.md, migration 0026,
// users.password_changed_at_ms) already fixed for password changes, never
// extended to these two other revocation triggers. See
// apps/server/src/gateway/auth.guard.ts's verifyAndAttach (the device
// half of the check, migration 0034) and
// apps/server/src/session/refresh-token.service.ts's logout().
//
// Self-sufficient own ensureTestDatabase suffix — same convention as every
// other e2e spec in this directory (auth.e2e.spec.ts,
// remote-wireguard-devices.e2e.spec.ts).

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

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
    video: [
      {
        codec: "h264",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
        maxBitrateBps: 20_000_000,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let rawDb: ReturnType<typeof createDb>;

async function loginCasual(deviceName: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName,
      deviceProfile: buildDeviceProfile(),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { accessToken: string; refreshToken: string; deviceId: string };
}

function whoAmI(accessToken: string) {
  return request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${accessToken}`);
}

/**
 * R4 (Fix Wave 3 second review): sleeps until the wall clock has crossed
 * into a strictly LATER whole second than the one a token minted at or
 * before `mintedByMs` can possibly carry in its `iat`.
 *
 * Why the resurrection test needs this and is not merely being slow: JWT
 * `iat` is whole SECONDS (RFC 7519; token.service.ts floors `nowMs`
 * explicitly), so an access token minted in the SAME wall-clock second as
 * a later re-login is arithmetically indistinguishable from the one that
 * re-login itself mints — no epoch value can reject the first while
 * admitting the second. That ≤1s ambiguity is the irreducible residue of
 * the fix (see updateDeviceForLogin's header); everything OUTSIDE it must
 * stay dead, and this helper puts the token under test outside it.
 *
 * `mintedByMs` must be read AFTER the minting response is in hand, so it
 * is an upper bound on the server's own `nowMs` for that token: the
 * token's iat is then ≤ floor(mintedByMs/1000), while any login issued
 * after this helper returns sees `nowMs` ≥ (floor(mintedByMs/1000)+1)*1000
 * — strictly later second, deterministically, not probabilistically.
 */
function waitPastTokenSecond(mintedByMs: number): Promise<void> {
  const nextSecondMs = (Math.floor(mintedByMs / 1000) + 1) * 1000;
  const remainingMs = nextSecondMs - Date.now();
  if (remainingMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_device_access_revocation");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "device-access-revocation-e2e-secret-not-for-production";
  // Every `it` below logs in at least twice; keep the shared per-IP login
  // limiter out of the way (same reasoning as auth.e2e.spec.ts's own
  // beforeAll).
  process.env["LOOMBRE_RATE_LOGIN"] = "1000";
  // R1 (audit fafa47f, Fix Wave 3 review): the logout->relogin loop below
  // logs in and refreshes on the SAME identifier/device many times in a
  // row — keep loginByIdentifier/refreshByDevice (defaults 20/min,
  // 40/min) out of the way too, same generous-headroom precedent as
  // auth-account-rate-limit.e2e.spec.ts's beforeAll.
  process.env["LOOMBRE_RATE_LOGIN_BY_IDENTIFIER"] = "100000";
  process.env["LOOMBRE_RATE_REFRESH"] = "100000";
  process.env["LOOMBRE_RATE_REFRESH_BY_DEVICE"] = "100000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
});

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
  for (const key of [
    "LOOMBRE_RATE_LOGIN",
    "LOOMBRE_RATE_LOGIN_BY_IDENTIFIER",
    "LOOMBRE_RATE_REFRESH",
    "LOOMBRE_RATE_REFRESH_BY_DEVICE",
  ]) {
    delete process.env[key];
  }
});

describe("AUD-A7b-001: POST /auth/logout must kill the device's already-issued access token", () => {
  it("device A's pre-logout access token is rejected after logout; device B's is untouched", async () => {
    const deviceA = await loginCasual("access-revocation-logout-a");
    const deviceB = await loginCasual("access-revocation-logout-b");

    // Sanity: both access tokens work BEFORE logout.
    expect((await whoAmI(deviceA.accessToken)).status).toBe(200);
    expect((await whoAmI(deviceB.accessToken)).status).toBe(200);

    const logout = await request(app.getHttpServer())
      .post("/auth/logout")
      .set("Authorization", `Bearer ${deviceA.accessToken}`)
      .send({ deviceId: deviceA.deviceId });
    expect(logout.status).toBe(204);

    const afterA = await whoAmI(deviceA.accessToken);
    expect(
      afterA.status,
      "logout revoked the refresh token but the UI says the device was 'signed out' — the still-live access token must die too, not survive another ~15 minutes",
    ).toBe(401);

    // The other device must NOT be collaterally logged out — a fix that
    // invalidates every session is a different (worse) bug than the one
    // being fixed here.
    const stillB = await whoAmI(deviceB.accessToken);
    expect(stillB.status, "device B never logged out and must keep working").toBe(200);
  });
});

describe("AUD-A7b-001: DELETE /devices/{id} must kill the revoked device's already-issued access token", () => {
  it("the revoked device's pre-revoke access token is rejected after DELETE /devices/{id}; the acting device's own session is untouched", async () => {
    const lost = await loginCasual("access-revocation-delete-lost");
    const trusted = await loginCasual("access-revocation-delete-trusted");

    expect((await whoAmI(lost.accessToken)).status).toBe(200);

    // The realistic "sign out this lost device" flow: acting FROM a
    // trusted device's session, against the lost device's id.
    const revoke = await request(app.getHttpServer())
      .delete(`/devices/${lost.deviceId}`)
      .set("Authorization", `Bearer ${trusted.accessToken}`);
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);

    const afterLost = await whoAmI(lost.accessToken);
    expect(
      afterLost.status,
      "DELETE /devices/{id} revoked the refresh token and deleted the device row, but the lost device's still-live access token must stop working too",
    ).toBe(401);

    // The acting device's own still-live session must be unaffected.
    const stillTrusted = await whoAmI(trusted.accessToken);
    expect(stillTrusted.status, "the device that performed the revoke must not log itself out").toBe(200);
  });
});

describe("R1 (Fix Wave 3 review): logout followed by IMMEDIATE re-login on the SAME device must not mint a dead access token", () => {
  // FW3-D set devices.access_revoked_at_ms on logout so a still-live
  // access token dies with it (the two describes above). But the login
  // device-reuse branch (auth.controller.ts's `existingDevice` ->
  // revokeRefreshTokensForDevice + updateDeviceForLogin) never cleared
  // that epoch back to NULL, so a stale epoch from an EARLIER logout
  // survived into the NEXT login on the same device. auth.guard.ts
  // compares `claims.iat < Math.ceil(device.access_revoked_at_ms / 1000)`
  // — Math.ceil pushes that threshold strictly ABOVE any iat minted in the
  // same wall-clock second as the stale epoch, so a logout immediately
  // followed by a re-login mints an access token that is DOA for up to a
  // second, and — since iat only has second resolution — the SAME failure
  // recurs every time relogin lands in the same second as the logout that
  // preceded it. A single-shot test passes by luck roughly half the time;
  // this loops 12x back-to-back specifically to land astride that
  // boundary repeatedly (the reviewer's own reproduction was 12/12).
  const deviceName = "r1-relogin-same-device";
  const deviceProfile = buildDeviceProfile();

  it("12x back-to-back: whoami succeeds right after relogin, and refresh right after that also yields a live token", async () => {
    // A second, never-logged-out device — must keep working untouched by
    // anything this test does to the device under test (the OTHER half of
    // FW3-D's fix this must not regress).
    const bystander = await loginCasual("r1-relogin-bystander");
    expect((await whoAmI(bystander.accessToken)).status).toBe(200);

    let creds = await loginCasual(deviceName);

    for (let i = 0; i < 12; i++) {
      const preLogoutAccessToken = creds.accessToken;

      const logout = await request(app.getHttpServer())
        .post("/auth/logout")
        .set("Authorization", `Bearer ${preLogoutAccessToken}`)
        .send({ deviceId: creds.deviceId });
      expect(logout.status, `iteration ${i}: logout`).toBe(204);

      // FW3-D's actual fix must still hold: the PRE-logout token stays dead.
      const afterLogout = await whoAmI(preLogoutAccessToken);
      expect(afterLogout.status, `iteration ${i}: pre-logout token must still be rejected`).toBe(401);

      // The regression: immediate re-login on the SAME device.
      const relogin = await request(app.getHttpServer()).post("/auth/login").send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName,
        deviceProfile,
        deviceId: creds.deviceId,
      });
      expect(relogin.status, `iteration ${i}: relogin`).toBe(200);
      creds = relogin.body as typeof creds;

      const whoAfterRelogin = await whoAmI(creds.accessToken);
      expect(
        whoAfterRelogin.status,
        `iteration ${i}: brand-new access token from relogin must be live, not DOA`,
      ).toBe(200);

      // POST /auth/refresh immediately after relogin must also yield a
      // live token — the same stale-epoch hazard applies to the token
      // refresh mints, not just the one login mints directly.
      const refreshed = await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken: creds.refreshToken, deviceId: creds.deviceId });
      expect(refreshed.status, `iteration ${i}: refresh`).toBe(200);

      const whoAfterRefresh = await whoAmI(refreshed.body.accessToken);
      expect(whoAfterRefresh.status, `iteration ${i}: refreshed access token must be live`).toBe(200);

      creds = { ...creds, accessToken: refreshed.body.accessToken, refreshToken: refreshed.body.refreshToken };
    }

    // The bystander device's session must have been unaffected the whole
    // time — moving the epoch on relogin must stay scoped to the one
    // device being logged back into.
    expect((await whoAmI(bystander.accessToken)).status).toBe(200);
  });
});

describe("R4 (Fix Wave 3 second review): re-login must not RESURRECT an access token an earlier logout already killed", () => {
  // R1 fixed FW3-D's DOA regression by clearing devices.access_revoked_at_ms
  // back to NULL on every device-reuse login — and NULL unconditionally
  // passes auth.guard.ts's check. So an access token captured BEFORE a
  // logout, correctly 401'd right after that logout, went back to 200 the
  // moment the same device logged in again, for the rest of its ~15-minute
  // TTL. Reviewer's live reproduction:
  //   stolen 200 -> logout 204 -> stolen 401 -> same-device relogin -> stolen 200.
  // Re-login is the single most common thing a user does after signing out,
  // and signing out is exactly what a user does when they suspect theft.
  //
  // The describe above pins the opposite property (a relogin's OWN token
  // must be live). Both are asserted in the SAME loop here on purpose:
  // every previous attempt at this logic satisfied one of them by breaking
  // the other, and only a test that checks both in one pass can tell a fix
  // from a trade.
  const deviceName = "r4-resurrection-same-device";
  const deviceProfile = buildDeviceProfile();

  it("the ORIGINAL pre-logout token stays 401 across a same-device re-login, while the relogin's own token is live", async () => {
    const bystander = await loginCasual("r4-resurrection-bystander");
    expect((await whoAmI(bystander.accessToken)).status).toBe(200);

    let creds = await loginCasual(deviceName);

    for (let i = 0; i < 4; i++) {
      // The token an attacker holds. Read the clock AFTER the response so
      // it upper-bounds the server's own minting `nowMs` — see
      // waitPastTokenSecond's header.
      const stolen = creds.accessToken;
      const stolenMintedByMs = Date.now();

      expect((await whoAmI(stolen)).status, `iteration ${i}: stolen token starts live`).toBe(200);

      await waitPastTokenSecond(stolenMintedByMs);

      const logout = await request(app.getHttpServer())
        .post("/auth/logout")
        .set("Authorization", `Bearer ${stolen}`)
        .send({ deviceId: creds.deviceId });
      expect(logout.status, `iteration ${i}: logout`).toBe(204);

      expect((await whoAmI(stolen)).status, `iteration ${i}: logout must kill the stolen token`).toBe(401);

      const relogin = await request(app.getHttpServer()).post("/auth/login").send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName,
        deviceProfile,
        deviceId: creds.deviceId,
      });
      expect(relogin.status, `iteration ${i}: relogin`).toBe(200);
      creds = relogin.body as typeof creds;

      // Property 1 (no DOA) — the relogin's own brand-new token must work.
      expect(
        (await whoAmI(creds.accessToken)).status,
        `iteration ${i}: the relogin's own access token must be live, not DOA`,
      ).toBe(200);

      // Property 2 (no resurrection) — THE defect this lane exists for.
      // The stolen token predates the logout by a full second boundary, so
      // no ambiguity excuses admitting it.
      expect(
        (await whoAmI(stolen)).status,
        `iteration ${i}: the pre-logout token was already revoked — re-logging the same device in must NOT bring it back to life`,
      ).toBe(401);

      // Property 3 (no collateral) — an unrelated device's session is not
      // signed out by any of this.
      expect(
        (await whoAmI(bystander.accessToken)).status,
        `iteration ${i}: the bystander device never logged out and must keep working`,
      ).toBe(200);
    }
    // Each iteration parks on a real second boundary (waitPastTokenSecond)
    // — up to ~1s of genuine wall clock apiece, which the package's 5s
    // default testTimeout does not budget for. House idiom for a suite
    // that legitimately takes real time (admin-sessions.e2e.spec.ts et al).
  }, 30_000);
});
