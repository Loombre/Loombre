// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/email-collision-matrix.e2e.spec.ts
//
// Lane C (STATE.md "Current-password re-auth on self-changes + the
// email-collision signal") — the adversarial-grade cross-cutting matrix
// for F5/G6/G7: the FULL grid
//
//     {claim flow, email-change flow} x {mail configured, mail unconfigured}
//       x {notice window fresh, notice window already claimed}
//
// proving, in EVERY cell:
//   - ACTOR-VISIBLE IDENTITY: the HTTP response for a colliding email is
//     indistinguishable (status, content-type, and body shape/values once
//     the legitimately-per-request-variable fields — id/username/email/
//     tokens/timestamps — are neutralized) from the response for a
//     genuinely free email. An attacker who submits someone else's address
//     learns nothing different from submitting a fresh one.
//   - SIGNAL CORRECTNESS: mail-configured + a fresh window sends exactly
//     ONE email-in-use-notice job to the EXISTING owner; an already-claimed
//     window sends zero; an unconfigured install sends zero AND never
//     burns the window (a LATER collision, once mail is configured, still
//     notices); a collision more than 24h after the last notice notices
//     again.
//
// Lane A's own reauth.e2e.spec.ts / invites.e2e.spec.ts already pin the
// PER-FLOW happy-path shape of this wiring (this file reads both first) —
// this file's job is the byte/shape-level cross-comparison between
// colliding and free attempts, the cells neither of those files compares
// side by side, and the two genuinely new cells: the notice window
// SURVIVING an unconfigured attempt, and the window being SHARED across
// both collision surfaces for the same address (a claim collision
// suppresses a later email-change collision on the same address, and vice
// versa — both dispatch sites claim the SAME ledger row).
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed), same
// convention as every other apps/server e2e file in this package.

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase, EMAIL_COLLISION_NOTICE_WINDOW_MS } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { MailDispatchService } from "../src/mail/mail-dispatch.service.js";
import { MailConfigService } from "../src/mail/mail-config.service.js";

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

function buildDeviceProfile(profileId = "collision-matrix-e2e") {
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
let rawDb: ReturnType<typeof createDb>;
let adminAccessToken: string;
let counter = 0;

function uniqueTag(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

async function loginAs(username: string, password: string): Promise<{ accessToken: string }> {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `collision-matrix-${username}-${Date.now()}`, deviceProfile: buildDeviceProfile(username) });
  expect(res.status, `login as ${username} failed: ${JSON.stringify(res.body)}`).toBe(200);
  return { accessToken: res.body.accessToken };
}

/** A fresh, ordinary user with a unique email — every helper below that
 *  needs "somebody else's account to collide with" or "an attacker's own
 *  account" calls this so no two tests in this file ever share a bucket,
 *  a ledger row, or a users.email value. */
async function createAndLoginFreshUser(label: string): Promise<{ userId: string; accessToken: string; username: string; email: string; password: string }> {
  const tag = uniqueTag(label);
  const username = tag;
  const password = `${tag}-password`;
  const email = `${tag}@example.invalid`;
  const created = await request(app.getHttpServer())
    .post("/users")
    .set("Authorization", `Bearer ${adminAccessToken}`)
    .send({ username, email, password, isAdmin: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { accessToken } = await loginAs(username, password);
  return { userId: created.body.id, accessToken, username, email, password };
}

async function createInviteRaw(): Promise<{ claimToken: string }> {
  const res = await request(app.getHttpServer())
    .post("/invites")
    .set("Authorization", `Bearer ${adminAccessToken}`)
    .send({ libraryIds: [] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { claimToken: res.body.claimToken };
}

async function claim(token: string, targetEmail: string): Promise<request.Response> {
  return request(app.getHttpServer())
    .post(`/invites/claim/${token}`)
    .send({ username: uniqueTag("claim-user"), password: "claim-matrix-password-1", email: targetEmail });
}

async function patchEmail(accessToken: string, currentPassword: string, targetEmail: string): Promise<request.Response> {
  return request(app.getHttpServer())
    .patch("/users/me")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ email: targetEmail, currentPassword });
}

// ----------------------------------------------------------------------------
// Response-comparison helpers (E8: actor-visible identity)
// ----------------------------------------------------------------------------

/** Recursively replaces every leaf value with its `typeof` (or the literal
 *  "null"), sorting object keys — a canonical SHAPE two structurally
 *  equivalent-but-value-different response bodies can be deep-equal
 *  compared against (used for claimInvite's response, where every field —
 *  accessToken/refreshToken/deviceId/expiry — is legitimately unique per
 *  call, so only the shape, never the value, can be compared). */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value === null) return "null";
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}

