// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/review-findings.e2e.spec.ts
//
// LANE R (adversarial review of the "Optional mail transport + invitation &
// reset flows" run) — RED-BY-DESIGN regression tests.
//
// ============================================================================
// READ THIS BEFORE "FIXING THE TEST"
// ============================================================================
// Every `it()` in this file is expected to FAIL against the tree it landed
// on. Each one asserts the CORRECT behavior for a defect the R lane proved
// with a live HTTP probe; the assertion is the specification for the fix.
// When a fix lands, its test turns green and stays here as the regression
// pin. Do NOT weaken an assertion to make the suite pass — that is exactly
// the H1 bug class this repo has a rule against.
//
// Findings pinned here (see the R-lane report for the full write-up):
//
//   R-F2  POST /invites accepts a FRACTIONAL expiresInMs inside the 1h-30d
//         bounds and 500s at the database. The controller's own error text
//         already promises "must be an integer" and the contract declares
//         `type: integer` (CreateInviteRequest.expiresInMs), but nothing
//         calls Number.isInteger — the value flows to a BIGINT column and
//         Postgres raises `invalid input syntax for type bigint`.
//         Site: apps/server/src/invites/invites.controller.ts (the
//         expiresInMs validation block).
//
//   R-F3  POST /invites/claim/{token} is an unauthenticated EMAIL-EXISTENCE ORACLE.
//         packages/db/src/query/invites.ts maps ANY Postgres 23505 raised
//         by createUserAdminAndEmit to `username-conflict`, but
//         users.email is CITEXT UNIQUE too (0001, loosened by 0023) — so
//         claiming with a brand-new username and an email that already
//         belongs to somebody answers 422 "Username \"<new>\" is already
//         taken." That message is (a) untrue, and (b) a probe an invite
//         holder can repeat indefinitely, because a username conflict
//         deliberately rolls the whole claim transaction back and leaves
//         the invite unconsumed. E8's "no enumeration anywhere" covers
//         this surface.
//         Sites: packages/db/src/query/invites.ts (isPgUniqueViolation /
//         the createUserAdminAndEmit catch) and
//         apps/server/src/invites/invites.controller.ts (the
//         "username-conflict" branch).
//
// Boot pattern copied from invites.e2e.spec.ts (in-process Nest app, real
// HTTP via supertest, live Postgres, its own database).

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

function buildDeviceProfile(profileId = "review-findings") {
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
let adminToken: string;

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `review-${username}-${Date.now()}`, deviceProfile: buildDeviceProfile() });
  if (res.status !== 200) throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

