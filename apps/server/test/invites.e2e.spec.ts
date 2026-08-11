// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/invites.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for E2 (invitations) — "Optional mail transport + invitation &
// reset flows that work without it" (STATE.md, Lane A). Mirrors
// auth.e2e.spec.ts/setup.e2e.spec.ts's own boot pattern.
//
// E1 headline requirement: the ENTIRE invite->claim flow proves out with
// ZERO mail configuration (MailConfigService.isConfigured() is Lane A's
// stub — always false) — see "the whole flow, zero mail config" describe
// block below.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { MailConfigService } from "../src/mail/mail-config.service.js";
import { MailDispatchService } from "../src/mail/mail-dispatch.service.js";

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
let adminToken: string;
let casualToken: string;
let generalLibraryId: string;
let restrictedLibraryId: string;

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `invites-e2e-${username}-${Date.now()}-${Math.random()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

interface EventRow {
  type: string;
  payload: Record<string, unknown>;
  actor_user_id: string | null;
}
async function latestEvent(type: string, matcher: (p: Record<string, unknown>) => boolean): Promise<EventRow | undefined> {
  const rows = await rawDb.selectFrom("events").select(["type", "payload", "actor_user_id"]).where("type", "=", type).orderBy("ts_ms", "desc").limit(50).execute();
  return (rows as EventRow[]).find((r) => matcher(r.payload));
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_invites");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "invites-e2e-test-secret-not-for-production";
  // High enough that the N-concurrent-claims race test (below) and the
  // rest of this file's many requests never trip the claim limiter itself
  // — that limiter's own trip behavior is out of this file's scope.
  process.env["LOOMBRE_RATE_CLAIM"] = "10000";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
  adminToken = await loginAs("admin", "loombre-seed-admin");
  casualToken = await loginAs("casual", "loombre-seed-casual");

  const libs = await rawDb.selectFrom("libraries").select(["id", "name", "content_class"]).execute();
  generalLibraryId = libs.find((l) => l.name === "Movies")!.id;
  restrictedLibraryId = libs.find((l) => l.content_class === "restricted")!.id;
});

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
  delete process.env["LOOMBRE_RATE_CLAIM"];
  delete process.env["LOOMBRE_RATE_LOGIN"];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// POST /invites (admin)
// ============================================================================

describe("POST /invites (admin, E2)", () => {
  it("creates an invite: claimToken shown once, claimUrl null (M9, publicUrl unset by Lane A's stub), status pending, no token material in the Invite shape", async () => {
    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username: "preset-invitee", displayName: "Preset Person", email: "invitee@example.invalid", libraryIds: [generalLibraryId] });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(typeof res.body.claimToken).toBe("string");
    expect(res.body.claimToken.length).toBeGreaterThan(20);
    expect(res.body.claimUrl).toBeNull();
    expect(res.body.invite.usernamePreset).toBe("preset-invitee");
    expect(res.body.invite.displayNamePreset).toBe("Preset Person");
    expect(res.body.invite.email).toBe("invitee@example.invalid");
    expect(res.body.invite.libraryIds).toEqual([generalLibraryId]);
    expect(res.body.invite.status).toBe("pending");
    expect(res.body.invite.claimedAtMs).toBeNull();
    expect(res.body.invite.revokedAtMs).toBeNull();
    expect(JSON.stringify(res.body.invite)).not.toContain(res.body.claimToken);
  });

  it("defaults expiresInMs to 72h when omitted", async () => {
    const before = Date.now();
    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [] });
    expect(res.status).toBe(201);
    const delta = res.body.invite.expiresAtMs - res.body.invite.createdAtMs;
    expect(delta).toBe(259_200_000);
    expect(res.body.invite.createdAtMs).toBeGreaterThanOrEqual(before);
  });

  it("422s on a restricted-class library id (M4: invites can never grant restricted access)", async () => {
    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [restrictedLibraryId] });
    expect(res.status).toBe(422);
  });

  it("422s on an unknown library id", async () => {
    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: ["018f6f1e-0000-7000-8000-0000000000ff"] });
    expect(res.status).toBe(422);
  });

  it("422s on expiresInMs outside 1h-30d bounds", async () => {
    const tooShort = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [], expiresInMs: 1000 });
    expect(tooShort.status).toBe(422);

    const tooLong = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [], expiresInMs: 999_999_999_999 });
    expect(tooLong.status).toBe(422);
  });

  it("401s unauthenticated, 403s for a non-admin", async () => {
    const noAuth = await request(app.getHttpServer()).post("/invites").send({ libraryIds: [] });
    expect(noAuth.status).toBe(401);

    const casual = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${casualToken}`)
      .send({ libraryIds: [] });
    expect(casual.status).toBe(403);
  });

  it("emits user.invited (ADMIN_ONLY, actor=admin) with inviteId/usernamePreset/libraryIds/createdAtMs and NEVER the token", async () => {
    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username: "event-check-invitee", libraryIds: [generalLibraryId] });
    expect(res.status).toBe(201);

    const event = await latestEvent("user.invited", (p) => p.inviteId === res.body.invite.id);
    expect(event).toBeDefined();
    expect(event!.actor_user_id).not.toBeNull();
    expect(event!.payload).toEqual({
      inviteId: res.body.invite.id,
      usernamePreset: "event-check-invitee",
      libraryIds: [generalLibraryId],
      createdAtMs: res.body.invite.createdAtMs,
    });
    expect(JSON.stringify(event!.payload)).not.toContain(res.body.claimToken);
  });

  it("M7 seam: with email present AND mail 'configured' (spied), MailDispatchService.trySend is called with the frozen payload shape", async () => {
    const mailConfig = app.get(MailConfigService);
    const mailDispatch = app.get(MailDispatchService);
    vi.spyOn(mailConfig, "isConfigured").mockReturnValue(true);
    vi.spyOn(mailConfig, "publicUrl").mockReturnValue("https://loombre.example");
    const trySendSpy = vi.spyOn(mailDispatch, "trySend");

    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username: "mail-seam-invitee", libraryIds: [], email: "mail-seam@example.invalid" });
    expect(res.status).toBe(201);

    expect(trySendSpy).toHaveBeenCalledTimes(1);
    // Param names are Lane C's template contract (apps/worker/src/mail/
    // templates/types.ts): actionUrl (the full publicUrl-derived claim
    // link), displayName (greeting, empty when no preset), expiresLabel
    // (human prose for the default 72h window).
    expect(trySendSpy).toHaveBeenCalledWith({
      templateId: "invite",
      to: "mail-seam@example.invalid",
      params: {
        actionUrl: `https://loombre.example/claim/${res.body.claimToken}`,
        displayName: "",
        expiresLabel: "3 days",
      },
    });
    // The claimUrl composition end to end (M9's non-null branch), not just
    // the pure-function unit test in invites.controller.spec.ts.
    expect(res.body.claimUrl).toBe(`https://loombre.example/claim/${res.body.claimToken}`);
  });

  it("E1/E6: with mail UNCONFIGURED (the real default posture), trySend is never called even when email is present", async () => {
    const mailDispatch = app.get(MailDispatchService);
    const trySendSpy = vi.spyOn(mailDispatch, "trySend");

    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [], email: "no-mail-configured@example.invalid" });
    expect(res.status).toBe(201);
    expect(trySendSpy).not.toHaveBeenCalled();
    expect(res.body.claimUrl).toBeNull();
  });
});

