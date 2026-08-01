// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contract conformance test (STATE.md D17/D21, task spec's "D21 tightening").
 * Boots the real Nest app in-process against a reset+reseeded live DB
 * (public/authenticated ops now do real work — login, capabilities,
 * restricted settings — so this suite needs real data, unlike Phase 0's
 * pure 401-wall version) and:
 *
 *   1. Walks every NON-PUBLIC documented operation unauthenticated and
 *      asserts a 401 RFC 9457 problem+json wall (Phase 0 behavior,
 *      narrowed to exclude the four public operations).
 *   2. Asserts the PUBLIC operations (POST /auth/login, POST /auth/refresh,
 *      GET /system/capabilities) return schema-valid documented responses
 *      instead of 401 — including a real login with seed admin credentials
 *      returning a schema-valid TokenPair (D21 tightening).
 *   3. NEW — authenticated walk: with a real seed-admin access token
 *      attached, every NON-PUBLIC documented operation must return a
 *      NON-401 status (proving the guard passes valid tokens through to
 *      the handler/catch-all rather than blocking them), AND must have an
 *      exact expected status recorded in IMPLEMENTED_NON_PUBLIC_EXPECTATIONS
 *      — the unimplemented-allowance is EXACTLY ZERO (STATE.md P3.7/step
 *      6b), so an operation missing from that map fails the suite outright
 *      instead of silently coasting on a coincidental catch-all 404.
 *   4. Asserts /healthz stays public (200), since it's deliberately not
 *      part of the /v1 contract.
 *   5. Mounted-route assertion (D21 tightening): every mounted Express
 *      route beyond /healthz and the catch-all `/*splat` must correspond
 *      to a documented contract path (no undocumented surface) — replacing
 *      Phase 0's "exactly {/healthz, /*splat}" now that real controllers
 *      are mounted.
 */
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { API_OPERATIONS, type ApiOperation } from "@loombre/sdk";
import { AppModule } from "../src/app.module.js";

