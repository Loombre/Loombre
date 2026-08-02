// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/reauth-review-findings.e2e.spec.ts
//
// LANE R (adversarial review of the "Current-password re-auth on
// self-changes + the email-collision signal" run) — RED-BY-DESIGN
// regression pins PLUS the green guards that must never regress.
//
// ============================================================================
// READ THIS BEFORE "FIXING THE TEST"
// ============================================================================
// The `describe("RED …")` blocks are expected to FAIL against the tree they
// landed on. Each one asserts the CORRECT behavior for a defect the R lane
// proved with a live HTTP probe against a real server + real Postgres; the
// assertion IS the specification for the fix. Do NOT weaken an assertion to
// make the suite pass — that is the H1 bug class this repo has a rule
// against. The `describe("GREEN …")` blocks pass today and pin the parts of
// F1–F6 that the review verified as sound.
//
// FIX WAVE UPDATE (STATE.md "Current-password re-auth on self-changes +
// the email-collision signal", lane/reauth-fix): R-F3/R-F4/R-F5/R-F6/
// R-F7/LOW-8 are fixed — their RED cases below are GREEN again. R-F1/R-F2
// are the email-existence oracle: proven a genuine E8-vs-E1/E4 trilemma
// (STATE.md 🔶 OWNER DECISION REQUIRED), not a code bug an in-scope fix
// can close, so their `it(...)` cases are `it.skip(...)`'d with an inline
// pointer back to that decision — every OTHER case in this file stays
// active and green.
//
// Findings pinned here (full write-up in the R-lane report):
//
//   R-F1  **PATCH /users/me's 200 body is an email-existence oracle.**
//         F5/G6 drop a colliding `email` member silently and return "a
//         generic success shape" — but the shape CONTAINS `email`, read
//         back from the row that was just NOT updated. So the caller
//         compares what it submitted against what came back: echoed =>
//         address is free, unchanged => address belongs to someone else.
//         A 30-trial blind classifier scored 30/30 (chance 50%). The
//         attacker does not even need a second request, and GET /users/me
//         (no limiter at all) confirms it afterwards. This is precisely
//         the enumeration channel E8 forbids and that F5 was written to
//         close — the previous run's R-F3 closed the same oracle in the
//         claim flow's 422 TEXT; this run re-opened it in the 200 BODY.
//         The collision check is CITEXT/case-insensitive, so the probe
//         does not even need the victim's exact casing.
//         Sites: apps/server/src/catalog/users.controller.ts (updateMe's
//         `return mapUser(result.user)`), packages/db/src/query/admin.ts
//         (updateUserSelf's silent email drop).
//         Knock-on: apps/web/.../AccountSection.tsx re-seeds its form from
//         that body and then shows a green "Saved" — the email input
//         visibly snaps back to the old address while the UI claims
//         success. That is both the lying-Saved law (F4/G10) and a
//         user-visible oracle in the shipped UI.
//
//   R-F2  **The claim flow leaks the same bit one step later.** A colliding
//         claim creates the account with `email = null`; the claim response
//         hands back an access token, and GET /users/me with it answers
//         `email: null` (taken) vs the submitted address (free).
//         Site: packages/db/src/query/invites.ts (claimInviteAndEmit).
//
//   R-F3  **F1's re-auth surface has a hole for admins: POST
//         /users/{id}/reset-password on SELF changes `password_hash` with
//         no `currentPassword`.** A stolen admin access token alone yields
//         a printed temporary password, a working login, and the real
//         owner locked out of their own account (their password 401s).
//         This is the exact threat F1 exists to close ("a re-auth prompt
//         must not become a password-guessing oracle" presumes the token
//         alone cannot set a password), left open on the highest-value
//         accounts on the install. users.controller.ts argues self-reset
//         is permitted because the CLI has no self-exclusion either — but
//         users-me.controller.ts's own header names the distinction:
//         "filesystem access to the running server is that privilege
//         boundary, not a bearer token."
//         Site: apps/server/src/catalog/users.controller.ts
//         (resetUserPassword).
//
//   R-F4  **`email` is validated as nothing but `typeof === "string"`, so
//         the G6 collision pre-SELECT is trivially dodged and junk is
//         storable.** `" victim@example.invalid "` is kept verbatim: two
//         accounts end up holding visually-identical addresses, the F5
//         notice never fires for the padded variant, and the "one address,
//         one account" invariant the CITEXT UNIQUE index is supposed to
//         hold is defeated by a space. `"not an address"` is accepted
//         outright, although the contract declares `format: email` — and
//         F5 is what made users.email the `to:` of an automatically
//         dispatched, third-party-triggered mail, so the blast radius of
//         an unvalidated value grew this run.
//         Sites: apps/server/src/catalog/users.controller.ts (updateMe),
//         apps/server/src/invites/invites.controller.ts (claim).
//
//   R-F5  **The 24h notice window is burned even when nothing was sent.**
//         The controller claims the ledger row and then calls trySend,
//         ignoring its `{dispatched:false}` return. trySend degrades to
//         `dispatched:false` whenever the job-queue enqueue throws (its
//         documented E6 posture) — so one transient queue hiccup silently
//         costs that address its security notice for a full 24 hours, and
//         a later collision on the same address stays silent too.
//         Site: apps/server/src/catalog/users.controller.ts /
//         apps/server/src/invites/invites.controller.ts (the shared
//         claim-then-send block).
//
//   R-F6  **updateUserSelf's 23505 backstop is dead code — the 500 G6 set
//         out to delete is still live in the race it explicitly claims to
//         cover.** The catch re-issues an UPDATE on the SAME transaction
//         that Postgres already aborted, so it raises 25P02 ("current
//         transaction is aborted") and escapes as a 500. Two users racing
//         one free address 500ed the loser in 11 of 12 live rounds. The
//         whole update is lost with it, so the "every OTHER member still
//         applies" promise fails too, and inside that window a colliding
//         attempt is a 500 while a clean one is a 200 — an E8 break. The
//         backstop must run in a SAVEPOINT (or outside the transaction).
//         updateUserAdmin (G9) is NOT affected: single statement, no
//         transaction, catch returns. claimInviteAndEmit is NOT affected:
//         its 23505 branch rolls back rather than continuing.
//         Site: packages/db/src/query/admin.ts (updateUserSelf's
//         try/catch around buildSetClause).
//
//   R-F7  **"Other devices have been signed out." is not true when the UI
//         says it.** F3 revokes the other devices' REFRESH tokens, but
//         their access tokens are self-contained JWTs — the revoked device
//         keeps full API access for up to ACCESS_TOKEN_TTL_MS (15
//         minutes). The web copy B added this run states the sign-out as
//         an accomplished fact the instant the 200 lands, which is the
//         same lying-Saved class F4 exists to forbid. Either the statement
//         has to be honest about the window or the guard has to check
//         revocation on the access path.
//         Sites: packages/db/src/query/admin.ts
//         (revokeOtherRefreshTokensForUser), apps/web/.../AccountSection.tsx
//         (ChangePasswordSection's success line).
//
// Boot pattern copied from email-collision-matrix.e2e.spec.ts (in-process
// Nest app, real HTTP via supertest, live Postgres, its own database).

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
import { MailDispatchService } from "../src/mail/mail-dispatch.service.js";
import { MailConfigService } from "../src/mail/mail-config.service.js";
import { JobQueueProvider } from "../src/common/job-queue.provider.js";

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
let adminAccessToken: string;
let rawDb: ReturnType<typeof createDb>;
let counter = 0;