// ============================================================================
// GET /invites (admin)
// ============================================================================

describe("GET /invites (admin, E2)", () => {
  it("lists invites, 401/403 gated", async () => {
    await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [] });

    const res = await request(app.getHttpServer()).get("/invites").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    // Never leaks token material in the list either.
    for (const item of res.body.items) {
      expect(item).not.toHaveProperty("tokenHash");
      expect(item).not.toHaveProperty("claimToken");
    }

    expect((await request(app.getHttpServer()).get("/invites")).status).toBe(401);
    expect(
      (await request(app.getHttpServer()).get("/invites").set("Authorization", `Bearer ${casualToken}`)).status,
    ).toBe(403);
  });
});

// ============================================================================
// DELETE /invites/{id} (admin)
// ============================================================================

describe("DELETE /invites/{id} (admin, E2)", () => {
  it("revokes a pending invite -> 204, emits user.invite-revoked; a second revoke -> 404", async () => {
    const created = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [] });
    const inviteId = created.body.invite.id;

    const first = await request(app.getHttpServer())
      .delete(`/invites/${inviteId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(204);

    const event = await latestEvent("user.invite-revoked", (p) => p.inviteId === inviteId);
    expect(event).toBeDefined();
    expect(event!.payload).toEqual({ inviteId, revokedAtMs: expect.any(Number) });

    const second = await request(app.getHttpServer())
      .delete(`/invites/${inviteId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(404);
  });

  it("401s unauthenticated, 403s for a non-admin", async () => {
    const created = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [] });
    const inviteId = created.body.invite.id;

    expect((await request(app.getHttpServer()).delete(`/invites/${inviteId}`)).status).toBe(401);
    expect(
      (
        await request(app.getHttpServer()).delete(`/invites/${inviteId}`).set("Authorization", `Bearer ${casualToken}`)
      ).status,
    ).toBe(403);
  });
});