/** Drops the given keys — used for updateMe's response, where id/username/
 *  email/createdAtMs/updatedAtMs legitimately vary per test user, but every
 *  OTHER field (displayName/isAdmin/birthDate/maxContentRating/
 *  mustChangePassword) should be byte-identical between two freshly created,
 *  identically-shaped users regardless of which one collided. */
function redact(body: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out = { ...body };
  for (const key of keys) delete out[key];
  return out;
}

const UPDATE_ME_VARIABLE_KEYS = ["id", "username", "email", "createdAtMs", "updatedAtMs"];

// ----------------------------------------------------------------------------
// Mail-config / ledger manipulation helpers
// ----------------------------------------------------------------------------

interface MailSpies {
  trySendSpy: ReturnType<typeof vi.spyOn>;
  isConfiguredSpy: ReturnType<typeof vi.spyOn> | null;
  restore(): void;
}

function mockMail(configured: boolean): MailSpies {
  const mailDispatchService = app.get(MailDispatchService);
  const trySendSpy = vi.spyOn(mailDispatchService, "trySend");
  const mailConfigService = app.get(MailConfigService);
  const isConfiguredSpy = vi.spyOn(mailConfigService, "isConfigured").mockReturnValue(configured);
  return {
    trySendSpy,
    isConfiguredSpy,
    restore() {
      trySendSpy.mockRestore();
      isConfiguredSpy?.mockRestore();
    },
  };
}

function noticeCallsTo(spies: MailSpies, email: string) {
  return spies.trySendSpy.mock.calls.filter((c) => c[0].templateId === "email-in-use-notice" && c[0].to === email);
}

/** Directly seeds a "notice already sent just now" ledger row — the
 *  "window already claimed" cell, without spending an extra HTTP round
 *  trip (brief's own suggested technique: "direct ledger row
 *  manipulation"). */
async function seedLedgerClaimed(email: string): Promise<void> {
  await rawDb
    .insertInto("email_collision_notice_ledger")
    .values({ email, last_notice_at_ms: Date.now() })
    .execute();
}

/** Pushes an existing ledger row's `last_notice_at_ms` back past the 24h
 *  window, so the NEXT claim for that address wins again — the boundary
 *  cell, again via direct ledger manipulation rather than a fake clock
 *  (this file drives a real HTTP server; the controller's `nowMs` comes
 *  from `@loombre/shared`'s real wall clock, not an injectable one). */
async function backdateLedgerPastWindow(email: string): Promise<void> {
  await rawDb
    .updateTable("email_collision_notice_ledger")
    .set({ last_notice_at_ms: Date.now() - EMAIL_COLLISION_NOTICE_WINDOW_MS - 5_000 })
    .where("email", "=", email)
    .execute();
}

async function ledgerRowFor(email: string) {
  return rawDb
    .selectFrom("email_collision_notice_ledger")
    .selectAll()
    .where("email", "=", email)
    .executeTakeFirst();
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_email_collision_matrix");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "email-collision-matrix-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";
  process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "10000";
  process.env["LOOMBRE_RATE_CLAIM"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
  const admin = await loginAs("admin", "loombre-seed-admin");
  adminAccessToken = admin.accessToken;
});

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
  delete process.env["LOOMBRE_RATE_LOGIN"];
  delete process.env["LOOMBRE_RATE_CURRENT_PASSWORD"];
  delete process.env["LOOMBRE_RATE_CLAIM"];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// Email-change flow: PATCH /users/me
// ============================================================================