function uniqueTag(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.floor(Math.random() * 1e6)}`;
}

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: uniqueTag("rf-dev"), deviceProfile: buildDeviceProfile() });
  return res;
}

interface Actor {
  userId: string;
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  username: string;
  email: string;
  password: string;
}

/** The seeded admin's access token is a 15-minute JWT and this suite runs
 *  longer than that (the blind-classifier and race blocks are deliberately
 *  many-round). Every admin-authenticated helper goes through here so an
 *  expired token re-logins once instead of failing an unrelated assertion. */
async function refreshAdminToken(): Promise<void> {
  const admin = await loginAs("admin", "loombre-seed-admin");
  expect(admin.status, JSON.stringify(admin.body)).toBe(200);
  adminAccessToken = admin.body.accessToken;
}

async function asAdmin(send: (token: string) => request.Test): Promise<request.Response> {
  const first = await send(adminAccessToken);
  if (first.status !== 401 && first.status !== 403) return first;
  await refreshAdminToken();
  return send(adminAccessToken);
}

async function createAndLoginFreshUser(label: string, isAdmin = false): Promise<Actor> {
  const username = uniqueTag(label);
  const email = `${username}@example.invalid`;
  const password = `${label}-password-1`;
  const created = await asAdmin((token) =>
    request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username, email, password, isAdmin }),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const login = await loginAs(username, password);
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return {
    userId: created.body.id,
    accessToken: login.body.accessToken,
    refreshToken: login.body.refreshToken,
    deviceId: login.body.deviceId,
    username,
    email,
    password,
  };
}

async function patchMe(accessToken: string, body: Record<string, unknown>) {
  return request(app.getHttpServer()).patch("/users/me").set("Authorization", `Bearer ${accessToken}`).send(body);
}

async function freshInviteToken(): Promise<string> {
  const res = await asAdmin((token) =>
    request(app.getHttpServer()).post("/invites").set("Authorization", `Bearer ${token}`).send({ libraryIds: [] }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.claimToken;
}

function mockMailConfigured(configured: boolean) {
  return vi.spyOn(app.get(MailConfigService), "isConfigured").mockReturnValue(configured);
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_reauth_review_findings");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "reauth-review-findings-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "100000";
  process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "100000";
  process.env["LOOMBRE_RATE_CLAIM"] = "100000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
  await refreshAdminToken();
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
// RED — R-F1: PATCH /users/me's 200 body is an email-existence oracle
// ============================================================================

describe("RED R-F1: the updateMe success body must not reveal whether the address was taken", () => {
  // PENDING OWNER DECISION (STATE.md 🔶): E8-vs-E1/E4 email-oracle trilemma — see reauth run
  it.skip("the SAME actor's colliding and free attempts must be indistinguishable, `email` included", async () => {
    const victim = await createAndLoginFreshUser("rf1a-victim");
    const attacker = await createAndLoginFreshUser("rf1a-attacker");

    const freeTarget = `${uniqueTag("rf1a-free")}@example.invalid`;
    const free = await patchMe(attacker.accessToken, { email: freeTarget, currentPassword: attacker.password });
    const colliding = await patchMe(attacker.accessToken, { email: victim.email, currentPassword: attacker.password });

    expect(free.status).toBe(200);
    expect(colliding.status).toBe(200);

    // The oracle: a free address is echoed back, a taken one is not. Both
    // requests must answer with the address the caller submitted, or neither
    // must — anything else is a one-request existence test.
    expect(
      colliding.body.email === victim.email,
      "colliding attempt returned a DIFFERENT email than the one submitted — the caller can read 'that address is taken' straight out of the 200 body",
    ).toBe(free.body.email === freeTarget);
  });

  // PENDING OWNER DECISION (STATE.md 🔶): E8-vs-E1/E4 email-oracle trilemma — see reauth run
  it.skip("a 30-trial blind classifier over the 200 body must not beat chance", async () => {
    const trials: Array<{ email: string; taken: boolean }> = [];
    for (let i = 0; i < 15; i += 1) trials.push({ email: (await createAndLoginFreshUser(`rf1b-reg${i}`)).email, taken: true });
    for (let i = 0; i < 15; i += 1) trials.push({ email: `${uniqueTag(`rf1b-unreg${i}`)}@example.invalid`, taken: false });
    trials.sort(() => Math.random() - 0.5);

    const attacker = await createAndLoginFreshUser("rf1b-attacker");
    let correct = 0;
    for (const t of trials) {
      const res = await patchMe(attacker.accessToken, { email: t.email, currentPassword: attacker.password });
      expect(res.status).toBe(200);
      const guess = res.body.email !== t.email; // "taken"
      if (guess === t.taken) correct += 1;
    }
    // 30/30 is a perfect oracle. Anything at or below ~2/3 is noise; a real
    // guard should sit near 15/30.
    expect(correct, `classifier scored ${correct}/30 from the response body alone (chance = 15/30)`).toBeLessThanOrEqual(20);
  }, 300_000);

  // PENDING OWNER DECISION (STATE.md 🔶): E8-vs-E1/E4 email-oracle trilemma — see reauth run
  it.skip("GET /users/me must not confirm it either (the un-rate-limited follow-up)", async () => {
    const victim = await createAndLoginFreshUser("rf1c-victim");
    const attacker = await createAndLoginFreshUser("rf1c-attacker");

    // Clear own email first, so the read-back is a crisp boolean.
    expect((await patchMe(attacker.accessToken, { email: null, currentPassword: attacker.password })).status).toBe(200);
    expect((await patchMe(attacker.accessToken, { email: victim.email, currentPassword: attacker.password })).status).toBe(200);

    const me = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${attacker.accessToken}`);
    expect(me.status).toBe(200);
    expect(
      me.body.email,
      "after a colliding email change the account is left email-less — `null` here IS the answer 'that address belongs to someone'",
    ).not.toBeNull();
  });

  // PENDING OWNER DECISION (STATE.md 🔶): E8-vs-E1/E4 email-oracle trilemma — see reauth run
  it.skip("the oracle is case-insensitive (CITEXT), so it does not even need the victim's exact casing", async () => {
    const victim = await createAndLoginFreshUser("rf1d-victim");
    const attacker = await createAndLoginFreshUser("rf1d-attacker");
    const shouted = victim.email.toUpperCase();
    const res = await patchMe(attacker.accessToken, { email: shouted, currentPassword: attacker.password });
    expect(res.status).toBe(200);
    expect(res.body.email, "an UPPERCASED form of somebody else's address is detected as a collision and silently dropped, which the body then reports").toBe(
      shouted,
    );
  });
});