// ============================================================================
// GET /invites/claim/{token} (public) — byte-identical 404 twins
// ============================================================================

async function createInviteRaw(body: Record<string, unknown>) {
  const res = await request(app.getHttpServer())
    .post("/invites")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ libraryIds: [], ...body });
  if (res.status !== 201) throw new Error(`createInviteRaw failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { claimToken: string; invite: { id: string } };
}

describe("GET /invites/claim/{token} (public, M12)", () => {
  it("a live invite resolves 200 with its presets, no Authorization header needed", async () => {
    const created = await createInviteRaw({ username: "claim-state-user", displayName: "Claim State", email: "claim-state@example.invalid" });
    const res = await request(app.getHttpServer()).get(`/invites/claim/${created.claimToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      usernamePreset: "claim-state-user",
      displayNamePreset: "Claim State",
      emailPreset: "claim-state@example.invalid",
    });
  });

  it("garbage / expired / revoked / claimed tokens ALL 404 byte-identically to each other and to an unknown route", async () => {
    // garbage
    const garbage = await request(app.getHttpServer()).get("/invites/claim/not-a-real-token-at-all");

    // revoked
    const revokedInvite = await createInviteRaw({});
    await request(app.getHttpServer()).delete(`/invites/${revokedInvite.invite.id}`).set("Authorization", `Bearer ${adminToken}`);
    const revoked = await request(app.getHttpServer()).get(`/invites/claim/${revokedInvite.claimToken}`);

    // claimed
    const claimedInvite = await createInviteRaw({ username: `claim-twin-${Date.now()}` });
    const claimRes = await request(app.getHttpServer())
      .post(`/invites/claim/${claimedInvite.claimToken}`)
      .send({ password: "a-fine-password" });
    expect(claimRes.status).toBe(201);
    const claimed = await request(app.getHttpServer()).get(`/invites/claim/${claimedInvite.claimToken}`);

    // an unknown route hit with a valid Bearer token, to get the REAL
    // catch-all body for comparison (same reasoning as setup.e2e.spec.ts's
    // own byte-identical-404 test: the catch-all itself requires auth,
    // this route does not, and both still produce the identical body).
    const unknownRoute = await request(app.getHttpServer())
      .get("/this-route-does-not-exist-at-all")
      .set("Authorization", `Bearer ${adminToken}`);

    for (const res of [garbage, revoked, claimed]) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toBe(unknownRoute.headers["content-type"]);
      expect(res.text).toBe(unknownRoute.text);
      expect(JSON.parse(res.text)).toEqual({ type: "about:blank", title: "Not Found", status: 404 });
    }
  });
});

// ============================================================================
// POST /invites/claim/{token} (public, M12/M13) — the headline flow + races
// ============================================================================