describe("email-change flow (PATCH /users/me): actor-visible identity matrix", () => {
  it("[mail ON, window FRESH] colliding vs free email — byte-identical status/headers/shape", async () => {
    const victim = await createAndLoginFreshUser("uc-idn-on-fresh-victim");
    const attacker = await createAndLoginFreshUser("uc-idn-on-fresh-attacker");
    const cleanUser = await createAndLoginFreshUser("uc-idn-on-fresh-clean");

    const spies = mockMail(true);
    try {
      const colliding = await patchEmail(attacker.accessToken, attacker.password, victim.email);
      const free = await patchEmail(cleanUser.accessToken, cleanUser.password, `${uniqueTag("uc-idn-on-fresh-target")}@example.invalid`);

      expect(colliding.status).toBe(200);
      expect(free.status).toBe(200);
      expect(colliding.headers["content-type"]).toBe(free.headers["content-type"]);
      expect(redact(colliding.body, UPDATE_ME_VARIABLE_KEYS)).toEqual(redact(free.body, UPDATE_ME_VARIABLE_KEYS));
    } finally {
      spies.restore();
    }
  });

  it("[mail ON, window ALREADY CLAIMED] colliding vs free email — still byte-identical", async () => {
    const victim = await createAndLoginFreshUser("uc-idn-on-claimed-victim");
    const attacker = await createAndLoginFreshUser("uc-idn-on-claimed-attacker");
    const cleanUser = await createAndLoginFreshUser("uc-idn-on-claimed-clean");
    await seedLedgerClaimed(victim.email);

    const spies = mockMail(true);
    try {
      const colliding = await patchEmail(attacker.accessToken, attacker.password, victim.email);
      const free = await patchEmail(cleanUser.accessToken, cleanUser.password, `${uniqueTag("uc-idn-on-claimed-target")}@example.invalid`);

      expect(colliding.status).toBe(200);
      expect(free.status).toBe(200);
      expect(colliding.headers["content-type"]).toBe(free.headers["content-type"]);
      expect(redact(colliding.body, UPDATE_ME_VARIABLE_KEYS)).toEqual(redact(free.body, UPDATE_ME_VARIABLE_KEYS));
    } finally {
      spies.restore();
    }
  });

  it("[mail OFF, window FRESH] colliding vs free email — still byte-identical", async () => {
    const victim = await createAndLoginFreshUser("uc-idn-off-fresh-victim");
    const attacker = await createAndLoginFreshUser("uc-idn-off-fresh-attacker");
    const cleanUser = await createAndLoginFreshUser("uc-idn-off-fresh-clean");

    const spies = mockMail(false);
    try {
      const colliding = await patchEmail(attacker.accessToken, attacker.password, victim.email);
      const free = await patchEmail(cleanUser.accessToken, cleanUser.password, `${uniqueTag("uc-idn-off-fresh-target")}@example.invalid`);

      expect(colliding.status).toBe(200);
      expect(free.status).toBe(200);
      expect(colliding.headers["content-type"]).toBe(free.headers["content-type"]);
      expect(redact(colliding.body, UPDATE_ME_VARIABLE_KEYS)).toEqual(redact(free.body, UPDATE_ME_VARIABLE_KEYS));
    } finally {
      spies.restore();
    }
  });

  it("[mail OFF, window ALREADY CLAIMED] colliding vs free email — still byte-identical", async () => {
    const victim = await createAndLoginFreshUser("uc-idn-off-claimed-victim");
    const attacker = await createAndLoginFreshUser("uc-idn-off-claimed-attacker");
    const cleanUser = await createAndLoginFreshUser("uc-idn-off-claimed-clean");
    await seedLedgerClaimed(victim.email);

    const spies = mockMail(false);
    try {
      const colliding = await patchEmail(attacker.accessToken, attacker.password, victim.email);
      const free = await patchEmail(cleanUser.accessToken, cleanUser.password, `${uniqueTag("uc-idn-off-claimed-target")}@example.invalid`);

      expect(colliding.status).toBe(200);
      expect(free.status).toBe(200);
      expect(colliding.headers["content-type"]).toBe(free.headers["content-type"]);
      expect(redact(colliding.body, UPDATE_ME_VARIABLE_KEYS)).toEqual(redact(free.body, UPDATE_ME_VARIABLE_KEYS));
    } finally {
      spies.restore();
    }
  });

  it("email-change to your OWN current address is a normal successful change, NOT a collision — no notice pipeline touched even with mail configured", async () => {
    const user = await createAndLoginFreshUser("uc-self-exclusion");
    const spies = mockMail(true);
    try {
      const res = await patchEmail(user.accessToken, user.password, user.email);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(user.email);

      const notices = noticeCallsTo(spies, user.email);
      expect(notices).toHaveLength(0);

      // Not just "no mail" — the ledger was never even touched for this
      // address (the self-exclusion happens BEFORE the collision check,
      // G6: "re-setting your own address is NOT a collision").
      expect(await ledgerRowFor(user.email)).toBeUndefined();
    } finally {
      spies.restore();
    }
  });
});