// Runs against a database PRIVATE to apps/server's own test run
// (ensureTestDatabase, "<base>_server_test") to avoid a cross-package
// concurrent-reset deadlock under turbo — see auth.e2e.spec.ts's header and
// packages/db/src/testing.ts.
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
    throw new Error(
      `${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function buildDeviceProfile() {
  return {
    profileId: "web-chrome",
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

/** Syntactically valid UUID used to fill in every `{param}` path segment. */
const PLACEHOLDER_UUID = "11111111-1111-4111-8111-111111111111";

function resolvePath(templatedPath: string): string {
  return templatedPath.replace(/\{[^}]+\}/g, PLACEHOLDER_UUID);
}

const PROBLEM_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer", minimum: 100, maximum: 599 },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
  },
  required: ["title", "status"],
  additionalProperties: true,
} as const;

// Mirrors packages/contract/openapi.yaml's TokenPair/Capabilities schemas
// closely enough to catch shape drift, without re-deriving the whole
// contract at runtime (packages/contract's own test suite is the source of
// truth for exhaustive schema validation).
const TOKEN_PAIR_SCHEMA = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
    refreshToken: { type: "string" },
    accessTokenExpiresAtMs: { type: "integer" },
    deviceId: { type: "string", format: "uuid" },
  },
  required: ["accessToken", "refreshToken", "accessTokenExpiresAtMs", "deviceId"],
  additionalProperties: false,
} as const;

// STATE.md P4.6/P4.10 (lane C): GET /setup/state's SetupState shape.
const SETUP_STATE_SCHEMA = {
  type: "object",
  properties: {
    needsSetup: { type: "boolean" },
  },
  required: ["needsSetup"],
  additionalProperties: false,
} as const;

const CAPABILITIES_SCHEMA = {
  type: "object",
  properties: {
    flags: { type: "array", items: { type: "string" } },
    details: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { enabled: { type: "boolean" }, description: { type: ["string", "null"] } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
  },
  required: ["flags", "details"],
  additionalProperties: false,
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const validateProblem: ValidateFunction = ajv.compile(PROBLEM_SCHEMA);
const validateTokenPair: ValidateFunction = ajv.compile(TOKEN_PAIR_SCHEMA);
const validateCapabilities: ValidateFunction = ajv.compile(CAPABILITIES_SCHEMA);
const validateSetupState: ValidateFunction = ajv.compile(SETUP_STATE_SCHEMA);

/** Express route layers with a bound HTTP verb, keyed by method+path (matches supertest's method names). */
const SUPPORTED_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;

/** Task spec's public set, mirrored from apps/server/src/gateway/auth.guard.ts's
 *  PUBLIC_ROUTES (kept independent here deliberately — this test is meant
 *  to catch drift between the guard and the contract, not share its
 *  source of truth with the thing it's proving).
 *
 *  STATE.md P4.6/P4.10 (lane C) added getSetupState/createFirstAdmin —
 *  both `security: []` in openapi.yaml. createFirstAdmin stays in this set
 *  even on THIS suite's seeded DB (where it is permanently inert): public
 *  means "AuthGuard never gates it", not "it always succeeds" — see the
 *  dedicated setup-surface assertions below for its 404-on-seeded-DB
 *  behavior. */
const PUBLIC_OPERATION_IDS = new Set([
  "authLogin",
  "authRefresh",
  "getSystemCapabilities",
  "getSetupState",
  "createFirstAdmin",
]);

/** Every non-public documented operation's exact expected status when
 *  called authenticated-but-bodyless (the conformance walker never sends a
 *  body/query — see resolvePath). The unimplemented-allowance is EXACTLY
 *  ZERO (see the Phase 3 §11 step 6b note below) — an operationId absent
 *  from this map fails the authenticated walk outright rather than
 *  defaulting to an assumed NotFoundController catch-all -> 404.
 *
 *  P1.17 (catalog/cross-type/progress/people-tags/images/libraries/users/
 *  devices/admin/data-freedom wave): every path param the walker fills in
 *  is PLACEHOLDER_UUID, which never resolves to a real row, so every
 *  single-resource GET/PATCH/DELETE below is 404 (indistinguishable from
 *  "exists but invisible" — mission spec) UNLESS the operation validates
 *  its (bodyless) request body first, in which case 422 wins BEFORE any
 *  write happens (createLibrary/createUser both 422 on a missing required
 *  field with zero rows touched — no cross-test-file DB pollution to
 *  worry about; seeded-conformance.spec.ts uses its own freshly
 *  reset+reseeded database regardless).
 *
 *  Phase 3 §11 step 6b (STATE.md P3.7/P3.9(e)): the unimplemented-
 *  allowance NARROWS TO EXACTLY ZERO this step — every documented contract
 *  path is now mounted. playback/plan runs the real plan() engine (full
 *  §5 shape); playback/sessions runs admission control + enqueues worker
 *  jobs; the new HLS (hls/media.m3u8, hls/{file}) and subtitle
 *  (subtitles/media.m3u8, subtitles/{file}) surfaces are all live (see
 *  apps/server/src/playback/**). Every one of these, walked with a
 *  PLACEHOLDER_UUID path param against a nonexistent session, resolves to
 *  404 deterministically and immediately (no 8s poll wait — the session
 *  lookup itself fails on the very first loop iteration for the manifest
 *  routes; the wildcard/single-segment {file} routes reject the
 *  placeholder UUID as not matching their strict filename pattern before
 *  ever touching the DB). */
const IMPLEMENTED_NON_PUBLIC_EXPECTATIONS: Record<string, number> = {
  authLogout: 204,
  // Directory browsing for the Add-library picker: with an admin token and
  // no `path` parameter it returns the roots listing, so 200. (The separate
  // unauthenticated walk in this same suite is what pins the 401 — the
  // route must never be reachable without a token, since enumerating a
  // server's directory tree is reconnaissance.)
  browseDirectories: 200,
  putMyRestrictedSettings: 422, // bodyless -> "optIn is required"
  unlockRestricted: 422, // bodyless -> "pin is required"
  lockRestricted: 204,
  // Wave 1c (Phosphor retheme, "contract enablers" lane): restricted.enabled
  // defaults OFF and this suite never turns it on, so gate 1 fails for
  // EVERY viewer including the seed admin -> no restricted-library
  // entitlement -> 404 (the zone does not exist server-side for anyone on
  // this instance). See apps/server/test/libraries.e2e.spec.ts for the
  // entitled-admin 200 case (that suite sets LOOMBRE_RESTRICTED_ENABLED).
  getRestrictedCount: 404,
  // STATE.md Stash run (S9): same not-entitled-on-this-suite's-DB posture
  // as getRestrictedCount immediately above, for every dedicated zone
  // surface op — see apps/server/test/seeded-conformance.spec.ts for the
  // entitled-admin locked-empty/unlocked-real-content round trips.
  getRestrictedHome: 404,
  listRestrictedBrowse: 404,
  getRestrictedScene: 404,
  listRestrictedPerformers: 404,
  getRestrictedPerformer: 404,
  listRestrictedPerformerScenes: 404,
  listRestrictedStudios: 404,
  getRestrictedStudio: 404,
  // Entitlement (404) is checked BEFORE `q` — PLACEHOLDER_UUID's walk sends
  // no ?q= at all, so this seed-admin's zero entitlement wins over the
  // would-be 422 (restricted-zone.controller.ts's own documented ordering).
  restrictedSearch: 404,
  // DEPRECATED (CLAUDE.md evolution policy — oasdiff's
  // api-path-removed-without-deprecation finding, see openapi.yaml's own
  // comment on this op): kept working, thinly delegating to
  // listRestrictedBrowse, same not-entitled posture as every other zone op.
  listRestrictedZoneItems: 404,

  // catalog-video
  listMovies: 200,
  getMovie: 404,
  listSeries: 200,
  getSeries: 404,
  listSeriesSeasons: 404, // series lookup fails first
  listSeasonEpisodes: 404, // season lookup fails first
  getEpisode: 404,

  // catalog-music
  listArtists: 200,
  getArtist: 404,
  listArtistAlbums: 404, // artist lookup fails first
  getAlbum: 404,
  listAlbumTracks: 404, // album lookup fails first
  getTrack: 404,

  // cross-type
  search: 422, // no ?q= sent -> "q is required"
  getContinueWatching: 200,
  getRecentlyAdded: 200,

  // images
  getImage: 404, // placeholder entity id never resolves

  // progress
  getProgress: 404, // PLACEHOLDER_UUID item never resolves -> guarded item-visibility 404 (see progress.controller.ts:55-64)
  putProgress: 422, // bodyless -> "positionMs is required"
  listProgress: 200,

  // people / tags
  listPeople: 200,
  getPerson: 404,
  listPersonItems: 404, // person lookup fails first (PLACEHOLDER_UUID never resolves)
  listTags: 200,

  // watchlist (Phosphor Wave 2 lane L3)
  listWatchlist: 200,
  addToWatchlist: 404, // PLACEHOLDER_UUID item never resolves -> item-existence gate first
  removeFromWatchlist: 404, // same gate as add

  // libraries (admin)
  listLibraries: 200,
  createLibrary: 422, // bodyless -> "name is required"; validation fails before any row is inserted
  getLibrary: 404,
  updateLibrary: 404, // bodyless body is valid (no required fields); library lookup fails
  deleteLibrary: 404,
  scanLibrary: 404,
  getLibraryPermissions: 404,
  putLibraryPermissions: 404, // library existence checked before body validation

  // users/devices/admin (admin + self-service)
  listUsers: 200,
  createUser: 422, // bodyless -> "username is required"; validation fails before any row is inserted
  getUser: 404,
  updateUser: 404,
  deleteUser: 404,
  getMe: 200,
  updateMe: 200, // bodyless body is valid (no required fields) -> no-op update of the caller
  getMySettings: 200,
  // H1 (owner ledger item 6, closed): putMySettings now requires+validates
  // a real UserSettings body (locale/theme/language-pref/autoplay/etc, all
  // required per the contract) — this walk sends no body at all, so it 422s
  // the same way createUser/putProgress do above ("bodyless -> required
  // field missing").
  putMySettings: 422, // bodyless -> "restrictedOptIn is required"
  listDevices: 200,
  getDevice: 404,
  revokeDevice: 404,
  listJobs: 200,
  getJob: 404,
  listAdminSessions: 200,
  getSystemInfo: 200,
  getSystemUpdate: 200, // release lane (STATE.md P4.3/P4.16); LOOMBRE_UPDATE_CHECK=off is set in beforeAll -> deterministic {verification: "disabled"}, zero network
  // Phase 4 deliverable D (this lane): admin ops surfaces.
  getAdminCapabilities: 200, // null envelope on this suite's fresh reseeded DB (no hwprobe has ever run) — still 200, per contract
  listCrashFiles: 200, // empty items[] — LOOMBRE_DATA_DIR unset in this suite, crashes dir doesn't exist
  getCrashFile: 404, // PLACEHOLDER_UUID happens to satisfy the strict crash-file name pattern (alnum+dash), but no such file exists
  getAdminLogsTail: 200, // LOOMBRE_LOG_FILE unset in this suite -> {source: null, lines: []}, still 200

  // data-freedom
  exportData: 200,
  importData: 422, // bodyless -> "must be an ExportArchive"

  // admin settings (STATE.md Addendum A, decision A6)
  getAdminSettings: 200,
  getAdminSettingsSchema: 200,
  updateAdminSetting: 404, // placeholder key never matches a registry entry -> unknown-key 404, before any body validation
  setAdminProviderKey: 404, // placeholder provider ("tmdb"/"tvdb" only) -> unknown-provider 404, before any body validation
  clearAdminProviderKey: 404, // same reasoning, no body involved at all

  // admin plugins (LPP v1, Lane W5) — fresh reseeded DB has zero registered
  // plugins, so every path-param op 404s before touching its (bodyless)
  // request; the two no-path-param writes 422 on a missing `url`.
  previewAdminPlugin: 422, // bodyless -> "url is required."
  listAdminPlugins: 200, // empty items[]
  registerAdminPlugin: 422, // bodyless -> baseUrl validation fails before the conflict/manifest-fetch checks
  getAdminPlugin: 404, // PLACEHOLDER_UUID never matches a registered plugin
  removeAdminPlugin: 404,
  updateAdminPluginConfig: 404, // getPluginById 404s before the (bodyless) config is ever validated
  updateAdminPluginEventGrants: 404,
  updateAdminPluginPseudonymization: 404, // same ordering as updateAdminPluginConfig (Lane W5b)
  enableAdminPlugin: 404,
  disableAdminPlugin: 404,
  refreshAdminPlugin: 404,
  reapproveAdminPlugin: 404,
  rotateAdminPluginHmac: 404,

  // admin library provider chains (LPP v1, Lane W5b) — PLACEHOLDER_UUID
  // never matches a real library either way; library existence is checked
  // before the (bodyless) PUT body is ever validated (mirrors
  // putLibraryPermissions' own documented ordering).
  getAdminLibraryProviderChain: 404,
  putAdminLibraryProviderChain: 404,

  // Admin Stash surface (STATE.md Stash run, Lanes C+D) — same
  // PLACEHOLDER_UUID library-never-exists posture; existence is checked
  // before the report read / any (bodyless) PUT/POST body validation
  // (same ordering as getAdminLibraryProviderChain above).
  getAdminStashSyncReport: 404,
  getAdminLibraryStashConnection: 404,
  putAdminLibraryStashConnection: 404,
  getAdminLibraryStashPathMappings: 404,
  putAdminLibraryStashPathMappings: 404,
  previewAdminLibraryStashPathMappings: 404,
  postAdminLibraryStashSync: 404,

  // Fix Match (Phosphor retheme Wave 2, Lane L2) — PLACEHOLDER_UUID never
  // matches a real library/item either way; existence is checked before
  // the (bodyless) apply-match body is ever validated (same ordering as
  // putLibraryPermissions/updateAdminPluginConfig above).
  listUnmatchedLibraryItems: 404,
  searchItemMatchCandidates: 404,
  applyItemMatch: 404,

  // playback (Phase 3 §11 step 6b: real plan() engine + admission control
  // + HLS/subtitle serving — unimplemented-allowance is now EXACTLY ZERO)
  computePlaybackPlan: 422, // bodyless -> "itemId (uuid string) is required."
  createPlaybackSession: 422, // bodyless -> same PlanRequest validation
  getPlaybackSession: 404, // placeholder session id never resolves
  endPlaybackSession: 404,
  getPlaybackSessionFile: 404, // placeholder session id never resolves
  getPlaybackHlsManifest: 404, // placeholder session id -> immediate 404, no poll wait
  getPlaybackHlsFile: 404, // placeholder {file} segment fails the strict filename pattern
  getPlaybackSubtitleManifest: 404, // placeholder session id -> immediate 404
  getPlaybackSubtitleFile: 404, // placeholder {file} segment isn't 'sub0.vtt'
};

let app: INestApplication;
let adminAccessToken: string;

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "conformance-test-secret-not-for-production";
  // Release lane (STATE.md P4.3/P4.16): this suite's authenticated walk
  // calls EVERY documented operation, including GET /system/update — force
  // it deterministic and network-free (verification: "disabled") rather
  // than let the "daily" default attempt a real fetch against the
  // (placeholder, pre-public-launch) manifest mirror URL during a test run.
  process.env["LOOMBRE_UPDATE_CHECK"] = "off";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const login = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "conformance-walker",
    deviceProfile: buildDeviceProfile(),
  });
  if (login.status !== 200) {
    throw new Error(`conformance setup: seed-admin login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  adminAccessToken = login.body.accessToken;
});

