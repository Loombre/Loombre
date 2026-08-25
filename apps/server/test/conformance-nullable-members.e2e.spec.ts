// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/conformance-nullable-members.e2e.spec.ts
//
// Remediation d3-b8 (P3, B/conformance-nullable-request-members).
//
// conformance.spec.ts walks every documented operation with a BODYLESS
// request and asserts one exact status per operation. That shape can only
// ever catch a controller that is LOOSER than the contract (an operation
// answering 200 where the contract says 401, an undocumented route). It is
// structurally blind to the opposite drift — a controller REJECTING a body
// the contract calls valid — because it never builds a schema-valid body at
// all. That blindness is not hypothetical: `POST /users {"email": null}`
// answered 422 for months against a `CreateUserRequest.email` typed
// `[string, 'null']` (d3-b1; AddUserSheet.tsx sends exactly that for a
// blank field, so creating an email-less user from the admin UI was
// broken), and the conformance suite was green throughout.
//
// This suite adds the directed pass conformance.spec.ts cannot express:
// for EVERY request member openapi.yaml types `[X, 'null']`, send an
// otherwise-minimal VALID body with that member explicitly null, and assert
// the answer is not a 422 that complains about that member. It deliberately
// asserts nothing about WHICH non-422 status comes back — a placeholder
// path param 404ing, an unmet business rule 409ing, a real 201 are all
// equally fine; the only thing under test is that a contract-valid null is
// not rejected as invalid input.
//
// SCOPE, stated honestly: top-level request members only. Nullable members
// nested inside a $ref'd sub-schema (DeviceProfile.video[].maxProfile and
// friends) are out — they are reached through a required parent this walk
// fills from a fixture, and the d3-b1 class this exists for lives at the
// top level. Some cases only reach an EXISTENCE gate that runs before body
// validation (putAdminLibraryStashConnection 404s on the placeholder
// library id before it ever reads the body); those cases prove the weaker
// "not rejected", which is still the assertion the finding asks for. The
// pinned CASES list below makes both facts auditable rather than implicit.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed).

import "reflect-metadata";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { parse as parseYaml } from "yaml";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const OPENAPI_PATH = path.resolve(__dirname, "../../../packages/contract/openapi.yaml");
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

const PLACEHOLDER_UUID = "11111111-1111-4111-8111-111111111111";
const ADMIN_PASSWORD = "loombre-seed-admin";

/** The reference device profile every other suite in this package uses. */
function buildDeviceProfile(profileId = "nullable-members-conformance") {
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

// ---------------------------------------------------------------------------
// Contract walk
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

interface OpenApiDoc {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, JsonSchema> };
}

interface OpenApiOperation {
  operationId?: string;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

const doc = parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDoc;

function deref(schema: JsonSchema): JsonSchema {
  const ref = schema["$ref"];
  if (typeof ref !== "string") return schema;
  const name = ref.split("/").pop()!;
  const target = doc.components.schemas[name];
  if (!target) throw new Error(`openapi.yaml: unresolvable $ref ${ref}`);
  return deref(target);
}

function isNullableType(type: unknown): boolean {
  return Array.isArray(type) && type.includes("null");
}

interface NullableCase {
  operationId: string;
  method: string;
  urlTemplate: string;
  schema: JsonSchema;
  member: string;
}

/** Every top-level request member openapi.yaml types `[X, 'null']`. */
function collectNullableCases(): NullableCase[] {
  const cases: NullableCase[] = [];
  for (const [urlTemplate, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op?.requestBody) continue;
      const declared = op.requestBody.content?.["application/json"]?.schema;
      if (!declared) continue; // non-JSON bodies (import archives) are out of scope
      const schema = deref(declared);
      const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
      for (const [member, memberSchema] of Object.entries(properties)) {
        if (!isNullableType(deref(memberSchema)["type"])) continue;
        cases.push({ operationId: op.operationId!, method, urlTemplate, schema, member });
      }
    }
  }
  return cases;
}

/** Pinned so a NEW nullable request member cannot join the contract without
 *  a conscious decision here — the same exactly-zero-allowance discipline
 *  conformance.spec.ts's IMPLEMENTED_NON_PUBLIC_EXPECTATIONS applies. */