// ============================================================================
// RED — R-F2: the claim flow leaks the same bit one step later
// ============================================================================

describe("RED R-F2: a claimed account must not reveal whether its submitted address was taken", () => {
  // PENDING OWNER DECISION (STATE.md 🔶): E8-vs-E1/E4 email-oracle trilemma — see reauth run
  it.skip("colliding claim leaves email null, readable with the token the claim itself returned", async () => {
    const victim = await createAndLoginFreshUser("rf2-victim");

    const collidingClaim = await request(app.getHttpServer())
      .post(`/invites/claim/${await freshInviteToken()}`)
      .send({ username: uniqueTag("rf2-collide"), password: "rf2-claim-password-1", email: victim.email });
    expect(collidingClaim.status, JSON.stringify(collidingClaim.body)).toBe(201);

    const freeTarget = `${uniqueTag("rf2-free")}@example.invalid`;
    const freeClaim = await request(app.getHttpServer())
      .post(`/invites/claim/${await freshInviteToken()}`)
      .send({ username: uniqueTag("rf2-free"), password: "rf2-claim-password-1", email: freeTarget });
    expect(freeClaim.status, JSON.stringify(freeClaim.body)).toBe(201);

    const collidedMe = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${collidingClaim.body.accessToken}`);
    const freeMe = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${freeClaim.body.accessToken}`);

    expect(
      collidedMe.body.email === null,
      "the colliding claim's account has email null while the free claim's has its address — one GET after the claim answers 'is this address registered?'",
    ).toBe(freeMe.body.email === null);
  });
});