afterAll(async () => {
  await app.close();
});

describe("contract conformance (STATE.md D17/D21)", () => {
  it("/healthz stays public and returns 200 (not part of the /v1 contract)", async () => {
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("walks every NON-PUBLIC documented operation unauthenticated and asserts a 401 problem+json wall", async () => {
    expect(API_OPERATIONS.length).toBeGreaterThan(0);

    let walked = 0;
    for (const op of API_OPERATIONS as readonly ApiOperation[]) {
      if (PUBLIC_OPERATION_IDS.has(op.operationId)) continue;
      if (!(SUPPORTED_METHODS as readonly string[]).includes(op.method)) {
        throw new Error(`unsupported HTTP method in contract: ${op.method} ${op.path}`);
      }

      const path = resolvePath(op.path);
      const label = `${op.method.toUpperCase()} ${path} (${op.operationId})`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent: any = request(app.getHttpServer());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (agent[op.method](path) as Promise<any>);

      expect(res.status, label).toBe(401);
      expect(res.headers["content-type"], `${label} content-type`).toMatch(
        /^application\/problem\+json/,
      );

      const valid = validateProblem(res.body);
      expect(
        valid,
        `${label} problem body invalid: ${ajv.errorsText(validateProblem.errors)} — got ${JSON.stringify(res.body)}`,
      ).toBe(true);

      walked += 1;
    }

    const expectedCount = API_OPERATIONS.length - PUBLIC_OPERATION_IDS.size;
    console.log(`walked ${walked}/${expectedCount} non-public documented operations`);
    expect(walked).toBe(expectedCount);
  });

  describe("public operations return schema-valid documented responses (D21 tightening)", () => {
    it("GET /system/capabilities -> 200, Ajv-valid Capabilities", async () => {
      const res = await request(app.getHttpServer()).get("/system/capabilities");
      expect(res.status).toBe(200);
      const valid = validateCapabilities(res.body);
      expect(valid, ajv.errorsText(validateCapabilities.errors)).toBe(true);
    });

    it("POST /auth/login with real seed-admin credentials -> 200, Ajv-valid TokenPair", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({
        username: "admin",
        password: "loombre-seed-admin",
        deviceName: "conformance-login-check",
        deviceProfile: buildDeviceProfile(),
      });
      expect(res.status).toBe(200);
      const valid = validateTokenPair(res.body);
      expect(valid, ajv.errorsText(validateTokenPair.errors)).toBe(true);
    });

    it("POST /auth/login with wrong credentials -> 401 problem+json (still a documented status)", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({
        username: "admin",
        password: "wrong",
        deviceName: "conformance-login-check",
        deviceProfile: buildDeviceProfile(),
      });
      expect(res.status).toBe(401);
      const valid = validateProblem(res.body);
      expect(valid, ajv.errorsText(validateProblem.errors)).toBe(true);
    });

    it("POST /auth/refresh with a bodyless request -> 401 problem+json (documented; refresh has no 422)", async () => {
      const res = await request(app.getHttpServer()).post("/auth/refresh").send();
      expect(res.status).toBe(401);
      const valid = validateProblem(res.body);
      expect(valid, ajv.errorsText(validateProblem.errors)).toBe(true);
    });

    // STATE.md P4.6/P4.10 (lane C): the setup surface's OWN empty-DB happy
    // path (state true -> create -> 201 -> state false -> second create
    // 404, plus race safety) lives in apps/server/test/setup.e2e.spec.ts's
    // dedicated fresh (unseeded) database — this suite's DB already has the
    // seed admin+casual users by the time these run (beforeAll above), so
    // both assertions here exercise the "instance already configured" side
    // only.
    it("GET /setup/state -> 200, Ajv-valid SetupState, needsSetup:false (this suite's DB is seeded)", async () => {
      const res = await request(app.getHttpServer()).get("/setup/state");
      expect(res.status).toBe(200);
      const valid = validateSetupState(res.body);
      expect(valid, ajv.errorsText(validateSetupState.errors)).toBe(true);
      expect(res.body).toEqual({ needsSetup: false });
    });

    it("POST /setup/first-admin -> 404 byte-identical to the catch-all unknown-route problem body (users already exist)", async () => {
      const res = await request(app.getHttpServer()).post("/setup/first-admin").send({
        username: "conformance-second-admin",
        email: "conformance-second-admin@loombre.local",
        password: "irrelevant-because-inert",
      });
      const unknownRoute = await request(app.getHttpServer())
        .get("/this-route-does-not-exist-conformance")
        .set("Authorization", `Bearer ${adminAccessToken}`);

      expect(res.status).toBe(404);
      expect(unknownRoute.status).toBe(404);
      expect(res.headers["content-type"]).toBe(unknownRoute.headers["content-type"]);
      expect(res.text).toBe(unknownRoute.text);
      expect(JSON.parse(res.text)).toEqual({ type: "about:blank", title: "Not Found", status: 404 });
    });
  });

  it("authenticated walk: every NON-PUBLIC documented operation returns a non-401 status with a valid admin Bearer token", async () => {
    let walked = 0;
    for (const op of API_OPERATIONS as readonly ApiOperation[]) {
      if (PUBLIC_OPERATION_IDS.has(op.operationId)) continue;

      const path = resolvePath(op.path);
      const label = `${op.method.toUpperCase()} ${path} (${op.operationId})`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent: any = request(app.getHttpServer());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (agent[op.method](path).set("Authorization", `Bearer ${adminAccessToken}`) as Promise<any>);

      expect(res.status, `${label} must not be 401 when a valid token is presented`).not.toBe(401);

      const expected = IMPLEMENTED_NON_PUBLIC_EXPECTATIONS[op.operationId];
      if (expected === undefined) {
        // The unimplemented-allowance is EXACTLY ZERO (see the map's own
        // header comment) — a missing entry here is a coverage hole in
        // this suite, not a legitimately-unimplemented operation, so fail
        // loudly instead of silently assuming a catch-all 404.
        throw new Error(
          `${label} has no entry in IMPLEMENTED_NON_PUBLIC_EXPECTATIONS — add its exact expected status (the unimplemented-allowance is EXACTLY ZERO).`,
        );
      }
      expect(res.status, `${label} expected status`).toBe(expected);

      walked += 1;
    }

    const expectedCount = API_OPERATIONS.length - PUBLIC_OPERATION_IDS.size;
    console.log(`authenticated-walked ${walked}/${expectedCount} non-public documented operations`);
    expect(walked).toBe(expectedCount);
  });

  it("mounts no undocumented routes: every mounted route beyond /healthz and the catch-all corresponds to a documented contract path", () => {
    const httpAdapter = app.getHttpAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expressInstance: any = httpAdapter.getInstance();
    const router = expressInstance.router ?? expressInstance._router;
    expect(router, "Express router not found on Nest's http adapter instance").toBeTruthy();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routeLayers = (router.stack as any[]).filter((layer) => Boolean(layer.route));
    // Express registers path params as `:name` (e.g. "/movies/:id");
    // openapi.yaml documents them as `{name}` ("/movies/{id}") — P1.17
    // normalizes here rather than changing either source of truth, since
    // every pre-P1.17 implemented route happened to have zero path params
    // and never exercised this mismatch. Phase 3 §11 step 6b extends the
    // SAME normalization to Express 5's named-wildcard syntax (`*name`,
    // used by hls-file.controller.ts's segment route to capture a
    // multi-segment `runN/sNNNNNN.ext` path) — `{name}` either way, the
    // contract has no notion of "wildcard vs single-segment" param syntax.
    const mountedPaths = routeLayers.map((layer) =>
      String(layer.route.path)
        .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
        .replace(/\*([A-Za-z0-9_]+)/g, "{$1}"),
    );

    // Both forms present: the catch-all's raw Express path is "/*splat",
    // but this test's OWN wildcard normalization above (needed for
    // hls-file.controller.ts's `*file` route) also turns it into
    // "/{splat}" — exempt both rather than special-casing the
    // normalization step to skip exactly one named wildcard.
    const EXEMPT_PATHS = new Set(["/healthz", "/*splat", "/{splat}"]);
    const documentedPaths = new Set((API_OPERATIONS as readonly ApiOperation[]).map((op) => op.path));

    const undocumented = mountedPaths.filter(
      (mountedPath) => !EXEMPT_PATHS.has(mountedPath) && !documentedPaths.has(mountedPath),
    );
    expect(undocumented, `undocumented route(s) mounted: ${undocumented.join(", ")}`).toEqual([]);

    // Every implemented controller's route must actually be reachable —
    // proves this assertion isn't vacuously true because nothing mounted.
    // (playback stays deliberately unmounted this wave — absent here.)
    const mountedSet = new Set(mountedPaths);
    const implementedOperationIds = [
      "authLogin",
      "authRefresh",
      "getSystemCapabilities",
      "getSetupState",
      "createFirstAdmin",
      ...Object.keys(IMPLEMENTED_NON_PUBLIC_EXPECTATIONS),
    ];
    for (const implementedOperationId of implementedOperationIds) {
      const op = (API_OPERATIONS as readonly ApiOperation[]).find(
        (candidate) => candidate.operationId === implementedOperationId,
      );
      expect(op, `${implementedOperationId} missing from API_OPERATIONS`).toBeTruthy();
      expect(mountedSet.has(op!.path), `${implementedOperationId} (${op!.path}) not mounted`).toBe(true);
    }
  });
});