describe("email-change flow (PATCH /users/me): signal correctness", () => {
  it("[mail ON, window FRESH] exactly ONE notice, to the existing owner", async () => {
    const victim = await createAndLoginFreshUser("uc-sig-on-fresh-victim");
    const attacker = await createAndLoginFreshUser("uc-sig-on-fresh-attacker");
    const spies = mockMail(true);
    try {
      const res = await patchEmail(attacker.accessToken, attacker.password, victim.email);
      expect(res.status).toBe(200);
      const notices = noticeCallsTo(spies, victim.email);
      expect(notices).toHaveLength(1);
      expect(typeof notices[0]![0].params["serverName"]).toBe("string");
    } finally {
      spies.restore();
    }
  });

  it("[mail ON, window ALREADY CLAIMED] zero new notices", async () => {
    const victim = await createAndLoginFreshUser("uc-sig-on-claimed-victim");
    const attacker = await createAndLoginFreshUser("uc-sig-on-claimed-attacker");
    await seedLedgerClaimed(victim.email);
    const spies = mockMail(true);
    try {
      const res = await patchEmail(attacker.accessToken, attacker.password, victim.email);
      expect(res.status).toBe(200);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(0);
    } finally {
      spies.restore();
    }
  });

  it("[mail OFF] zero notices, AND the window is not burned — a LATER collision once mail is configured still notices", async () => {
    const victim = await createAndLoginFreshUser("uc-sig-off-window-victim");
    const attacker1 = await createAndLoginFreshUser("uc-sig-off-window-attacker1");
    const attacker2 = await createAndLoginFreshUser("uc-sig-off-window-attacker2");

    const offSpies = mockMail(false);
    const firstRes = await patchEmail(attacker1.accessToken, attacker1.password, victim.email);
    expect(firstRes.status).toBe(200);
    expect(noticeCallsTo(offSpies, victim.email)).toHaveLength(0);
    expect(await ledgerRowFor(victim.email)).toBeUndefined(); // never claimed
    offSpies.restore();

    const onSpies = mockMail(true);
    try {
      const secondRes = await patchEmail(attacker2.accessToken, attacker2.password, victim.email);
      expect(secondRes.status).toBe(200);
      expect(noticeCallsTo(onSpies, victim.email)).toHaveLength(1); // NOT suppressed
    } finally {
      onSpies.restore();
    }
  });

  it("a collision more than 24h after the last notice sends again (boundary, direct ledger manipulation)", async () => {
    const victim = await createAndLoginFreshUser("uc-sig-boundary-victim");
    const attacker1 = await createAndLoginFreshUser("uc-sig-boundary-attacker1");
    const attacker2 = await createAndLoginFreshUser("uc-sig-boundary-attacker2");

    const spies = mockMail(true);
    try {
      const first = await patchEmail(attacker1.accessToken, attacker1.password, victim.email);
      expect(first.status).toBe(200);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(1);

      await backdateLedgerPastWindow(victim.email);

      const second = await patchEmail(attacker2.accessToken, attacker2.password, victim.email);
      expect(second.status).toBe(200);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(2); // the window reopened
    } finally {
      spies.restore();
    }
  });
});

// ============================================================================
// Claim flow: POST /invites/claim/{token}
// ============================================================================