// ============================================================================
// RED — R-F3: admin self reset-password is a currentPassword-free password change
// ============================================================================

describe("RED R-F3: a stolen access token alone must never be able to set a password", () => {
  it("POST /users/{self}/reset-password on an admin's own account must require re-authentication", async () => {
    const target = await createAndLoginFreshUser("rf3-admin", true);

    // The attacker's ONLY capability is this bearer token.
    const reset = await request(app.getHttpServer())
      .post(`/users/${target.userId}/reset-password`)
      .set("Authorization", `Bearer ${target.accessToken}`)
      .send({});

    expect(
      reset.status,
      `self reset-password answered ${reset.status} with a temporary password — a stolen admin token is a complete account takeover with no knowledge of the current password`,
    ).not.toBe(200);
  });

  it("…and the real owner must not be locked out of their own account by it", async () => {
    const target = await createAndLoginFreshUser("rf3b-admin", true);
    const reset = await request(app.getHttpServer())
      .post(`/users/${target.userId}/reset-password`)
      .set("Authorization", `Bearer ${target.accessToken}`)
      .send({});
    // Only meaningful while the route above still succeeds; when R-F3 is
    // fixed this becomes a trivially-true guard.
    if (reset.status !== 200) return;
    const ownerLogin = await loginAs(target.username, target.password);
    expect(ownerLogin.status, "the legitimate owner's own password no longer logs them in").toBe(200);
  });

  it("CONTROL (green): a non-admin cannot reach that route at all", async () => {
    const u = await createAndLoginFreshUser("rf3c");
    const res = await request(app.getHttpServer())
      .post(`/users/${u.userId}/reset-password`)
      .set("Authorization", `Bearer ${u.accessToken}`)
      .send({});
    expect(res.status).toBe(403);
  });
});

// ============================================================================
// RED — R-F4: email is neither trimmed nor normalized
// ============================================================================

describe("RED R-F4: a whitespace-padded address must not dodge the collision check", () => {
  it("a value that is not an address at all must not be storable in `email`", async () => {
    const u = await createAndLoginFreshUser("rf4z");
    const res = await patchMe(u.accessToken, { email: "not an address", currentPassword: u.password });
    expect(
      res.status,
      "the contract declares UpdateMeRequest.email as format:email and F5 turned users.email into the `to:` of an automatically dispatched notice — the server validates only `typeof === string`",
    ).toBe(422);
  });

  it("' victim@… ' must not become a second, separately-stored copy of a taken address", async () => {
    const victim = await createAndLoginFreshUser("rf4-victim");
    const attacker = await createAndLoginFreshUser("rf4-attacker");

    const padded = ` ${victim.email} `;
    const res = await patchMe(attacker.accessToken, { email: padded, currentPassword: attacker.password });
    expect(res.status).toBe(200);
    expect(
      res.body.email,
      "the padded form was stored verbatim: two accounts now hold visually identical addresses and the F5 in-use notice never fired",
    ).not.toBe(padded);
  });
});