describe("POST /invites/claim/{token} (public, E1/M13) — the whole flow, zero mail config", () => {
  it("E1 headline: claims with zero mail configuration end to end — auto-login TokenPair works immediately", async () => {
    const created = await createInviteRaw({ username: "e1-headline-user", displayName: "E1 Headline", email: "e1-headline@example.invalid", libraryIds: [generalLibraryId] });

    const claim = await request(app.getHttpServer())
      .post(`/invites/claim/${created.claimToken}`)
      .send({ password: "correct-horse-battery-staple" });

    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    expect(typeof claim.body.accessToken).toBe("string");
    expect(typeof claim.body.refreshToken).toBe("string");
    expect(typeof claim.body.deviceId).toBe("string");

    // The freshly minted token actually works — GET /users/me succeeds
    // immediately, no second login round trip (M13).
    const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("e1-headline-user");
    expect(me.body.displayName).toBe("E1 Headline");
    expect(me.body.email).toBe("e1-headline@example.invalid");
    expect(me.body.isAdmin).toBe(false); // M4: never settable via invite/claim
  });

  it("preset username wins even when the client submits a different one", async () => {
    const created = await createInviteRaw({ username: "preset-wins-user" });
    const claim = await request(app.getHttpServer())
      .post(`/invites/claim/${created.claimToken}`)
      .send({ username: "client-submitted-name", password: "a-fine-password" });
    expect(claim.status).toBe(201);

    const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
    expect(me.body.username).toBe("preset-wins-user");
  });

  it("no preset -> username required (422); password required (422)", async () => {
    const noPreset = await createInviteRaw({});

    const missingUsername = await request(app.getHttpServer()).post(`/invites/claim/${noPreset.claimToken}`).send({ password: "claim-e2e-password" });
    expect(missingUsername.status).toBe(422);

    const anotherInvite = await createInviteRaw({ username: "password-required-user" });
    const missingPassword = await request(app.getHttpServer()).post(`/invites/claim/${anotherInvite.claimToken}`).send({});
    expect(missingPassword.status).toBe(422);
  });

  it("email/displayName default to the invite's own preset when the claim body omits them", async () => {
    const created = await createInviteRaw({ username: "default-preset-claim", displayName: "Default Preset", email: "default-preset@example.invalid" });
    const claim = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ password: "claim-e2e-password" });
    expect(claim.status).toBe(201);

    const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
    expect(me.body.email).toBe("default-preset@example.invalid");
    expect(me.body.displayName).toBe("Default Preset");
  });

  // ==========================================================================
  // LD-13b (STATE.md "Mail posture trio"): ClaimInviteRequest.email
  // ABSENT-vs-NULL-vs-VALUE, crossed with WITH-a-preset / WITHOUT-a-preset.
  // The full 3x2 grid the mission's adversarial obligation names verbatim
  // ("grid over absent/null/value x preset/no-preset"). ABSENT was already
  // pinned above (preset wins) and is not repeated here except as the (0,0)
  // control cell every other cell is compared against.
  // ==========================================================================
  describe("LD-13b: ClaimInviteRequest.email — absent vs null vs value, x preset vs no-preset", () => {
    it("preset present + email ABSENT -> preset wins (control, mirrors the test above)", async () => {
      const created = await createInviteRaw({ username: "grid-preset-absent", email: "grid-preset-absent@example.invalid" });
      const claim = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ password: "claim-e2e-password" });
      expect(claim.status, JSON.stringify(claim.body)).toBe(201);
      const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
      expect(me.body.email).toBe("grid-preset-absent@example.invalid");
    });

    it("preset present + email EXPLICIT NULL -> opts OUT, the new account has NO email (the defect this item closes)", async () => {
      const created = await createInviteRaw({ username: "grid-preset-null", email: "grid-preset-null@example.invalid" });
      const claim = await request(app.getHttpServer())
        .post(`/invites/claim/${created.claimToken}`)
        .send({ password: "claim-e2e-password", email: null });
      expect(claim.status, JSON.stringify(claim.body)).toBe(201);
      const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
      expect(me.body.email).toBeNull();
    });

    it("preset present + email VALUE -> the submitted value wins over the preset", async () => {
      const created = await createInviteRaw({ username: "grid-preset-value", email: "grid-preset-value-preset@example.invalid" });
      const claim = await request(app.getHttpServer())
        .post(`/invites/claim/${created.claimToken}`)
        .send({ password: "claim-e2e-password", email: "grid-preset-value-submitted@example.invalid" });
      expect(claim.status, JSON.stringify(claim.body)).toBe(201);
      const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
      expect(me.body.email).toBe("grid-preset-value-submitted@example.invalid");
    });

    it("NO preset + email ABSENT -> no email (nothing to default to)", async () => {
      const created = await createInviteRaw({ username: "grid-nopreset-absent" });
      const claim = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ password: "claim-e2e-password" });
      expect(claim.status, JSON.stringify(claim.body)).toBe(201);
      const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
      expect(me.body.email).toBeNull();
    });

    it("NO preset + email EXPLICIT NULL -> no email (opting out of nothing is a harmless no-op, not a 422)", async () => {
      const created = await createInviteRaw({ username: "grid-nopreset-null" });
      const claim = await request(app.getHttpServer())
        .post(`/invites/claim/${created.claimToken}`)
        .send({ password: "claim-e2e-password", email: null });
      expect(claim.status, JSON.stringify(claim.body)).toBe(201);
      const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
      expect(me.body.email).toBeNull();
    });

    it("NO preset + email VALUE -> the submitted value is used", async () => {
      const created = await createInviteRaw({ username: "grid-nopreset-value" });
      const claim = await request(app.getHttpServer())
        .post(`/invites/claim/${created.claimToken}`)
        .send({ password: "claim-e2e-password", email: "grid-nopreset-value@example.invalid" });
      expect(claim.status, JSON.stringify(claim.body)).toBe(201);
      const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
      expect(me.body.email).toBe("grid-nopreset-value@example.invalid");
    });

    it("an all-whitespace email is NOT the null-to-clear signal — it still falls back to the preset (unchanged F7/R-F4 posture)", async () => {
      const created = await createInviteRaw({ username: "grid-whitespace-not-null", email: "grid-whitespace-not-null@example.invalid" });
      const claim = await request(app.getHttpServer())
        .post(`/invites/claim/${created.claimToken}`)
        .send({ password: "claim-e2e-password", email: "   " });
      expect(claim.status, JSON.stringify(claim.body)).toBe(201);
      const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
      expect(me.body.email).toBe("grid-whitespace-not-null@example.invalid");
    });

    it("a non-string, non-null email (e.g. a number) 422s — the null-to-clear widening does not loosen shape validation", async () => {
      const created = await createInviteRaw({ username: "grid-bad-shape" });
      const claim = await request(app.getHttpServer())
        .post(`/invites/claim/${created.claimToken}`)
        .send({ password: "claim-e2e-password", email: 12345 });
      expect(claim.status, JSON.stringify(claim.body)).toBe(422);
    });
  });

  it("library grants: general library granted, restricted skipped (M4 defense in depth) — the claimed user cannot see the restricted library", async () => {
    // createInvite itself already rejects a restricted-class libraryId at
    // creation time (422, tested above) — the ONLY way a restricted grant
    // row can exist on an invite is a library that changed content_class
    // AFTER the invite was created, which is exactly the scenario M4's
    // claim-time re-check defends against. Simulated here by inserting the
    // grant row directly, bypassing the admin API's own creation-time gate.
    const created = await createInviteRaw({ username: "grant-check-user", libraryIds: [generalLibraryId] });
    await rawDb.insertInto("user_invite_grants").values({ invite_id: created.invite.id, library_id: restrictedLibraryId }).execute();

    const claim = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ password: "claim-e2e-password" });
    expect(claim.status).toBe(201);

    const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
    const userId = me.body.id as string;

    const perms = await rawDb.selectFrom("library_permissions").select("library_id").where("user_id", "=", userId).execute();
    const grantedIds = perms.map((p) => p.library_id);
    expect(grantedIds).toContain(generalLibraryId);
    expect(grantedIds).not.toContain(restrictedLibraryId);
  });

  it("emits user.claimed (ADMIN_ONLY, actorUserId = new user) with {userId, inviteId, username, createdAtMs} and never the token/password", async () => {
    const created = await createInviteRaw({ username: "claimed-event-user" });
    const claim = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ password: "a-fine-password" });
    expect(claim.status).toBe(201);

    const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
    const userId = me.body.id as string;

    const event = await latestEvent("user.claimed", (p) => p.userId === userId);
    expect(event).toBeDefined();
    expect(event!.actor_user_id).toBe(userId);
    expect(event!.payload).toEqual({
      userId,
      inviteId: created.invite.id,
      username: "claimed-event-user",
      createdAtMs: expect.any(Number),
    });
    expect(JSON.stringify(event!.payload)).not.toContain("a-fine-password");
    expect(JSON.stringify(event!.payload)).not.toContain(created.claimToken);
  });

  it("username conflict -> 422 (distinct from token-invalid 404), and the invite is STILL claimable afterward", async () => {
    const created = await createInviteRaw({});
    const conflict = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ username: "admin", password: "claim-e2e-password" });
    expect(conflict.status).toBe(422);

    const retry = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ username: "admin-retry-e2e-ok", password: "claim-e2e-password" });
    expect(retry.status).toBe(201);
  });

  it("revoked-then-claim -> 404", async () => {
    const created = await createInviteRaw({ username: "revoke-then-claim" });
    await request(app.getHttpServer()).delete(`/invites/${created.invite.id}`).set("Authorization", `Bearer ${adminToken}`);
    const claim = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ password: "claim-e2e-password" });
    expect(claim.status).toBe(404);
  });

  it("expired-then-claim -> 404", async () => {
    const created = await createInviteRaw({ username: "expire-then-claim", expiresInMs: 3_600_000 });
    // Force expiry directly (this suite cannot wait an hour) — same
    // "instance-stripped" approach seeded-conformance-style suites use.
    await rawDb.updateTable("user_invites").set({ expires_at_ms: Date.now() - 1000 }).where("id", "=", created.invite.id).execute();
    const claim = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ password: "claim-e2e-password" });
    expect(claim.status).toBe(404);
  });

  it("claim-then-claim -> 404 on the second attempt", async () => {
    const created = await createInviteRaw({ username: "claim-then-claim" });
    const first = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ password: "claim-e2e-password" });
    expect(first.status).toBe(201);
    const second = await request(app.getHttpServer()).post(`/invites/claim/${created.claimToken}`).send({ username: "claim-then-claim-again", password: "claim-e2e-password" });
    expect(second.status).toBe(404);
  });

  it("RACE TEST: N concurrent claims of ONE invite over real HTTP against real Postgres — exactly one 201, the rest 404, exactly one user row created", async () => {
    const created = await createInviteRaw({});
    const N = 10;
    const usernameBase = `race-http-${Date.now()}`;

    const attempts = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app.getHttpServer())
          .post(`/invites/claim/${created.claimToken}`)
          .send({ username: `${usernameBase}-${i}`, password: "claim-e2e-password" }),
      ),
    );

    const wins = attempts.filter((r) => r.status === 201);
    const losses = attempts.filter((r) => r.status !== 201);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(N - 1);
    for (const loss of losses) {
      expect(loss.status).toBe(404);
    }

    const createdRows = await rawDb
      .selectFrom("users")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("username", "like", `${usernameBase}-%`)
      .executeTakeFirst();
    expect(Number(createdRows?.count ?? 0)).toBe(1);
  });
});