describe("claim flow (POST /invites/claim/{token}): actor-visible identity matrix", () => {
  it("[mail ON, window FRESH] colliding vs free email — byte-identical status/headers/shape", async () => {
    const victim = await createAndLoginFreshUser("ic-idn-on-fresh-victim");
    const spies = mockMail(true);
    try {
      const collidingInvite = await createInviteRaw();
      const colliding = await claim(collidingInvite.claimToken, victim.email);
      const freeInvite = await createInviteRaw();
      const free = await claim(freeInvite.claimToken, `${uniqueTag("ic-idn-on-fresh-target")}@example.invalid`);

      expect(colliding.status).toBe(201);
      expect(free.status).toBe(201);
      expect(colliding.headers["content-type"]).toBe(free.headers["content-type"]);
      expect(shapeOf(colliding.body)).toEqual(shapeOf(free.body));
    } finally {
      spies.restore();
    }
  });

  it("[mail ON, window ALREADY CLAIMED] colliding vs free email — still byte-identical", async () => {
    const victim = await createAndLoginFreshUser("ic-idn-on-claimed-victim");
    await seedLedgerClaimed(victim.email);
    const spies = mockMail(true);
    try {
      const collidingInvite = await createInviteRaw();
      const colliding = await claim(collidingInvite.claimToken, victim.email);
      const freeInvite = await createInviteRaw();
      const free = await claim(freeInvite.claimToken, `${uniqueTag("ic-idn-on-claimed-target")}@example.invalid`);

      expect(colliding.status).toBe(201);
      expect(free.status).toBe(201);
      expect(colliding.headers["content-type"]).toBe(free.headers["content-type"]);
      expect(shapeOf(colliding.body)).toEqual(shapeOf(free.body));
    } finally {
      spies.restore();
    }
  });

  it("[mail OFF, window FRESH] colliding vs free email — still byte-identical", async () => {
    const victim = await createAndLoginFreshUser("ic-idn-off-fresh-victim");
    const spies = mockMail(false);
    try {
      const collidingInvite = await createInviteRaw();
      const colliding = await claim(collidingInvite.claimToken, victim.email);
      const freeInvite = await createInviteRaw();
      const free = await claim(freeInvite.claimToken, `${uniqueTag("ic-idn-off-fresh-target")}@example.invalid`);

      expect(colliding.status).toBe(201);
      expect(free.status).toBe(201);
      expect(colliding.headers["content-type"]).toBe(free.headers["content-type"]);
      expect(shapeOf(colliding.body)).toEqual(shapeOf(free.body));
    } finally {
      spies.restore();
    }
  });

  it("[mail OFF, window ALREADY CLAIMED] colliding vs free email — still byte-identical", async () => {
    const victim = await createAndLoginFreshUser("ic-idn-off-claimed-victim");
    await seedLedgerClaimed(victim.email);
    const spies = mockMail(false);
    try {
      const collidingInvite = await createInviteRaw();
      const colliding = await claim(collidingInvite.claimToken, victim.email);
      const freeInvite = await createInviteRaw();
      const free = await claim(freeInvite.claimToken, `${uniqueTag("ic-idn-off-claimed-target")}@example.invalid`);

      expect(colliding.status).toBe(201);
      expect(free.status).toBe(201);
      expect(colliding.headers["content-type"]).toBe(free.headers["content-type"]);
      expect(shapeOf(colliding.body)).toEqual(shapeOf(free.body));
    } finally {
      spies.restore();
    }
  });
});