// ============================================================================
// RED — R-F5: the 24h notice window is burned even when nothing was sent
// ============================================================================

describe("RED R-F5: a failed dispatch must not consume the address's 24h notice window", () => {
  it("an enqueue failure (trySend => dispatched:false) must leave the window unclaimed", async () => {
    const victim = await createAndLoginFreshUser("rf5-victim");
    const attacker = await createAndLoginFreshUser("rf5-attacker");

    const cfgSpy = mockMailConfigured(true);
    // The REAL E6 degradation path: the queue rejects, trySend catches it and
    // returns {dispatched:false}. The controller never looks at that result.
    const enqueueSpy = vi
      .spyOn(app.get(JobQueueProvider).queue, "enqueue")
      .mockRejectedValue(new Error("job queue unavailable"));
    try {
      const res = await patchMe(attacker.accessToken, { email: victim.email, currentPassword: attacker.password });
      expect(res.status).toBe(200);
    } finally {
      enqueueSpy.mockRestore();
      cfgSpy.mockRestore();
    }

    const ledgerRow = await rawDb
      .selectFrom("email_collision_notice_ledger")
      .selectAll()
      .where("email", "=", victim.email)
      .executeTakeFirst();
    expect(
      ledgerRow,
      "the ledger window was claimed although no mail was dispatched — this address is now silent for 24h after a transient queue hiccup",
    ).toBeUndefined();
  });

  it("…and the very next collision on that address must still be able to notify", async () => {
    const victim = await createAndLoginFreshUser("rf5b-victim");
    const attacker1 = await createAndLoginFreshUser("rf5b-attacker1");
    const attacker2 = await createAndLoginFreshUser("rf5b-attacker2");

    const cfgSpy1 = mockMailConfigured(true);
    const enqueueSpy = vi
      .spyOn(app.get(JobQueueProvider).queue, "enqueue")
      .mockRejectedValue(new Error("job queue unavailable"));
    try {
      await patchMe(attacker1.accessToken, { email: victim.email, currentPassword: attacker1.password });
    } finally {
      enqueueSpy.mockRestore();
      cfgSpy1.mockRestore();
    }

    const cfgSpy2 = mockMailConfigured(true);
    const sendSpy = vi.spyOn(app.get(MailDispatchService), "trySend").mockResolvedValue({ dispatched: true, jobId: "x" });
    try {
      await patchMe(attacker2.accessToken, { email: victim.email, currentPassword: attacker2.password });
    } finally {
      sendSpy.mockRestore();
      cfgSpy2.mockRestore();
    }

    const notices = sendSpy.mock.calls.filter(
      (c) => (c[0] as { templateId: string; to: string }).templateId === "email-in-use-notice" && (c[0] as { to: string }).to === victim.email,
    );
    expect(notices.length, "the earlier failed dispatch silently ate this address's notice window").toBe(1);
  });
});

// ============================================================================
// RED — R-F6: updateUserSelf's 23505 backstop is dead code (poisoned trx)
// ============================================================================

describe("RED R-F6: two users racing the same free address must not 500", () => {
  it("the losing racer gets a generic 200, never an Internal Server Error", async () => {
    const statuses: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      const a = await createAndLoginFreshUser(`rf6-a${round}`);
      const b = await createAndLoginFreshUser(`rf6-b${round}`);
      const target = `${uniqueTag("rf6-target")}@example.invalid`;
      const [ra, rb] = await Promise.all([
        patchMe(a.accessToken, { email: target, currentPassword: a.password }),
        patchMe(b.accessToken, { email: target, currentPassword: b.password }),
      ]);
      statuses.push(`${ra.status}/${rb.status}`);
    }
    expect(
      statuses.filter((s) => s.includes("500")),
      `rounds that 500ed: ${statuses.join(" ")} — updateUserSelf catches the 23505 and then issues another statement on the SAME (already aborted) transaction, so the "re-apply without the email member" backstop can never run`,
    ).toHaveLength(0);
  }, 300_000);

  it("MECHANISM: a statement issued after a caught 23505 must still work (savepoint the backstop)", async () => {
    const victim = await createAndLoginFreshUser("rf6m-victim");
    const actor = await createAndLoginFreshUser("rf6m-actor");
    let followUpError: unknown;
    try {
      await rawDb.transaction().execute(async (trx) => {
        try {
          await trx.updateTable("users").set({ email: victim.email }).where("id", "=", actor.userId).execute();
        } catch {
          // Exactly what updateUserSelf's backstop does next.
          await trx.updateTable("users").set({ display_name: "after-catch" }).where("id", "=", actor.userId).execute();
        }
      });
    } catch (err) {
      followUpError = err;
    }
    expect(
      followUpError,
      "Postgres aborts the whole transaction on a constraint violation (25P02) — the backstop must run in a SAVEPOINT or outside the transaction",
    ).toBeUndefined();
  }, 120_000);
});

