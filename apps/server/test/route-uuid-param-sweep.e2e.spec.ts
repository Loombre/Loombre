// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/route-uuid-param-sweep.e2e.spec.ts
//
// api-validation-F1 regression net. apps/server/src/gateway/require-uuid-param.ts
// states the repo policy in its header — requireUuidParam is "called as the
// FIRST statement of every :id-path-param handler, before any DB touch" —
// and packages/db/src/query/cursor.ts:66-67 states the reason: binding a
// non-uuid string into a uuid column comparison raises Postgres 22P02
// inside the driver, which ProblemJsonExceptionFilter's catch-all can only
// render as a generic 500 for what is a CLIENT input mistake. "Client input
// is never a 500."
//
// That policy was enforced ONE CONTROLLER AT A TIME, so a whole module
// (apps/server/src/plugins/**, 20 route-method pairs) could be written
// without a single requireUuidParam call and nothing noticed. This suite
// closes that by construction: it enumerates EVERY mounted Express route
// that has an id-shaped path param (`:id` or `:somethingId` — deliberately
// NOT `:token`/`:key`/`:name`/`:provider`/`:entityType`/`:kind`/`*file`,
// which are not uuid columns), fires each method at it with a
// syntactically-invalid uuid, and asserts the byte-shape every OTHER
// id route already produces: 404 application/problem+json,
// urn:loombre:problem:not-found — never a 5xx.
//
// New :id routes are picked up automatically (the enumeration is the
// router, not a hand-maintained list), so this cannot silently regress the
// way the plugins module did.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

/** Syntactically invalid as a Postgres `uuid` — the exact class of input
 *  that raises 22P02 when it reaches a uuid column comparison. */
const NON_UUID = "not-a-uuid";

/** Path params that are NOT uuid columns and so are out of scope here —
 *  each gets a plausible literal so the request reaches the handler and
 *  the id param stays the only malformed thing about it. */
const NON_ID_PARAM_VALUES: Readonly<Record<string, string>> = {
  entityType: "item",
  kind: "primary",
  file: "s000000.m4s",
  token: "opaque-token",
  name: "crash.log",
  key: "library.scanIntervalMinutes",
  provider: "builtin",
};

const SWEPT_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type SweptMethod = (typeof SWEPT_METHODS)[number];

/** `:id` or `:somethingId` — the naming convention every uuid-column path
 *  param in packages/contract/openapi.yaml uses (`{id}`, `{itemId}`). */
function isIdParam(name: string): boolean {
  return name === "id" || /Id$/.test(name);
}

function valueForParam(name: string): string {
  if (isIdParam(name)) return NON_UUID;
  return NON_ID_PARAM_VALUES[name] ?? "x";
}

interface SweptRoute {
  method: SweptMethod;
  routePath: string;
  probePath: string;
  idParams: string[];
}

interface ProbeResult extends SweptRoute {
  status: number;
  contentType: string;
  problemType: unknown;
  detail: unknown;
}

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

/** Enumerates the routes Nest actually mounted (same access path
 *  conformance.spec.ts's "mounts no undocumented routes" assertion uses),
 *  keeping only those with an id-shaped param. */
function enumerateIdRoutes(app: INestApplication): SweptRoute[] {
  const httpAdapter = app.getHttpAdapter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expressInstance: any = httpAdapter.getInstance();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router: any = expressInstance.router ?? expressInstance._router;
  if (!router) throw new Error("Express router not found on Nest's http adapter instance");

  const routes: SweptRoute[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of router.stack as any[]) {
    if (!layer.route) continue;
    const routePath = String(layer.route.path);

    const paramNames = [
      ...[...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string),
      ...[...routePath.matchAll(/\*([A-Za-z0-9_]+)/g)].map((m) => m[1] as string),
    ];
    const idParams = paramNames.filter(isIdParam);
    if (idParams.length === 0) continue;

    const probePath = routePath
      .replace(/:([A-Za-z0-9_]+)/g, (_full, name: string) => valueForParam(name))
      .replace(/\*([A-Za-z0-9_]+)/g, (_full, name: string) => valueForParam(name));

    const methods = Object.keys((layer.route.methods ?? {}) as Record<string, boolean>);
    for (const method of methods) {
      if (!(SWEPT_METHODS as readonly string[]).includes(method)) continue;
      routes.push({ method: method as SweptMethod, routePath, probePath, idParams });
    }
  }
  return routes.sort((a, b) => `${a.routePath} ${a.method}`.localeCompare(`${b.routePath} ${b.method}`));
}

let app: INestApplication;
let adminToken: string;
let results: ProbeResult[] = [];

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `route-uuid-sweep-${username}-${Date.now()}-${Math.random()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_route_uuid_sweep");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "route-uuid-sweep-e2e-test-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  adminToken = await loginAs("admin", "loombre-seed-admin");

  const routes = enumerateIdRoutes(app);
  results = [];
  for (const route of routes) {
    const agent = request(app.getHttpServer());
    let req = agent[route.method](route.probePath).set("Authorization", `Bearer ${adminToken}`);
    if (route.method === "post" || route.method === "put" || route.method === "patch") {
      req = req.send({});
    }
    const res = await req;
    const body = (res.body ?? {}) as Record<string, unknown>;
    results.push({
      ...route,
      status: res.status,
      contentType: String(res.headers["content-type"] ?? ""),
      problemType: body["type"],
      detail: body["detail"],
    });
  }
}, 300_000);

afterAll(async () => {
  await app?.close();
  delete process.env["LOOMBRE_RATE_LOGIN"];
});

function describeRow(r: ProbeResult): string {
  return `${r.method.toUpperCase()} ${r.routePath} -> ${r.status} ${String(r.problemType ?? "")}`;
}

describe("every mounted :id-style route rejects a non-UUID path param as 404, never 500", () => {
  it("enumerates a non-trivial set of id routes (guards against a vacuously green sweep)", () => {
    expect(results.length).toBeGreaterThan(30);
    // The four plugins-module controllers api-validation-F1 named must be
    // in the swept set — if a refactor moves them out of the router this
    // suite must fail loudly rather than quietly stop covering them.
    const paths = new Set(results.map((r) => r.routePath));
    for (const required of [
      "/admin/plugins/:id",
      "/admin/plugins/:id/config",
      "/admin/plugins/:id/rotate-hmac",
      "/admin/libraries/:id/provider-chain",
      "/admin/libraries/:id/stash-connection",
      "/admin/libraries/:id/stash-path-mappings",
      "/admin/libraries/:id/stash-sync",
      "/admin/libraries/:id/stash-sync-report",
    ]) {
      expect(paths.has(required), `${required} is not mounted`).toBe(true);
    }
  });

  it("answers no id route with a 5xx (client input is never a 500)", () => {
    const serverErrors = results.filter((r) => r.status >= 500);
    expect(serverErrors.map(describeRow), "id routes that 5xx on a malformed uuid").toEqual([]);
  });

  it("answers every id route with a 404 problem+json", () => {
    const wrong = results.filter(
      (r) =>
        r.status !== 404 ||
        !r.contentType.includes("application/problem+json") ||
        r.problemType !== "urn:loombre:problem:not-found",
    );
    expect(wrong.map(describeRow), "id routes that do not answer a malformed uuid with a not-found problem").toEqual([]);
  });
});