const PINNED_CASES = [
  "claimInvite.email",
  "computePlaybackPlan.mediaFileId",
  "createFirstAdmin.displayName",
  "createInvite.displayName",
  "createPlaybackSession.mediaFileId",
  "createUser.displayName",
  "createUser.email",
  "createUser.maxContentRating",
  "diagnoseRemote.wanAddress",
  "enableRemoteDirect.domain",
  "putAdminLibraryStashConnection.blobsPath",
  "putAdminLibraryStashConnection.genreTagNames",
  "putMySettings.audioPreferredLanguage",
  "putMySettings.subtitlePreferredLanguage",
  "putProgress.durationMs",
  "updateMe.birthDate",
  "updateMe.displayName",
  "updateMe.email",
  "updateUser.displayName",
  "updateUser.email",
  "updateUser.maxContentRating",
];

// ---------------------------------------------------------------------------
// Minimal-valid-body generation
// ---------------------------------------------------------------------------

/** Required members whose generated value would be valid-but-pointless (an
 *  enum's first member that the handler rejects for an unrelated reason, a
 *  sub-schema this repo already has a canonical fixture for). Keyed
 *  `<operationId>.<member>`; every entry carries its reason. */
const REQUIRED_MEMBER_OVERRIDES: Record<string, unknown> = {
  // RemotePathId's first enum member is "none", which diagnoseRemote
  // rejects outright ("path must be an active path") — that 422 would hide
  // whatever wanAddress:null does. `.invalid` is the RFC 2606 reserved TLD
  // remote-probes.e2e.spec.ts already resolves for its NXDOMAIN case, so
  // this stays as network-free as that suite's own live-DNS assertion.
  "diagnoseRemote.path": "direct",
  "diagnoseRemote.expectedEndpoint": "loombre-d3b8-unresolvable.invalid",
  // mode:"acme" makes `domain` CONDITIONALLY REQUIRED (normalizeDomain runs
  // on it), so a null domain is legitimately a 422 there and would say
  // nothing about nullability. reverse-proxy is the mode where the
  // contract's `[string,'null']` actually means "omit the domain".
  "enableRemoteDirect.mode": "reverse-proxy",
  // The canonical device/network fixtures — a schema-minimal DeviceProfile
  // (empty codec arrays) is rejected by the plan validator for reasons
  // unrelated to mediaFileId.
  "computePlaybackPlan.device": buildDeviceProfile(),
  "createPlaybackSession.device": buildDeviceProfile(),
  "computePlaybackPlan.network": { maxBitrateBps: 20_000_000, isLocal: true },
  "createPlaybackSession.network": { maxBitrateBps: 20_000_000, isLocal: true },
  // G2/G3 re-auth: UpdateMeRequest.dependentRequired pulls currentPassword
  // in whenever `email` is present — including an explicit null.
  "updateMe.currentPassword": ADMIN_PASSWORD,
};

function sampleFor(schema: JsonSchema, hint: string): unknown {
  const resolved = deref(schema);
  const enumValues = resolved["enum"] as unknown[] | undefined;
  if (enumValues?.length) return enumValues[0];

  const rawType = resolved["type"];
  const type = Array.isArray(rawType) ? rawType.find((t) => t !== "null") : rawType;

  switch (type) {
    case "string": {
      const format = resolved["format"];
      if (format === "uuid") return PLACEHOLDER_UUID;
      if (format === "email") return `d3b8-${hint.toLowerCase()}@example.test`;
      if (format === "date") return "1990-01-01";
      if (format === "password") return "d3b8-conformance-password";
      const pattern = resolved["pattern"];
      if (pattern === "^[a-z]{3}$") return "eng";
      const value = `d3b8-${hint}`;
      const maxLength = resolved["maxLength"];
      return typeof maxLength === "number" ? value.slice(0, maxLength) : value;
    }
    case "integer":
    case "number": {
      const minimum = resolved["minimum"];
      return typeof minimum === "number" ? minimum : 1;
    }
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      const properties = (resolved["properties"] ?? {}) as Record<string, JsonSchema>;
      for (const key of (resolved["required"] ?? []) as string[]) {
        out[key] = sampleFor(properties[key] ?? {}, `${hint}-${key}`);
      }
      return out;
    }
    default:
      return null;
  }
}

/** The body sent for one case: every required member filled with a valid
 *  sample (overrides win), `dependentRequired` honoured for the nulled
 *  member, and the member under test explicitly null. */
function buildBody(testCase: NullableCase): Record<string, unknown> {
  const { schema, member, operationId } = testCase;
  const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
  const body: Record<string, unknown> = {};

  const fill = (key: string) => {
    if (key === member) return;
    const override = REQUIRED_MEMBER_OVERRIDES[`${operationId}.${key}`];
    body[key] = override !== undefined ? override : sampleFor(properties[key] ?? {}, `${operationId}-${key}`);
  };

  for (const key of (schema["required"] ?? []) as string[]) fill(key);
  const dependentRequired = (schema["dependentRequired"] ?? {}) as Record<string, string[]>;
  for (const key of dependentRequired[member] ?? []) fill(key);

  body[member] = null;
  return body;
}