// ============================================================================
// RED — R-F7: "Other devices have been signed out." is not true yet
// ============================================================================

describe("RED R-F7: the revoked device must actually lose access, not just its refresh token", () => {
  it("the other device's ACCESS token must stop working once the UI says it was signed out", async () => {
    const u = await createAndLoginFreshUser("rf7");
    const deviceB = await loginAs(u.username, u.password);
    expect(deviceB.status).toBe(200);

    const changed = await patchMe(u.accessToken, { password: "rf7-new-password", currentPassword: u.password });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    const stillWorking = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${deviceB.body.accessToken}`);
    expect(
      stillWorking.status,
      "F3/F4: ChangePasswordSection states 'Other devices have been signed out.' the moment this 200 lands, but the other device keeps FULL API access until its access token expires (ACCESS_TOKEN_TTL_MS = 15 minutes) — only the refresh token was revoked",
    ).toBe(401);
  }, 120_000);
});

// ============================================================================
// GREEN — the parts of F1–F6 this review verified as sound. These must stay
// green through any fix wave.
// ============================================================================

describe("GREEN: the admin twin's email-conflict handling is NOT affected by R-F6", () => {
  it("PATCH /users/{id} answers a real 409 (single statement, no poisoned transaction)", async () => {
    const victim = await createAndLoginFreshUser("g13-victim");
    const target = await createAndLoginFreshUser("g13-target");
    const res = await asAdmin((token) =>
      request(app.getHttpServer()).patch(`/users/${target.userId}`).set("Authorization", `Bearer ${token}`).send({ email: victim.email }),
    );
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });
});

describe("GREEN F2/E8: the 403 is byte-identical across every target field and both endpoints", () => {
  it("password / email-set / email-remove / email-colliding / both, on updateMe AND putRestricted", async () => {
    const u = await createAndLoginFreshUser("g1");
    const bodies: Array<Record<string, unknown>> = [
      { password: "irrelevant", currentPassword: "wrong" },
      { email: `${uniqueTag("g1")}@example.invalid`, currentPassword: "wrong" },
      { email: null, currentPassword: "wrong" },
      { email: "admin@loombre.invalid", currentPassword: "wrong" },
      { password: "irrelevant", email: `${uniqueTag("g1")}@example.invalid`, currentPassword: "wrong" },
    ];
    const shapes = new Set<string>();
    for (const body of bodies) {
      const res = await patchMe(u.accessToken, body);
      expect(res.status).toBe(403);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      shapes.add(JSON.stringify({ ...res.body, instance: "X" }));
    }
    const restricted = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${u.accessToken}`)
      .send({ optIn: true, pin: "1234", currentPassword: "wrong" });
    expect(restricted.status).toBe(403);
    shapes.add(JSON.stringify({ ...restricted.body, instance: "X" }));

    expect([...shapes], "every 403 must be the same bytes modulo `instance`").toHaveLength(1);
  }, 120_000);
});