// G6/G7/G8 (STATE.md "Current-password re-auth on self-changes"): the
// SAME collision/notice/floor wiring users.controller.ts's updateMe has
// (apps/server/test/reauth.e2e.spec.ts), proven here for claimInvite's
// own dispatch site. "casual@loombre.local" (seed) is the collision
// target throughout — never actually mutated by any of these claims
// (E8: the DROPPED member never touches the existing owner's account).
describe("POST /invites/claim/{token}: G6/G7/G8 — email collision, notice dispatch, timing floor", () => {
  it("claiming with an ALREADY-TAKEN email is a silent 201 no-op — the new account simply has no email", async () => {
    const created = await createInviteRaw({ username: "claim-collision-silent" });
    const claim = await request(app.getHttpServer())
      .post(`/invites/claim/${created.claimToken}`)
      .send({ email: "casual@loombre.local", password: "claim-collision-password" });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);

    const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${claim.body.accessToken}`);
    expect(me.body.email).toBeNull();

    // The existing owner is completely untouched.
    const casualStillOwns = await rawDb.selectFrom("users").select("email").where("username", "=", "casual").executeTakeFirstOrThrow();
    expect(casualStillOwns.email).toBe("casual@loombre.local");
  });

  it("mail CONFIGURED: a colliding claim dispatches email-in-use-notice to the existing owner, with serverName", async () => {
    const mailConfig = app.get(MailConfigService);
    const mailDispatch = app.get(MailDispatchService);
    const isConfiguredSpy = vi.spyOn(mailConfig, "isConfigured").mockReturnValue(true);
    const trySendSpy = vi.spyOn(mailDispatch, "trySend");
    try {
      const created = await createInviteRaw({ username: "claim-collision-notice" });
      const claim = await request(app.getHttpServer())
        .post(`/invites/claim/${created.claimToken}`)
        .send({ email: "casual@loombre.local", password: "claim-collision-password" });
      expect(claim.status).toBe(201);

      const noticeCalls = trySendSpy.mock.calls.filter((c) => c[0].templateId === "email-in-use-notice");
      expect(noticeCalls).toHaveLength(1);
      expect(noticeCalls[0]![0].to).toBe("casual@loombre.local");
      expect(typeof noticeCalls[0]![0].params["serverName"]).toBe("string");
    } finally {
      isConfiguredSpy.mockRestore();
      trySendSpy.mockRestore();
    }
  });

  it("mail UNCONFIGURED (this file's own default posture, E1): a colliding claim dispatches NO notice", async () => {
    const mailDispatch = app.get(MailDispatchService);
    const trySendSpy = vi.spyOn(mailDispatch, "trySend");
    try {
      const created = await createInviteRaw({ username: "claim-collision-nonotice" });
      const claim = await request(app.getHttpServer())
        .post(`/invites/claim/${created.claimToken}`)
        .send({ email: "casual@loombre.local", password: "claim-collision-password" });
      expect(claim.status).toBe(201);

      const noticeCalls = trySendSpy.mock.calls.filter((c) => c[0].templateId === "email-in-use-notice");
      expect(noticeCalls).toHaveLength(0);
    } finally {
      trySendSpy.mockRestore();
    }
  });

  it("G7 window suppression: a SECOND colliding claim against the same address inside 24h dispatches no second notice", async () => {
    const mailConfig = app.get(MailConfigService);
    const mailDispatch = app.get(MailDispatchService);
    const isConfiguredSpy = vi.spyOn(mailConfig, "isConfigured").mockReturnValue(true);
    const trySendSpy = vi.spyOn(mailDispatch, "trySend");
    try {
      // A FRESH, UNIQUE victim address — never claimed against in any
      // OTHER test in this file (the "mail CONFIGURED" test above already
      // burned casual@loombre.local's own 24h window, which would
      // otherwise make BOTH of this test's own attempts land inside an
      // already-open window and defeat the point of this test).
      const windowVictimEmail = `window-suppression-victim-${Date.now()}@example.invalid`;
      const windowVictim = await request(app.getHttpServer())
        .post("/users")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ username: `window-suppression-victim-${Date.now()}`, email: windowVictimEmail, password: "irrelevant-password" });
      expect(windowVictim.status).toBe(201);

      const first = await createInviteRaw({ username: "claim-collision-window-1" });
      const firstClaim = await request(app.getHttpServer())
        .post(`/invites/claim/${first.claimToken}`)
        .send({ email: windowVictimEmail, password: "claim-collision-password" });
      expect(firstClaim.status).toBe(201);

      const second = await createInviteRaw({ username: "claim-collision-window-2" });
      const secondClaim = await request(app.getHttpServer())
        .post(`/invites/claim/${second.claimToken}`)
        .send({ email: windowVictimEmail, password: "claim-collision-password" });
      expect(secondClaim.status).toBe(201); // still a silent no-op either way

      const noticeCalls = trySendSpy.mock.calls.filter((c) => c[0].templateId === "email-in-use-notice" && c[0].to === windowVictimEmail);
      expect(noticeCalls).toHaveLength(1); // the SECOND attempt was suppressed by the ledger window
    } finally {
      isConfiguredSpy.mockRestore();
      trySendSpy.mockRestore();
    }
  });

  it("G8: claiming takes at least the wall-clock floor (~200ms), collision or not", async () => {
    const created = await createInviteRaw({ username: "claim-floor-check" });
    const startedAtMs = Date.now();
    const claim = await request(app.getHttpServer())
      .post(`/invites/claim/${created.claimToken}`)
      .send({ email: `floor-clean-${Date.now()}@example.invalid`, password: "claim-collision-password" });
    const elapsedMs = Date.now() - startedAtMs;

    expect(claim.status).toBe(201);
    expect(elapsedMs).toBeGreaterThanOrEqual(200 - 30); // 30ms scheduling-jitter margin
  });
});

// composeClaimUrl's pure-function unit test lives in
// apps/server/src/invites/invites.controller.spec.ts — this file already
// proves the same composition end to end (both branches) via the spied
// MailConfigService cases above.