/** The single assertion this suite exists for. Exported shape kept tiny so
 *  the control case below can feed it a recorded pre-fix response. */
function complainsAboutMember(status: number, body: unknown, member: string): boolean {
  if (status !== 422) return false;
  const detail = String((body as { detail?: unknown } | undefined)?.detail ?? "");
  return new RegExp(`\\b${member}\\b`, "i").test(detail);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let app: INestApplication;
let adminToken: string;
/** Per-operation body tweaks that need a value only the live server knows. */
let liveOverrides: Record<string, unknown> = {};

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "conformance_nullable_members_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "conformance-nullable-members-secret-not-for-production";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const login = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: ADMIN_PASSWORD,
    deviceName: "conformance-nullable-members",
    deviceProfile: buildDeviceProfile(),
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  adminToken = login.body.accessToken;

  // putMySettings takes a WHOLE UserSettings (updatedAtMs included), so the
  // only "otherwise-minimal valid body" that means anything is the caller's
  // current settings with one member nulled.
  const settings = await request(app.getHttpServer())
    .get("/users/me/settings")
    .set("Authorization", `Bearer ${adminToken}`);
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  liveOverrides = { putMySettings: settings.body as Record<string, unknown> };

  // createInvite wants library ids that exist; the seed has libraries.
  const libraries = await request(app.getHttpServer())
    .get("/libraries")
    .set("Authorization", `Bearer ${adminToken}`);
  const firstLibraryId = (libraries.body?.items ?? [])[0]?.id;
  if (typeof firstLibraryId === "string") {
    REQUIRED_MEMBER_OVERRIDES["createInvite.libraryIds"] = [firstLibraryId];
  }
});

/** label -> the status the server actually answered, printed at the end so
 *  a reader can see WHERE each case landed (a 404 on a placeholder id is a
 *  weaker proof than a 201, and this suite refuses to hide that). */
const observed = new Map<string, number>();

afterAll(async () => {
  await app?.close();
  const lines = [...observed.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, status]) => `  ${label} -> ${status}`);
  console.log(`nullable request members walked (${observed.size}):\n${lines.join("\n")}`);
});

describe("d3-b8: a contract-valid null request member is never rejected as invalid input", () => {
  const cases = collectNullableCases();

  it("visits every nullable request member openapi.yaml declares (pinned)", () => {
    const found = cases.map((c) => `${c.operationId}.${c.member}`).sort();
    expect(
      found,
      "openapi.yaml's nullable request members changed — add the new one to PINNED_CASES and give it a REQUIRED_MEMBER_OVERRIDES entry if its minimal body needs one",
    ).toEqual([...PINNED_CASES].sort());
  });

  it("detects the exact 422 d3-b1 used to answer (control — proves the assertion has teeth)", () => {
    // Verbatim pre-d3-b1 body of POST /users {"email": null}.
    expect(
      complainsAboutMember(422, { detail: "email must be a non-empty string when present." }, "email"),
      "the detector must flag a 422 that names the nulled member",
    ).toBe(true);
    // A 422 about a DIFFERENT member is not this suite's business.
    expect(complainsAboutMember(422, { detail: "username is required." }, "email")).toBe(false);
    // Neither is any non-422 answer (404 on a placeholder id, 409, 201…).
    expect(complainsAboutMember(404, { detail: "User not found." }, "email")).toBe(false);
  });

  for (const testCase of cases) {
    const label = `${testCase.operationId}.${testCase.member}`;
    it(`${testCase.method.toUpperCase()} ${testCase.urlTemplate} accepts ${label} = null`, async () => {
      const base = (liveOverrides[testCase.operationId] as Record<string, unknown> | undefined) ?? {};
      const body = { ...base, ...buildBody(testCase) };
      // createUser really creates rows — keep each case's username distinct
      // so a later case never collides with an earlier one's account.
      if (testCase.operationId === "createUser") body["username"] = `d3b8-${testCase.member}`;

      const url = testCase.urlTemplate.replace(/\{[^}]+\}/g, PLACEHOLDER_UUID);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent: any = request(app.getHttpServer());
      const res = await agent[testCase.method](url)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("content-type", "application/json")
        .send(body);

      observed.set(label, res.status);
      expect(
        complainsAboutMember(res.status, res.body, testCase.member),
        `${label}: the contract types this member [X,'null'] but the server answered ${res.status} ${JSON.stringify(res.body)} for body ${JSON.stringify(body)}`,
      ).toBe(false);
    });
  }
});