describe("GREEN F1/G3: no shape of currentPassword bypasses the compare", () => {
  it("missing / empty / number / null / boolean / array / object all 422 with the same target-agnostic detail", async () => {
    const u = await createAndLoginFreshUser("g2");
    const values: Array<[string, unknown]> = [
      ["empty", ""],
      ["number", 12345],
      ["null", null],
      ["boolean", true],
      ["array-of-correct", [u.password]],
      ["object", { toString: u.password }],
    ];
    const missing = await patchMe(u.accessToken, { email: `${uniqueTag("g2")}@example.invalid` });
    expect(missing.status).toBe(422);
    const detail = missing.body.detail;
    for (const [label, value] of values) {
      const res = await patchMe(u.accessToken, { email: `${uniqueTag("g2")}@example.invalid`, currentPassword: value });
      expect(res.status, `${label} should 422`).toBe(422);
      expect(res.body.detail, `${label} detail must stay target-agnostic`).toBe(detail);
    }
  }, 120_000);

  it("a currentPassword that is valid for a DIFFERENT user is rejected", async () => {
    const other = await createAndLoginFreshUser("g3-other");
    const me = await createAndLoginFreshUser("g3-me");
    const res = await patchMe(me.accessToken, { password: "g3-new", currentPassword: other.password });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("current-password-invalid");
  });

  it("unknown keys 422 on BOTH endpoints (additionalProperties:false is real)", async () => {
    const u = await createAndLoginFreshUser("g4");
    for (const key of ["isAdmin", "maxContentRating", "mustChangePassword", "password_hash"]) {
      const res = await patchMe(u.accessToken, { [key]: true, currentPassword: u.password });
      expect(res.status, `updateMe should 422 on ${key}`).toBe(422);
      expect(res.body.detail).toBe(`Unknown property "${key}".`);
    }
    const restricted = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${u.accessToken}`)
      .send({ optIn: true, pin: "1234", currentPassword: u.password, restrictedOptIn: true });
    expect(restricted.status).toBe(422);
  }, 120_000);

  it("PUT /users/me/settings cannot flip restrictedOptIn (no re-auth-free back door)", async () => {
    const u = await createAndLoginFreshUser("g5");
    const opted = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${u.accessToken}`)
      .send({ optIn: true, pin: "4321", currentPassword: u.password });
    expect(opted.status, JSON.stringify(opted.body)).toBe(200);

    const flip = await request(app.getHttpServer())
      .put("/users/me/settings")
      .set("Authorization", `Bearer ${u.accessToken}`)
      .send({
        restrictedOptIn: false,
        locale: "en-US",
        theme: "system",
        subtitlePreferredLanguage: null,
        audioPreferredLanguage: null,
        autoplayNextEpisode: true,
        updatedAtMs: Date.now(),
      });
    expect(flip.status).toBe(200);
    const row = await rawDb.selectFrom("user_settings").selectAll().where("user_id", "=", u.userId).executeTakeFirst();
    expect(row?.restricted_opt_in, "the readOnly restrictedOptIn must stay ignored").toBe(true);
    expect(row?.restricted_pin_hash).not.toBeNull();
  }, 120_000);
});