// ============================================================================
// LD-13c (STATE.md "Mail posture trio"): emailApplied — the honest,
// POST-AUTH-ONLY signal that a collision silently dropped the intended
// email. The "actor-visible identity matrix" describe block above already
// proves the colliding/free RESPONSE SHAPE is identical (shapeOf compares
// `typeof`, not value, so a boolean that legitimately differs in VALUE
// between the two cells still passes that shape check — by design: the
// shape/status/headers must never leak anything, only this one named,
// documented field's VALUE is allowed to, and only after a real account
// now exists). This block proves the VALUE side directly, and — the
// mission's own adversarial obligation, verbatim — that the signal
// introduces NO pre-auth distinguishability: GET /invites/claim/{token}
// (the only surface reachable BEFORE an account is created) never even
// queries the `users` table (see getClaimState/mapClaimState in
// invites.controller.ts/packages/db/src/query/invites.ts — it derives its
// response purely from the invite row), so there is no collision branch
// to time or leak from at that layer; nothing further is asserted there
// beyond the byte-identity proof below, which is the strongest available
// proof of "no branch" (a branch that produced identical output on every
// observed input would still be indistinguishable from no branch at all).
// ============================================================================
describe("LD-13c: emailApplied — the honest post-auth signal, with NO pre-auth leak", () => {
  async function createInviteWithEmailPreset(email: string | null): Promise<{ claimToken: string }> {
    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ libraryIds: [], ...(email !== null ? { email } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { claimToken: res.body.claimToken };
  }

  it("a colliding claim reports emailApplied:false; a free claim reports emailApplied:true — same status/shape either way", async () => {
    const victim = await createAndLoginFreshUser("ic-applied-victim");
    const collidingInvite = await createInviteRaw();
    const colliding = await claim(collidingInvite.claimToken, victim.email);
    const freeInvite = await createInviteRaw();
    const free = await claim(freeInvite.claimToken, `${uniqueTag("ic-applied-free")}@example.invalid`);

    expect(colliding.status, JSON.stringify(colliding.body)).toBe(201);
    expect(free.status, JSON.stringify(free.body)).toBe(201);
    expect(colliding.body.emailApplied).toBe(false);
    expect(free.body.emailApplied).toBe(true);
    // The only field allowed to differ in VALUE by construction — every
    // OTHER key present on one body is present on the other (no field was
    // added/removed asymmetrically alongside the honest signal).
    expect(Object.keys(colliding.body).sort()).toEqual(Object.keys(free.body).sort());
  });

  it("LD-13b's explicit `email: null` opt-out is NOT a drop — emailApplied stays true (intent achieved, not a collision)", async () => {
    const preset = await createAndLoginFreshUser("ic-applied-optout-preset-owner");
    // The invite's OWN preset is a real, already-taken address — if the
    // opt-out were implemented as "silently fall back to the preset" (the
    // LD-13b bug) rather than a genuine null, this would exercise the
    // collision path and wrongly report false.
    const invite = await createInviteWithEmailPreset(preset.email);
    const res = await request(app.getHttpServer())
      .post(`/invites/claim/${invite.claimToken}`)
      .send({ username: uniqueTag("claim-optout-user"), password: "claim-matrix-password-1", email: null });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.emailApplied).toBe(true);

    const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.body.email).toBeNull();
  });

  it("no email submitted or preset at all -> emailApplied:true (nothing to drop)", async () => {
    const invite = await createInviteRaw();
    const res = await request(app.getHttpServer())
      .post(`/invites/claim/${invite.claimToken}`)
      .send({ username: uniqueTag("claim-no-email-user"), password: "claim-matrix-password-1" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.emailApplied).toBe(true);
  });

  it("PRE-AUTH byte-identity: GET /invites/claim/{token} is identical whether the invite's preset email would later collide or not", async () => {
    const victim = await createAndLoginFreshUser("ic-applied-preauth-victim");
    const collidingInvite = await createInviteWithEmailPreset(victim.email);
    const freeInvite = await createInviteWithEmailPreset(`${uniqueTag("ic-applied-preauth-free")}@example.invalid`);

    const collidingState = await request(app.getHttpServer()).get(`/invites/claim/${collidingInvite.claimToken}`);
    const freeState = await request(app.getHttpServer()).get(`/invites/claim/${freeInvite.claimToken}`);

    expect(collidingState.status).toBe(200);
    expect(freeState.status).toBe(200);
    expect(collidingState.headers["content-type"]).toBe(freeState.headers["content-type"]);
    // Same key set (ClaimState is additionalProperties:false with exactly
    // three required keys) — the preset EMAIL VALUE legitimately differs
    // (that's the two invites' own distinct presets, not a signal), but
    // there is no extra field, no different status, nothing an attacker
    // could use to learn "this preset happens to collide" before ever
    // submitting a claim.
    expect(Object.keys(collidingState.body).sort()).toEqual(Object.keys(freeState.body).sort());
    expect(typeof collidingState.body.emailPreset).toBe("string");
    expect((collidingState.body as Record<string, unknown>)["emailApplied"]).toBeUndefined();
    expect((freeState.body as Record<string, unknown>)["emailApplied"]).toBeUndefined();
  });
});