async function newInviteToken(): Promise<string> {
  const res = await request(app.getHttpServer())
    .post("/invites")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ libraryIds: [] });
  if (res.status !== 201) throw new Error(`invite creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.claimToken as string;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_review_findings");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "review-findings-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_CLAIM"] = "10000";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  rawDb = createDb(databaseUrl);
  adminToken = await loginAs("admin", "loombre-seed-admin");
});

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
  delete process.env["LOOMBRE_RATE_CLAIM"];
  delete process.env["LOOMBRE_RATE_LOGIN"];
});

describe("R-F2 (RED): POST /invites must reject a non-integer expiresInMs, not 500", () => {
  it("a fractional expiresInMs INSIDE the 1h-30d bounds is 422, not an unhandled 500", async () => {
    const res = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [], expiresInMs: 3_600_000.7 });

    // Landed behavior: 500 + {"type":"urn:loombre:problem:internal", ...}
    // because `1785658406816.7` reaches the BIGINT expires_at_ms column.
    expect(res.status, `expected 422, got ${res.status} ${JSON.stringify(res.body)}`).toBe(422);
    expect(res.body.type).toBe("urn:loombre:problem:validation");
  });

  it("no invite row is written when a non-integer expiresInMs is rejected", async () => {
    const before = await rawDb
      .selectFrom("user_invites")
      .select(({ fn }) => [fn.countAll<string>().as("c")])
      .executeTakeFirstOrThrow();

    await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [], expiresInMs: 7_200_000.25 });

    const after = await rawDb
      .selectFrom("user_invites")
      .select(({ fn }) => [fn.countAll<string>().as("c")])
      .executeTakeFirstOrThrow();
    expect(after.c).toBe(before.c);
  });

  it("the integer bounds themselves still behave (regression guard for the fix)", async () => {
    const min = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [], expiresInMs: 3_600_000 });
    expect(min.status, JSON.stringify(min.body)).toBe(201);

    const tooSmall = await request(app.getHttpServer())
      .post("/invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ libraryIds: [], expiresInMs: 3_599_999 });
    expect(tooSmall.status).toBe(422);
  });
});

describe("R-F3 (RED): POST /invites/claim/{token} must not be an email-existence oracle (E8)", () => {
  it("claiming with an email that already exists does NOT report a username conflict", async () => {
    // "admin" (seed) owns admin@example.com; this username is brand new.
    const seedAdmin = await rawDb
      .selectFrom("users")
      .select(["email"])
      .where("username", "=", "admin")
      .executeTakeFirstOrThrow();
    expect(seedAdmin.email, "seed admin must have an email for this probe").toBeTruthy();

    const res = await request(app.getHttpServer())
      .post(`/invites/claim/${await newInviteToken()}`)
      .send({ username: "totally-unused-username-1", password: "claim-password-1", email: seedAdmin.email });

    // Landed behavior: 422 `Username "totally-unused-username-1" is already
    // taken.` — untrue, and it discloses that the EMAIL is registered.
    expect(
      String(res.body?.detail ?? ""),
      `the response must not claim the (unused) username is taken: ${JSON.stringify(res.body)}`,
    ).not.toMatch(/totally-unused-username-1.*already taken/i);
  });

  it("an unused-username + taken-email claim is indistinguishable from an unused-username + unused-email claim that fails for any other reason", async () => {
    const seedAdmin = await rawDb
      .selectFrom("users")
      .select(["email"])
      .where("username", "=", "admin")
      .executeTakeFirstOrThrow();

    const takenEmail = await request(app.getHttpServer())
      .post(`/invites/claim/${await newInviteToken()}`)
      .send({ username: "oracle-probe-a", password: "claim-password-1", email: seedAdmin.email });

    const freeEmail = await request(app.getHttpServer())
      .post(`/invites/claim/${await newInviteToken()}`)
      .send({ username: "oracle-probe-b", password: "claim-password-1", email: "definitely-unused@example.invalid" });

    // Whatever the chosen posture (both succeed, or both fail identically),
    // an attacker holding one invite must not be able to tell "this email is
    // registered" from "this email is free" by the status alone.
    expect(
      takenEmail.status,
      `taken-email claim ${takenEmail.status} vs free-email claim ${freeEmail.status} — the status itself is the oracle`,
    ).toBe(freeEmail.status);
  });

  it("a genuine username conflict still reports a username conflict (regression guard for the fix)", async () => {
    const res = await request(app.getHttpServer())
      .post(`/invites/claim/${await newInviteToken()}`)
      .send({ username: "admin", password: "claim-password-1" });
    expect(res.status).toBe(422);
    expect(String(res.body.detail)).toMatch(/already taken/i);
  });

  // DEVIATION (recorded in the fix wave's freeze report): as originally
  // written this case asserted the OLD "conflict rolls back, invite stays
  // claimable" behavior for a taken-email probe — which is provably
  // incompatible with the test directly above ("indistinguishable ...").
  // That test's own comment anticipates "both succeed" as a legitimate
  // resolution ("Whatever the chosen posture (both succeed, or both fail
  // identically)..."), and only full closure (a taken email and a free
  // email producing an IDENTICAL status, body, AND invite-consumption
  // outcome) actually satisfies "no enumeration anywhere" (E8) — a
  // same-worded-but-still-distinguishable 422-vs-201 split would still let
  // an attacker learn "this email exists" from the status code alone. The
  // chosen fix (packages/db's claimInviteAndEmit) therefore silently drops
  // a conflicting email and completes the claim normally, which as a
  // side effect means the invite IS consumed on the very first attempt —
  // strictly stronger than the original ask, since it also eliminates the
  // "unlimited free probing of one token" amplifier this test's title
  // names: there is no longer a repeatable-without-consequence probe
  // surface at all, against a taken email OR a free one.
  it("a taken-email claim succeeds and burns the invite exactly like a fresh-email claim would — no repeatable oracle survives", async () => {
    const seedAdmin = await rawDb
      .selectFrom("users")
      .select(["email"])
      .where("username", "=", "admin")
      .executeTakeFirstOrThrow();
    const token = await newInviteToken();

    const res = await request(app.getHttpServer())
      .post(`/invites/claim/${token}`)
      .send({ username: "reusable-probe-1", password: "claim-password-1", email: seedAdmin.email });

    // Real success — the conflicting email was silently dropped, not
    // rejected (E8: no status-level tell between taken and free).
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // The invite is burned on this first attempt (same as any other
    // successful claim) — there is nothing left to re-probe.
    const state = await request(app.getHttpServer()).get(`/invites/claim/${token}`);
    expect(state.status).toBe(404);
  });
});