describe("GREEN G3: the must-change-password hole stays closed", () => {
  it("a stolen access token on a flagged account cannot set a password without the temporary one", async () => {
    const u = await createAndLoginFreshUser("g6");
    const reset = await asAdmin((token) =>
      request(app.getHttpServer()).post(`/users/${u.userId}/reset-password`).set("Authorization", `Bearer ${token}`).send({}),
    );
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const temporaryPassword = reset.body.temporaryPassword;

    expect((await patchMe(u.accessToken, { password: "attacker-chosen" })).status).toBe(422);
    expect((await patchMe(u.accessToken, { password: "attacker-chosen", currentPassword: "guess" })).status).toBe(403);
    expect(
      (await patchMe(u.accessToken, { password: "attacker-chosen", currentPassword: u.password })).status,
      "the PRE-reset password must not work either",
    ).toBe(403);
    expect((await patchMe(u.accessToken, { password: "attacker-chosen", currentPassword: temporaryPassword })).status).toBe(200);
  }, 120_000);

  it("every OTHER self-service route stays blocked while flagged", async () => {
    const u = await createAndLoginFreshUser("g7");
    await asAdmin((token) =>
      request(app.getHttpServer()).post(`/users/${u.userId}/reset-password`).set("Authorization", `Bearer ${token}`).send({}),
    );
    const restricted = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${u.accessToken}`)
      .send({ optIn: true, pin: "1111", currentPassword: u.password });
    expect(restricted.status).toBe(403);
    expect(restricted.body.type).toBe("urn:loombre:problem:password-change-required");
  }, 120_000);
});

describe("GREEN F3: session revocation on a self-service password change", () => {
  it("the caller's own session survives, every other device dies, and the event carries the count", async () => {
    const u = await createAndLoginFreshUser("g8");
    const deviceB = await loginAs(u.username, u.password);
    expect(deviceB.status).toBe(200);

    const changed = await patchMe(u.accessToken, { password: "g8-new-password", currentPassword: u.password });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    const callerRefresh = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: u.refreshToken, deviceId: u.deviceId });
    expect(callerRefresh.status, "F3: the current session is KEPT").toBe(200);

    const otherRefresh = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: deviceB.body.refreshToken, deviceId: deviceB.body.deviceId });
    expect(otherRefresh.status, "F3: every OTHER device is signed out").toBe(401);

    const event = await rawDb
      .selectFrom("events")
      .selectAll()
      .where("type", "=", "session.revoked-by-password-change")
      .where("actor_user_id", "=", u.userId)
      .executeTakeFirst();
    expect(event, "G5: the outbox event must be written in the same transaction").toBeDefined();
    expect((event!.payload as { userId: string; username: string; revokedCount: number }).revokedCount).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("an email-only change revokes nothing", async () => {
    const u = await createAndLoginFreshUser("g9");
    const deviceB = await loginAs(u.username, u.password);
    expect((await patchMe(u.accessToken, { email: `${uniqueTag("g9")}@example.invalid`, currentPassword: u.password })).status).toBe(200);
    const otherRefresh = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: deviceB.body.refreshToken, deviceId: deviceB.body.deviceId });
    expect(otherRefresh.status).toBe(200);
  }, 120_000);
});

describe("GREEN G8: the wall-clock floors mask the collision cell", () => {
  it("colliding and free email changes both pay the floor and their medians stay within a few ms", async () => {
    const cfgSpy = mockMailConfigured(true);
    const sendSpy = vi.spyOn(app.get(MailDispatchService), "trySend").mockResolvedValue({ dispatched: true, jobId: "x" });
    try {
      const n = 12;
      const victims: string[] = [];
      for (let i = 0; i < n; i += 1) victims.push((await createAndLoginFreshUser(`g10-v${i}`)).email);
      const attacker = await createAndLoginFreshUser("g10-attacker");

      const collide: number[] = [];
      const free: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const t0 = performance.now();
        await patchMe(attacker.accessToken, { email: victims[i]!, currentPassword: attacker.password });
        collide.push(performance.now() - t0);
        const t1 = performance.now();
        await patchMe(attacker.accessToken, { email: `${uniqueTag("g10-free")}@example.invalid`, currentPassword: attacker.password });
        free.push(performance.now() - t1);
      }
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
      expect(Math.min(...collide), "the floor applies to the collision cell").toBeGreaterThanOrEqual(190);
      expect(Math.min(...free), "the floor applies to the clean cell").toBeGreaterThanOrEqual(190);
      expect(
        Math.abs(med(collide) - med(free)),
        `median gap ${Math.abs(med(collide) - med(free)).toFixed(1)}ms — the extra ledger+enqueue work must stay inside the floor`,
      ).toBeLessThan(15);
    } finally {
      sendSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  }, 300_000);

  it("a bare displayName save is deliberately NOT floored", async () => {
    const u = await createAndLoginFreshUser("g11");
    const t0 = performance.now();
    const res = await patchMe(u.accessToken, { displayName: "g11" });
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed, "no email member => no floor (G8)").toBeLessThan(190);
  });
});

describe("GREEN G4: the per-user limiter is real, shared, and serialized as problem+json", () => {
  it("successful re-auths consume budget, the bucket spans both endpoints, and 429 carries Retry-After", async () => {
    process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "3";
    const limitedApp = await NestFactory.create(AppModule, { logger: false });
    await limitedApp.init();
    try {
      const username = uniqueTag("g12");
      const password = "g12-password-1";
      await refreshAdminToken();
      const created = await request(limitedApp.getHttpServer())
        .post("/users")
        .set("Authorization", `Bearer ${adminAccessToken}`)
        .send({ username, email: `${username}@example.invalid`, password, isAdmin: false });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const login = await request(limitedApp.getHttpServer())
        .post("/auth/login")
        .send({ username, password, deviceName: uniqueTag("g12-dev"), deviceProfile: buildDeviceProfile() });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      const at = login.body.accessToken;

      const codes: number[] = [];
      let limited: request.Response | undefined;
      for (let i = 0; i < 4; i += 1) {
        const res = await request(limitedApp.getHttpServer())
          .patch("/users/me")
          .set("Authorization", `Bearer ${at}`)
          .send({ email: `${uniqueTag("g12")}@example.invalid`, currentPassword: password });
        codes.push(res.status);
        if (res.status === 429) limited = res;
      }
      expect(codes, "SUCCESSFUL re-auths spend the budget too — the limiter is not a failure counter").toEqual([200, 200, 200, 429]);
      expect(limited!.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(limited!.body.type).toBe("urn:loombre:problem:rate-limited");
      expect(limited!.headers["retry-after"]).toBeDefined();

      const crossEndpoint = await request(limitedApp.getHttpServer())
        .put("/users/me/restricted")
        .set("Authorization", `Bearer ${at}`)
        .send({ optIn: true, pin: "1234", currentPassword: password });
      expect(crossEndpoint.status, "one bucket per user, shared across both re-auth endpoints").toBe(429);
    } finally {
      await limitedApp.close();
      process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "100000";
    }
  }, 300_000);
});