describe("claim flow (POST /invites/claim/{token}): signal correctness", () => {
  it("[mail ON, window FRESH] exactly ONE notice, to the existing owner", async () => {
    const victim = await createAndLoginFreshUser("ic-sig-on-fresh-victim");
    const spies = mockMail(true);
    try {
      const invite = await createInviteRaw();
      const res = await claim(invite.claimToken, victim.email);
      expect(res.status).toBe(201);
      const notices = noticeCallsTo(spies, victim.email);
      expect(notices).toHaveLength(1);
      expect(typeof notices[0]![0].params["serverName"]).toBe("string");
    } finally {
      spies.restore();
    }
  });

  it("[mail ON, window ALREADY CLAIMED] zero new notices", async () => {
    const victim = await createAndLoginFreshUser("ic-sig-on-claimed-victim");
    await seedLedgerClaimed(victim.email);
    const spies = mockMail(true);
    try {
      const invite = await createInviteRaw();
      const res = await claim(invite.claimToken, victim.email);
      expect(res.status).toBe(201);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(0);
    } finally {
      spies.restore();
    }
  });

  it("[mail OFF] zero notices, AND the window is not burned — a LATER claim collision once mail is configured still notices", async () => {
    const victim = await createAndLoginFreshUser("ic-sig-off-window-victim");

    const offSpies = mockMail(false);
    const firstInvite = await createInviteRaw();
    const firstRes = await claim(firstInvite.claimToken, victim.email);
    expect(firstRes.status).toBe(201);
    expect(noticeCallsTo(offSpies, victim.email)).toHaveLength(0);
    expect(await ledgerRowFor(victim.email)).toBeUndefined();
    offSpies.restore();

    const onSpies = mockMail(true);
    try {
      const secondInvite = await createInviteRaw();
      const secondRes = await claim(secondInvite.claimToken, victim.email);
      expect(secondRes.status).toBe(201);
      expect(noticeCallsTo(onSpies, victim.email)).toHaveLength(1);
    } finally {
      onSpies.restore();
    }
  });

  it("a claim collision more than 24h after the last notice sends again (boundary, direct ledger manipulation)", async () => {
    const victim = await createAndLoginFreshUser("ic-sig-boundary-victim");
    const spies = mockMail(true);
    try {
      const firstInvite = await createInviteRaw();
      const first = await claim(firstInvite.claimToken, victim.email);
      expect(first.status).toBe(201);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(1);

      await backdateLedgerPastWindow(victim.email);

      const secondInvite = await createInviteRaw();
      const second = await claim(secondInvite.claimToken, victim.email);
      expect(second.status).toBe(201);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(2);
    } finally {
      spies.restore();
    }
  });
});

// ============================================================================
// Cross-flow: the ledger is ONE shared window per address, not one per
// dispatch site — a genuinely new cell neither reauth.e2e.spec.ts nor
// invites.e2e.spec.ts covers (each only proves suppression WITHIN its own
// flow).
// ============================================================================

describe("cross-flow: the 24h notice window is SHARED per address across both collision surfaces", () => {
  it("a claim collision claims the window; a LATER email-change collision on the SAME address (within 24h) is suppressed", async () => {
    const victim = await createAndLoginFreshUser("xf-claim-then-change-victim");
    const attacker = await createAndLoginFreshUser("xf-claim-then-change-attacker");
    const spies = mockMail(true);
    try {
      const invite = await createInviteRaw();
      const claimRes = await claim(invite.claimToken, victim.email);
      expect(claimRes.status).toBe(201);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(1);

      const changeRes = await patchEmail(attacker.accessToken, attacker.password, victim.email);
      expect(changeRes.status).toBe(200);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(1); // still just the one — suppressed
    } finally {
      spies.restore();
    }
  });

  it("an email-change collision claims the window; a LATER claim collision on the SAME address (within 24h) is suppressed", async () => {
    const victim = await createAndLoginFreshUser("xf-change-then-claim-victim");
    const attacker = await createAndLoginFreshUser("xf-change-then-claim-attacker");
    const spies = mockMail(true);
    try {
      const changeRes = await patchEmail(attacker.accessToken, attacker.password, victim.email);
      expect(changeRes.status).toBe(200);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(1);

      const invite = await createInviteRaw();
      const claimRes = await claim(invite.claimToken, victim.email);
      expect(claimRes.status).toBe(201);
      expect(noticeCallsTo(spies, victim.email)).toHaveLength(1); // still just the one — suppressed
    } finally {
      spies.restore();
    }
  });
});
