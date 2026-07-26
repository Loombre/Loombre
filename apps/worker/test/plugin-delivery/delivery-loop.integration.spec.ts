// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/delivery-loop.integration.spec.ts
//
// LPP v1, Lane W4. End-to-end proof of the delivery loop against a REAL
// isolated Postgres database (never the shared dev DB — see this file's
// TEST-HARNESS note, same posture as packages/db/test/
// plugins-delivery.spec.ts) and REAL ephemeral-port HTTP subscriber stubs
// (env rule: no 3000/3001, no docker — `http.createServer().listen(0)`),
// wired through the REAL @loombre/plugin-host callPlugin/PluginCircuitBreaker
// and @loombre/plugin-protocol signLppBatch/LppEventBatchSchema — no
// shims. Covers every exit-gate item the mission brief calls out by name:
//   - in-order, batch-capped delivery
//   - clearance gating (C5) leak-proof: byte-absence from a general
//     subscriber, presence for a restricted subscriber
//   - pseudonymization: default-on byte-absence, toggle-off passthrough,
//     stability, cross-plugin unlinkability
//   - breaker trip + per-plugin isolation (a down plugin stalls nothing
//     else) — proven against the REAL plugins.enabled/health_state/
//     disabled_reason columns Lane W2's setPluginEnabledAndEmit/
//     setPluginHealthAndEmit write
//   - retention window + gap report
//   - kill/restart cursor-resume: duplicates allowed across the crash
//     boundary, loss never
//
// SSRF NOTE: every fixture plugin's lan_allowlist includes "127.0.0.1"
// (@loombre/plugin-host's hardenedFetch rejects loopback addresses by
// default per LD5 — see packages/plugin-host/src/ssrf.ts's
// assertHostAllowed) so these ephemeral 127.0.0.1 test servers are
// reachable at all, including the deliberately-unreachable "dead" plugin
// in the breaker test (which must reach the real TCP layer and get
// ECONNREFUSED -> 'network-error', not be rejected earlier as
// 'disallowed-address' — that would not be breaker-counted).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { spawnSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDb, listEventSubscriberPlugins } from "@loombre/db";
import { storeSecret, detectSecretBackend } from "@loombre/secrets";
import { LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT, LPP_PROTOCOL_VERSION, generateLppSigningSecret, type LppEventBatch } from "@loombre/plugin-protocol";
import { PluginCircuitBreaker } from "@loombre/plugin-host";
import { uuidv7 } from "@loombre/shared";
import { deliverOnePluginTick, startPluginDeliveryLoop, type DeliveryTickOutcome } from "../../src/plugin-delivery/delivery-loop.js";
import { pluginHmacKeyPath } from "../../src/plugin-delivery/keyring.js";
import { LPP_DELIVERY_RETENTION_WINDOW_MS } from "../../src/plugin-delivery/constants.js";
import { mirrorServerDataDir } from "../../src/metadata/keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

async function ensureFreshIsolatedDatabase(baseConnectionString: string, suffix: string): Promise<string> {
  const url = new URL(baseConnectionString);
  const baseDbName = url.pathname.replace(/^\//, "");
  const isolatedDbName = `${baseDbName}_${suffix}`;
  const isolatedUrl = new URL(baseConnectionString);
  isolatedUrl.pathname = `/${isolatedDbName}`;

  const admin = new pg.Client({ connectionString: baseConnectionString });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedDbName.replace(/"/g, '""')}"`);
    await admin.query(`CREATE DATABASE "${isolatedDbName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
  return isolatedUrl.toString();
}

function runMigrate(url: string): void {
  const result = spawnSync(process.execPath, [path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), "migrate"], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`migrate.mjs migrate failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

let DATABASE_URL: string;
let db: ReturnType<typeof createDb>;
let rawClient: pg.Client;
let dataDir: string;
let generalLibraryId: string;
let restrictedLibraryId: string;
const ORIGINAL_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];

function testEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LOOMBRE_DATA_DIR: dataDir, LOOMBRE_SECRET_BACKEND: "file0600" };
}

beforeAll(async () => {
  DATABASE_URL = await ensureFreshIsolatedDatabase(BASE_DATABASE_URL, "lpp_w4_delivery_loop");
  runMigrate(DATABASE_URL);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-plugin-delivery-loop-test-"));
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";

  const generalRow = await rawClient.query<{ id: string }>(
    `INSERT INTO libraries (name, media_kind, paths, content_class, created_at_ms, updated_at_ms) VALUES ('General Lib', 'movie', '{}', 'general', 1, 1) RETURNING id`,
  );
  generalLibraryId = generalRow.rows[0]!.id;
  const restrictedRow = await rawClient.query<{ id: string }>(
    `INSERT INTO libraries (name, media_kind, paths, content_class, created_at_ms, updated_at_ms) VALUES ('Restricted Lib', 'movie', '{}', 'restricted', 1, 1) RETURNING id`,
  );
  restrictedLibraryId = restrictedRow.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_BACKEND;
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let pluginCounter = 0;

function fixtureManifest(deliveryEndpoint: string, contentClass: "general" | "restricted", eventTypes: string[]) {
  return {
    name: "fixture-subscriber",
    version: "0.1.0",
    protocolVersion: LPP_PROTOCOL_VERSION,
    capabilities: [
      {
        type: "event-subscriber",
        eventTypes,
        delivery: { endpoint: deliveryEndpoint },
        contentClass,
      },
    ],
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    description: "fixture",
    publisher: "Loombre",
  };
}

async function createSubscriberPlugin(input: {
  contentClass?: "general" | "restricted";
  pseudonymizeActorIds?: boolean;
  endpointUrl: string; // full http://host:port
  secret: string;
  eventTypes: string[];
  /** H-2 fix wave test seam: an ADDITIONAL manifest capability entry
   *  (e.g. a metadata-provider) alongside the event-subscriber one — lets a
   *  test construct exactly the mixed-class manifest shape H-2 covers. */
  extraCapability?: Record<string, unknown>;
  /** H-2 fix wave test seam: the STORED plugins.content_class AGGREGATE
   *  column value, independent of the event-subscriber capability's own
   *  `contentClass` field above — defaults to `contentClass` (the ordinary,
   *  non-mixed case). Lets a test reproduce exactly what a real
   *  registerPlugin call would have persisted for a mixed manifest (the
   *  aggregate is 'restricted' the instant ANY granted capability is) while
   *  the capability's own field stays whatever the test wants to prove
   *  clearance reads instead.
   */
  aggregateContentClass?: "general" | "restricted";
  /** Granted capability types to store — defaults to just
   *  ['event-subscriber']; a mixed-class test grants both. */
  grantedCapabilityTypes?: string[];
}): Promise<string> {
  pluginCounter += 1;
  const contentClass = input.contentClass ?? "general";
  const aggregateContentClass = input.aggregateContentClass ?? contentClass;
  const url = new URL(input.endpointUrl);
  const deliveryPath = url.pathname === "/" ? LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT : url.pathname;
  const baseUrl = `${url.protocol}//${url.host}`;

  // Raw SQL (via the same rawClient every other fixture in this file
  // already uses for `events`) rather than Kysely's query builder — this
  // package has no direct dependency on `kysely` (dependency-cruiser
  // reserves raw pg/kysely imports to packages/db; apps/worker's own
  // production code only ever reaches Postgres through @loombre/db's
  // guarded functions, and this file mirrors that even for test fixture
  // setup, matching packages/db/test/plugins-delivery.spec.ts's own
  // `$1::jsonb`-parameterized insertEvent convention).
  const manifest = fixtureManifest(deliveryPath, contentClass, input.eventTypes);
  if (input.extraCapability) {
    manifest.capabilities = [...manifest.capabilities, input.extraCapability] as unknown as typeof manifest.capabilities;
  }
  const manifestJson = JSON.stringify(manifest);
  const pluginRow = await rawClient.query<{ id: string }>(
    `INSERT INTO plugins (
       name, base_url, version, protocol_version, enabled, content_class,
       granted_capability_types, lan_allowlist, manifest, pseudonymize_actor_ids,
       created_at_ms, updated_at_ms, approved_at_ms
     ) VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8::jsonb, $9, $10, $10, $10)
     RETURNING id`,
    [
      `test-plugin-${pluginCounter}`,
      baseUrl,
      "0.1.0",
      LPP_PROTOCOL_VERSION,
      aggregateContentClass,
      input.grantedCapabilityTypes ?? ["event-subscriber"],
      ["127.0.0.1"],
      manifestJson,
      input.pseudonymizeActorIds ?? true,
      1_700_000_000_000,
    ],
  );
  const pluginId = pluginRow.rows[0]!.id;

  for (const eventType of input.eventTypes) {
    await rawClient.query(`INSERT INTO plugin_event_grants (plugin_id, event_type, granted_at_ms) VALUES ($1, $2, $3)`, [pluginId, eventType, 1_700_000_000_000]);
  }

  const detected = await detectSecretBackend();
  await storeSecret(detected.backend, pluginHmacKeyPath(pluginId, testEnv()), input.secret);

  return pluginId;
}

async function loadEventSubscriberPlugin(pluginId: string) {
  const all = await listEventSubscriberPlugins(db);
  const found = all.find((p) => p.id === pluginId);
  if (!found) throw new Error(`fixture plugin ${pluginId} not found by listEventSubscriberPlugins`);
  return found;
}

async function insertEvent(type: string, tsMs: number, payload: Record<string, unknown> = {}): Promise<string> {
  // See packages/db/test/plugins-delivery.spec.ts's insertEvent doc
  // comment for why this small real sleep is needed for deterministic id
  // ordering (events.id is minted from the DB server's real clock).
  await new Promise((resolve) => setTimeout(resolve, 2));
  const row = await rawClient.query<{ id: string }>(
    `INSERT INTO events (type, ts_ms, actor_user_id, payload) VALUES ($1, $2, NULL, $3::jsonb) RETURNING id`,
    [type, tsMs, JSON.stringify(payload)],
  );
  return row.rows[0]!.id;
}

/**
 * Explicit-id variant for the retention-window/gap test ONLY: events.id's
 * DEFAULT (loombre_uuidv7()) always embeds the DATABASE SERVER's real
 * wall-clock time at insert time, never the caller-supplied `ts_ms`
 * column value — so there is no way to make a REAL event's id look
 * "7+ days old" without literally waiting 7 days. This helper supplies an
 * explicit id (via @loombre/shared's uuidv7(timestampMs), the same
 * generator migrations/0001_init.sql's loombre_uuidv7() implements)
 * embedding EXACTLY the timestamp the test wants, so the retention-window
 * boundary math (which compares against real id-embedded time — see
 * apps/worker/src/plugin-delivery/delivery-loop.ts's gap-semantics header)
 * is exercised deterministically and correctly, independent of real
 * wall-clock time. Every other test in this file anchors its `now()` to
 * genuine `Date.now()`-relative values instead and never needs this.
 */
async function insertEventWithId(id: string, type: string, tsMs: number, payload: Record<string, unknown> = {}): Promise<string> {
  await rawClient.query(`INSERT INTO events (id, type, ts_ms, actor_user_id, payload) VALUES ($1, $2, $3, NULL, $4::jsonb)`, [id, type, tsMs, JSON.stringify(payload)]);
  return id;
}

interface CapturedRequest {
  batch: LppEventBatch | null;
  signatureValid: boolean;
  rawBody: string;
}

interface Subscriber {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/** Verifies X-LPP-Signature INDEPENDENTLY of @loombre/plugin-protocol's
 *  own signLppBatch (never imports it) — a genuine cross-check that the
 *  header this loop actually sends is verifiable by a third party holding
 *  only the shared secret, exactly as a real subscriber plugin (the
 *  mission brief's examples/lpp-discord-notifier) would do. */
function verifySignatureIndependently(secret: string, header: string | undefined, rawBody: string): boolean {
  if (!header) return false;
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const [, t, providedDigest] = match;
  const expectedDigest = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return providedDigest === expectedDigest;
}

async function startSubscriber(
  secret: string,
  path_: string = LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT,
  respond: (req: IncomingMessage, res: ServerResponse, requestIndex: number) => void = (_req, res) => {
    res.writeHead(200);
    res.end();
  },
): Promise<Subscriber> {
  const requests: CapturedRequest[] = [];
  let requestIndex = 0;
  const server: Server = createServer((req, res) => {
    let rawBody = "";
    req.on("data", (chunk: Buffer) => {
      rawBody += chunk.toString("utf8");
    });
    req.on("end", () => {
      const signatureValid = verifySignatureIndependently(secret, req.headers["x-lpp-signature"] as string | undefined, rawBody);
      let batch: LppEventBatch | null = null;
      try {
        batch = JSON.parse(rawBody) as LppEventBatch;
      } catch {
        // leave batch === null — an unparseable body is captured as-is
        // via rawBody for the caller to inspect regardless.
      }
      requests.push({ batch, signatureValid, rawBody });
      respond(req, res, requestIndex);
      requestIndex += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path_}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const subscribersToClose: Subscriber[] = [];
afterEach(async () => {
  await Promise.all(subscribersToClose.splice(0).map((s) => s.close()));
});

function track(s: Subscriber): Subscriber {
  subscribersToClose.push(s);
  return s;
}

// ---------------------------------------------------------------------------
// 1. In-order delivery + batch cap
// ---------------------------------------------------------------------------

describe("in-order delivery and batch cap", () => {
  it("delivers up to LPP_DELIVERY_BATCH_MAX in the first tick, ascending order, and the remainder on the next tick", async () => {
    const secret = "batch-cap-secret";
    const subscriber = track(await startSubscriber(secret));
    // 'item.added' — NOT one of H-4's 8 ADMIN_ONLY types, so still
    // grantable, but IS item-gated (packages/db/src/query/events.ts's
    // GATED_TYPES) — the plugin below is RESTRICTED-scoped specifically so
    // clearance filtering is skipped entirely (pluginMayReceiveRestricted
    // -> unfiltered), letting this test use fake itemIds freely. This
    // exact-count/exact-order assertion below needs a type UNIQUE to this
    // test within this file's shared events table (a fresh plugin's cursor
    // starts at epoch zero and would otherwise pick up every prior test's
    // same-typed fixture events too) — 'user.created' is the file's ONLY
    // ungated+grantable type post-H-4 and is reserved for the
    // pseudonymization suite below, so this test (and the other
    // exact-count ones in this file) each use their OWN distinct gated
    // type instead, sidestepping clearance via restricted-scoping rather
    // than needing a real library/item row. ('job.updated' was used before
    // the H-4 fix wave excluded it from the grantable taxonomy entirely.)
    const pluginId = await createSubscriberPlugin({ endpointUrl: subscriber.url, secret, contentClass: "restricted", eventTypes: ["item.added"] });

    const total = 110;
    const base = Date.now();
    const insertedIds: string[] = [];
    for (let i = 0; i < total; i++) {
      // insertEvent's small real sleep between inserts (see its own doc
      // comment) is what makes the assertion below on exact id ORDER
      // deterministic — events.id embeds real DB-server time, not `base`.
      insertedIds.push(
        await insertEvent("item.added", base + i, {
          itemId: "018f6f1e-0000-7000-8000-00000000ba71",
          libraryId: "018f6f1e-0000-7000-8000-00000000ba71",
          itemType: "movie",
          contentClass: "restricted",
          parentId: null,
          addedAtMs: base + i,
        }),
      );
    }

    const now = () => Date.now();
    const plugin = await loadEventSubscriberPlugin(pluginId);
    const breaker = new PluginCircuitBreaker();

    const outcome1 = await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, plugin, breaker);
    expect(outcome1.kind).toBe("delivered");
    expect((outcome1 as { count: number }).count).toBe(100);

    const outcome2 = await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, plugin, breaker);
    expect(outcome2.kind).toBe("delivered");
    expect((outcome2 as { count: number }).count).toBe(10);

    expect(subscriber.requests).toHaveLength(2);
    const firstBatchIds = subscriber.requests[0]!.batch!.events.map((e) => e.id);
    const secondBatchIds = subscriber.requests[1]!.batch!.events.map((e) => e.id);
    expect(firstBatchIds).toEqual(insertedIds.slice(0, 100));
    expect(secondBatchIds).toEqual(insertedIds.slice(100));
    expect([...firstBatchIds].sort()).toEqual(firstBatchIds); // in-order within the batch
    expect(subscriber.requests.every((r) => r.signatureValid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Clearance gating (C5) leak-proof
// ---------------------------------------------------------------------------

describe("clearance gating (C5) — general subscriber never receives restricted-library events", () => {
  it("byte-absence for a general-scoped subscriber, presence for a restricted-scoped subscriber", async () => {
    const generalSecret = "general-scope-secret";
    const restrictedSecret = "restricted-scope-secret";
    const generalSub = track(await startSubscriber(generalSecret));
    const restrictedSub = track(await startSubscriber(restrictedSecret));
    const generalPluginId = await createSubscriberPlugin({ endpointUrl: generalSub.url, secret: generalSecret, contentClass: "general", eventTypes: ["scan.completed"], pseudonymizeActorIds: false });
    const restrictedPluginId = await createSubscriberPlugin({ endpointUrl: restrictedSub.url, secret: restrictedSecret, contentClass: "restricted", eventTypes: ["scan.completed"], pseudonymizeActorIds: false });

    const base = Date.now();
    await insertEvent("scan.completed", base, { libraryId: generalLibraryId, jobId: "job-general", full: true, itemsAdded: 1, itemsUpdated: 0, itemsRemoved: 0, durationMs: 1, status: "ok", completedAtMs: base });
    await insertEvent("scan.completed", base + 10, { libraryId: restrictedLibraryId, jobId: "job-restricted", full: true, itemsAdded: 1, itemsUpdated: 0, itemsRemoved: 0, durationMs: 1, status: "ok", completedAtMs: base + 10 });

    const now = () => Date.now();
    const generalPlugin = await loadEventSubscriberPlugin(generalPluginId);
    const restrictedPlugin = await loadEventSubscriberPlugin(restrictedPluginId);

    await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, generalPlugin, new PluginCircuitBreaker());
    await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, restrictedPlugin, new PluginCircuitBreaker());

    const generalReceivedRaw = generalSub.requests.map((r) => r.rawBody).join("\n");
    expect(generalReceivedRaw).not.toContain(restrictedLibraryId);
    expect(generalReceivedRaw).toContain(generalLibraryId);

    const restrictedReceivedRaw = restrictedSub.requests.map((r) => r.rawBody).join("\n");
    expect(restrictedReceivedRaw).toContain(generalLibraryId);
    expect(restrictedReceivedRaw).toContain(restrictedLibraryId);
  });

  // H-2 fix wave: a completely ordinary, non-hostile manifest — a
  // restricted-scoped metadata-provider capability alongside a
  // general-scoped event-subscriber capability wanting a general activity
  // feed. Before the fix, the delivery loop's clearance gate read the
  // PLUGIN's aggregate `plugins.content_class` (which is 'restricted' the
  // instant ANY granted capability is, per computeAggregateContentClass),
  // so this exact shape skipped filterEventsForViewer entirely and shipped
  // restricted-library events to a subscriber the admin was told would
  // "never receive activity involving restricted content." The fix reads
  // the event-subscriber CAPABILITY's own contentClass instead.
  it("H-2: a mixed-class plugin (restricted metadata-provider + general event-subscriber) still filters restricted events for its subscriber capability", async () => {
    const secret = "mixed-class-secret";
    const sub = track(await startSubscriber(secret));
    const mixedPluginId = await createSubscriberPlugin({
      endpointUrl: sub.url,
      secret,
      contentClass: "general", // the event-subscriber CAPABILITY's own class
      eventTypes: ["scan.completed"],
      pseudonymizeActorIds: false,
      grantedCapabilityTypes: ["metadata-provider", "event-subscriber"],
      // The STORED aggregate — exactly what a real registerPlugin call
      // would have computed for this manifest+grant combination, since the
      // metadata-provider capability is restricted-scoped.
      aggregateContentClass: "restricted",
      extraCapability: {
        type: "metadata-provider",
        mediaKinds: ["movie"],
        contentClass: "restricted",
        endpoints: { search: "/lpp/provider/search", details: "/lpp/provider/details", images: "/lpp/provider/images" },
      },
    });

    const base = Date.now();
    await insertEvent("scan.completed", base, { libraryId: generalLibraryId, jobId: "job-general", full: true, itemsAdded: 1, itemsUpdated: 0, itemsRemoved: 0, durationMs: 1, status: "ok", completedAtMs: base });
    await insertEvent("scan.completed", base + 10, { libraryId: restrictedLibraryId, jobId: "job-restricted", full: true, itemsAdded: 1, itemsUpdated: 0, itemsRemoved: 0, durationMs: 1, status: "ok", completedAtMs: base + 10 });

    const now = () => Date.now();
    const mixedPlugin = await loadEventSubscriberPlugin(mixedPluginId);
    expect(mixedPlugin.contentClass).toBe("restricted"); // sanity: the AGGREGATE really is widened

    await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, mixedPlugin, new PluginCircuitBreaker());

    const receivedRaw = sub.requests.map((r) => r.rawBody).join("\n");
    expect(receivedRaw).toContain(generalLibraryId);
    expect(receivedRaw).not.toContain(restrictedLibraryId);
  });
});

// ---------------------------------------------------------------------------
// M-1 fix wave: deliveries inject X-LPP-Config/X-LPP-Secret-* — the
// REFERENCE NOTIFIER, run as a real child process, actually forwards
// ---------------------------------------------------------------------------
//
// Before this fix, delivery-loop.ts sent ONLY content-type + X-LPP-Signature
// on every delivery — a break with the frozen W1 contract ("whenever the
// host calls a plugin, it resolves that plugin's current config values and
// injects them per request, via headers"). examples/lpp-discord-notifier
// reads its configured webhook URL from X-LPP-Secret-WEBHOOKURL; since that
// header never arrived, it silently took its no-forward branch on EVERY
// delivery — the conformance suite's own synthetic test batch (packages/
// plugin-protocol/test/integration.spec.ts) never caught this because IT
// builds its own signed batch with the right headers directly, bypassing
// the real host delivery loop entirely. This test drives the REAL
// deliverOnePluginTick against the REAL notifier binary and a REAL webhook
// receiver — the only way to actually prove production forwarding works.

interface SpawnedNotifier {
  child: ChildProcessByStdio<null, Readable, Readable>;
  baseUrl: string;
  stop: () => Promise<void>;
}

function spawnDiscordNotifier(signingSecret: string): Promise<SpawnedNotifier> {
  const scriptPath = path.join(REPO_ROOT, "examples", "lpp-discord-notifier", "server.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, PORT: "0", LOOMBRE_LPP_SIGNING_SECRET: signingSecret },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let settled = false;
    const stderrChunks: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const match = /LISTENING (\d+)/.exec(stdoutBuffer);
      if (match && !settled) {
        settled = true;
        resolve({
          child,
          baseUrl: `http://127.0.0.1:${match[1]}`,
          stop: () => new Promise<void>((res) => { child.once("exit", () => res()); child.kill(); }),
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    child.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
    child.on("exit", (code) => {
      if (!settled) { settled = true; reject(new Error(`lpp-discord-notifier exited before listening (code ${code}): ${stderrChunks.join("")}`)); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error(`lpp-discord-notifier did not print LISTENING within 5000ms: ${stderrChunks.join("")}`)); }
    }, 5000);
  });
}

interface FakeWebhook {
  baseUrl: string;
  received: Array<Record<string, unknown>>;
  stop: () => Promise<void>;
}

function startFakeWebhook(): Promise<FakeWebhook> {
  return new Promise((resolve) => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          received.push({});
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, received, stop: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}

describe("M-1 fix wave: event deliveries inject X-LPP-Config/X-LPP-Secret-* — the reference notifier forwards for real", () => {
  const notifiers: SpawnedNotifier[] = [];
  const webhooks: FakeWebhook[] = [];
  afterEach(async () => {
    await Promise.all(notifiers.splice(0).map((n) => n.stop()));
    await Promise.all(webhooks.splice(0).map((w) => w.stop()));
  });

  it("the REAL delivery loop, calling the REAL lpp-discord-notifier binary, results in the notifier forwarding to its configured webhook", async () => {
    const signingSecret = generateLppSigningSecret();
    const notifier = await spawnDiscordNotifier(signingSecret);
    notifiers.push(notifier);
    const webhook = await startFakeWebhook();
    webhooks.push(webhook);

    pluginCounter += 1;
    const notifierManifest = {
      name: "lpp-discord-notifier",
      version: "0.1.0",
      protocolVersion: LPP_PROTOCOL_VERSION,
      capabilities: [
        {
          type: "event-subscriber",
          // 'scan.started' — LIBRARY_ONLY_TYPES-gated (packages/db/src/
          // query/events.ts), which only needs a REAL library id to pass
          // clearance for this general-scoped subscriber (unlike an
          // ITEM_ONLY_TYPES type, which needs a real catalog_items row —
          // more fixture setup than this test needs; the notifier forwards
          // any event type verbatim, so which type is used here is
          // otherwise immaterial to what M-1 is proving). Deliberately
          // unused by any OTHER test in this file (unlike 'library.created'/
          // 'scan.completed') — a fresh plugin's cursor starts at epoch
          // zero and would otherwise pick up an earlier test's same-typed
          // fixture events too (see the batch-cap test's comment for the
          // full explanation of this file's shared-events-table
          // contamination hazard).
          eventTypes: ["scan.started"],
          delivery: { endpoint: LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT },
          contentClass: "general",
        },
      ],
      configSchema: {
        type: "object",
        properties: { webhookUrl: { type: "string", description: "Webhook URL", secret: true } },
        required: ["webhookUrl"],
        additionalProperties: false,
      },
      description: "Forwards Loombre outbox events to a configured webhook URL as formatted messages.",
      publisher: "Loombre",
    };
    const pluginRow = await rawClient.query<{ id: string }>(
      `INSERT INTO plugins (
         name, base_url, version, protocol_version, enabled, content_class,
         granted_capability_types, lan_allowlist, manifest, config, pseudonymize_actor_ids,
         created_at_ms, updated_at_ms, approved_at_ms
       ) VALUES ($1, $2, $3, $4, true, 'general', $5, $6, $7::jsonb, $8::jsonb, false, $9, $9, $9)
       RETURNING id`,
      [
        `test-notifier-${pluginCounter}`,
        notifier.baseUrl,
        "0.1.0",
        LPP_PROTOCOL_VERSION,
        ["event-subscriber"],
        ["127.0.0.1"],
        JSON.stringify(notifierManifest),
        JSON.stringify({}), // webhookUrl is secret — never in plugins.config
        1_700_000_000_000,
      ],
    );
    const pluginId = pluginRow.rows[0]!.id;
    await rawClient.query(`INSERT INTO plugin_event_grants (plugin_id, event_type, granted_at_ms) VALUES ($1, 'scan.started', $2)`, [pluginId, 1_700_000_000_000]);

    const detected = await detectSecretBackend();
    await storeSecret(detected.backend, pluginHmacKeyPath(pluginId, testEnv()), signingSecret);
    // The config SECRET (webhookUrl) — same keyring path convention
    // apps/server/src/plugins/plugin-keyring.ts's storePluginConfigSecret
    // writes to in production (plugin-<pluginId>-<fieldName>), which
    // apps/worker/src/metadata/plugin-keyring.ts's resolvePluginConfigSecrets
    // reads back (the SAME function delivery-loop.ts's M-1 fix now calls).
    await storeSecret(detected.backend, `${mirrorServerDataDir(testEnv())}/secrets/plugin-${pluginId}-webhookUrl`, webhook.baseUrl);

    await insertEvent("scan.started", Date.now(), {
      jobId: "018f6f1e-0000-7000-8000-0000000000m1",
      libraryId: generalLibraryId,
      full: true,
      startedAtMs: Date.now(),
    });

    const plugin = await loadEventSubscriberPlugin(pluginId);
    const outcome = await deliverOnePluginTick({ db, env: testEnv(), now: () => Date.now(), random: () => 1 }, plugin, new PluginCircuitBreaker());

    expect(outcome.kind).toBe("delivered");
    // The REAL notifier verified the REAL signature, decoded
    // X-LPP-Secret-WEBHOOKURL, and forwarded — proving the whole chain,
    // not just that delivery "succeeded" transport-wise.
    expect(webhook.received).toHaveLength(1);
    expect(String(webhook.received[0]?.content ?? "")).toContain("scan.started");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 3. Pseudonymization
// ---------------------------------------------------------------------------

describe("pseudonymization", () => {
  it("default-on: real user id is byte-absent, stable across batches; toggle-off: real id passes through; cross-plugin unlinkable", async () => {
    const secretOn = "pseudo-on-secret";
    const secretOff = "pseudo-off-secret";
    const secretOnOther = "pseudo-on-other-secret";
    const subOn = track(await startSubscriber(secretOn));
    const subOff = track(await startSubscriber(secretOff));
    const subOnOther = track(await startSubscriber(secretOnOther));

    const pluginOn = await createSubscriberPlugin({ endpointUrl: subOn.url, secret: secretOn, pseudonymizeActorIds: true, eventTypes: ["user.created"] });
    const pluginOff = await createSubscriberPlugin({ endpointUrl: subOff.url, secret: secretOff, pseudonymizeActorIds: false, eventTypes: ["user.created"] });
    const pluginOnOther = await createSubscriberPlugin({ endpointUrl: subOnOther.url, secret: secretOnOther, pseudonymizeActorIds: true, eventTypes: ["user.created"] });

    const realUserId = "d3adb33f-0000-7000-8000-000000000001";
    const base = Date.now();
    await insertEvent("user.created", base, { userId: realUserId, username: "alice", isAdmin: false, createdAtMs: base });
    await insertEvent("user.created", base + 10, { userId: realUserId, username: "alice-again", isAdmin: false, createdAtMs: base + 10 });

    const now = () => Date.now();
    const descOn = await loadEventSubscriberPlugin(pluginOn);
    const descOff = await loadEventSubscriberPlugin(pluginOff);
    const descOnOther = await loadEventSubscriberPlugin(pluginOnOther);

    await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, descOn, new PluginCircuitBreaker());
    await insertEvent("user.created", base + 20, { userId: realUserId, username: "alice-third", isAdmin: false, createdAtMs: base + 20 });
    await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, descOn, new PluginCircuitBreaker());

    await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, descOff, new PluginCircuitBreaker());
    await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 1 }, descOnOther, new PluginCircuitBreaker());

    const onRaw = subOn.requests.map((r) => r.rawBody).join("\n");
    expect(onRaw).not.toContain(realUserId);
    expect(subOn.requests.length).toBeGreaterThanOrEqual(2);
    const pseudonymsOn = subOn.requests.flatMap((r) => r.batch!.events.map((e) => (e.payload as { userId: string }).userId));
    expect(new Set(pseudonymsOn).size).toBe(1); // stability: identical pseudonym every time

    const offRaw = subOff.requests.map((r) => r.rawBody).join("\n");
    expect(offRaw).toContain(realUserId);

    const pseudonymOnOther = subOnOther.requests[0]!.batch!.events[0]!.payload as { userId: string };
    expect(pseudonymOnOther.userId).not.toBe(pseudonymsOn[0]); // cross-plugin unlinkability
  });
});

// ---------------------------------------------------------------------------
// 4. Breaker trip + per-plugin isolation
// ---------------------------------------------------------------------------

describe("breaker trip + per-plugin isolation", () => {
  it("a plugin whose endpoint is unreachable trips its breaker and gets disabled (real plugins.enabled/health_state/disabled_reason), while a healthy sibling plugin's deliveries continue unaffected", async () => {
    // Nothing listens here — every attempt is a genuine ECONNREFUSED ('network-error').
    const deadProbe = createServer();
    await new Promise<void>((resolve) => deadProbe.listen(0, "127.0.0.1", resolve));
    const { port: deadPort } = deadProbe.address() as AddressInfo;
    await new Promise<void>((resolve) => deadProbe.close(() => resolve()));
    const deadUrl = `http://127.0.0.1:${deadPort}${LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT}`;

    const healthySecret = "isolation-healthy-secret";
    const healthySub = track(await startSubscriber(healthySecret));

    const deadSecret = "isolation-dead-secret";
    // 'item.updated', restricted-scoped — see the batch-cap test's comment
    // above (H-4 fix wave excluded job.updated from the grantable
    // taxonomy; a distinct-per-test gated type + restricted-scoping
    // sidesteps both H-4 and cross-test event-table contamination).
    const deadPluginId = await createSubscriberPlugin({ endpointUrl: deadUrl, secret: deadSecret, contentClass: "restricted", eventTypes: ["item.updated"] });
    const healthyPluginId = await createSubscriberPlugin({ endpointUrl: healthySub.url, secret: healthySecret, contentClass: "restricted", eventTypes: ["item.updated"] });

    const base = Date.now();
    const deadBreaker = new PluginCircuitBreaker();
    const healthyBreaker = new PluginCircuitBreaker();

    let tick = 0;
    let deadOutcome: DeliveryTickOutcome | undefined;
    // LPP_BREAKER_FAILURE_THRESHOLD is 5 — one fresh event + one tick per
    // plugin, per round, so the breaker sees 5 consecutive network failures.
    // random:()=>0 pins this lane's OWN backoff (plugin_delivery_cursors.
    // consecutive_failures pacing, apps/worker/src/plugin-delivery/
    // backoff.ts) to zero wait — this test is proving BREAKER behavior,
    // not backoff pacing, and the two are deliberately independent
    // counters (see migrations/0016_plugin_delivery_cursors.sql's header).
    for (; tick < 6; tick++) {
      await insertEvent("item.updated", base + tick * 1000, { itemId: "018f6f1e-0000-7000-8000-0000000dead0", libraryId: restrictedLibraryId, itemType: "movie", contentClass: "restricted", changedFields: ["title"], updatedAtMs: base });
      await insertEvent("item.updated", base + tick * 1000 + 1, { itemId: "018f6f1e-0000-7000-8000-000000ea1700", libraryId: restrictedLibraryId, itemType: "movie", contentClass: "restricted", changedFields: ["title"], updatedAtMs: base });
      const now = () => Date.now();

      const deadPlugin = await loadEventSubscriberPlugin(deadPluginId);
      deadOutcome = await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 0 }, deadPlugin, deadBreaker);
      const healthyPlugin = await loadEventSubscriberPlugin(healthyPluginId);
      const healthyOutcome = await deliverOnePluginTick({ db, env: testEnv(), now, random: () => 0 }, healthyPlugin, healthyBreaker);
      expect(healthyOutcome.kind).toBe("delivered"); // isolation: unaffected by the dead plugin's failures

      if (deadOutcome.kind === "breaker-tripped") break;
    }

    expect(deadOutcome?.kind).toBe("breaker-tripped");
    const deadRow = await db.selectFrom("plugins").select(["enabled", "health_state", "disabled_reason"]).where("id", "=", deadPluginId).executeTakeFirstOrThrow();
    expect(deadRow.enabled).toBe(false);
    expect(deadRow.health_state).toBe("unhealthy");
    expect(deadRow.disabled_reason).toBe("breaker");

    // Per-plugin isolation, restated: the healthy plugin delivered on
    // EVERY tick above, unaffected by the dead plugin ever failing.
    expect(healthySub.requests.length).toBe(tick + 1);

    // The healthy plugin's own breaker/health state is untouched.
    const healthyRow = await db.selectFrom("plugins").select(["enabled", "health_state"]).where("id", "=", healthyPluginId).executeTakeFirstOrThrow();
    expect(healthyRow.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Retention window + gap report
// ---------------------------------------------------------------------------

describe("retention window + gap report", () => {
  it("a cursor older than the retention window jumps forward and the next shipped batch carries a gapReport", async () => {
    const secret = "gap-secret";
    const subscriber = track(await startSubscriber(secret));
    const pluginId = await createSubscriberPlugin({ endpointUrl: subscriber.url, secret, eventTypes: ["library.created"] });

    const nowMs = Date.now();
    const windowStartMs = nowMs - LPP_DELIVERY_RETENTION_WINDOW_MS;

    // Explicit id (see insertEventWithId's doc comment) — a REAL event
    // can never naturally have an id embedding a 7-days-ago timestamp
    // without literally waiting 7 days.
    const oldEventTs = windowStartMs - 5_000_000;
    await insertEventWithId(uuidv7(oldEventTs), "library.created", oldEventTs, { libraryId: generalLibraryId, name: "old", mediaKind: "movie", contentClass: "general", createdAtMs: oldEventTs });
    const freshEventTs = nowMs - 1000;
    await insertEvent("library.created", freshEventTs, { libraryId: generalLibraryId, name: "fresh", mediaKind: "movie", contentClass: "general", createdAtMs: freshEventTs });

    const plugin = await loadEventSubscriberPlugin(pluginId);
    const outcome = await deliverOnePluginTick({ db, env: testEnv(), now: () => nowMs, random: () => 1 }, plugin, new PluginCircuitBreaker());

    expect(outcome.kind).toBe("delivered");
    expect((outcome as { gapReported: boolean }).gapReported).toBe(true);
    expect(subscriber.requests).toHaveLength(1);
    const batch = subscriber.requests[0]!.batch!;
    expect(batch.gapReport).not.toBeNull();
    expect(batch.gapReport!.gaps).toHaveLength(1);
    expect(batch.gapReport!.gaps[0]!.toMs).toBe(windowStartMs);
    expect(batch.gapReport!.gaps[0]!.reason).toBe("retention-window-exceeded");
    expect(batch.events.map((e) => e.payload["name"])).toEqual(["fresh"]); // the OLD event never appears — skipped, not delivered

    const cursorRow = await db.selectFrom("plugin_delivery_cursors").selectAll().where("plugin_id", "=", pluginId).executeTakeFirstOrThrow();
    expect(cursorRow.gap_reported_through_ms).toBe(windowStartMs);
  });

  it("an idle-but-caught-up plugin (nothing skipped) never gets a false-positive gap report", async () => {
    const secret = "no-gap-secret";
    const subscriber = track(await startSubscriber(secret));
    const pluginId = await createSubscriberPlugin({ endpointUrl: subscriber.url, secret, eventTypes: ["restricted.locked"] }); // granted type with zero matching events ever inserted

    const nowMs = Date.now();
    const plugin = await loadEventSubscriberPlugin(pluginId);
    const outcome = await deliverOnePluginTick({ db, env: testEnv(), now: () => nowMs, random: () => 1 }, plugin, new PluginCircuitBreaker());
    expect(outcome.kind).toBe("skip-empty");
    expect(subscriber.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Kill/restart cursor-resume proof
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// H-4 fix wave, defense in depth: the delivery loop's OWN admin-only filter
// ---------------------------------------------------------------------------

describe("H-4 fix wave: the delivery loop never fans out an ADMIN_ONLY event type, even via a grant that bypassed the registration-time gate", () => {
  it("a plugin_event_grants row for 'job.updated' (simulating a stale pre-fix row, or a future bug upstream) is never delivered", async () => {
    const secret = "admin-only-defense-secret";
    const subscriber = track(await startSubscriber(secret));
    // createSubscriberPlugin inserts the plugin_event_grants row directly
    // via raw SQL (this test harness's own fixture convention) — it does
    // NOT go through apps/server's registration-time gate
    // (event-taxonomy.ts's ADMIN_ONLY exclusion), exactly reproducing the
    // "a grant existed some other way" scenario this defense-in-depth
    // layer exists for.
    const pluginId = await createSubscriberPlugin({ endpointUrl: subscriber.url, secret, eventTypes: ["job.updated"] });
    await insertEvent("job.updated", Date.now(), { jobId: "018f6f1e-0000-7000-8000-0000000000ad", jobType: "scan", status: "failed", progress: 0, errorMessage: "/media/restricted/secret-title/file.mkv: ENOENT", updatedAtMs: Date.now() });

    const plugin = await loadEventSubscriberPlugin(pluginId);
    const outcome = await deliverOnePluginTick({ db, env: testEnv(), now: () => Date.now(), random: () => 1 }, plugin, new PluginCircuitBreaker());

    // grantedTypes is filtered to [] before any candidate-event query runs
    // (LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES in constants.ts) — nothing to
    // deliver, never a network call to the subscriber at all.
    expect(outcome.kind).toBe("skip-empty");
    expect(subscriber.requests).toHaveLength(0);
  });
});

describe("kill/restart cursor-resume", () => {
  it("resumes from the persisted cursor after an abrupt stop, with no loss; a simulated crash between ack and persist yields a duplicate, never a loss", async () => {
    const secret = "resume-secret";
    const subscriber = track(await startSubscriber(secret));
    // Deliberately a DIFFERENT event type than every other test in this
    // file uses ('progress.updated', unused elsewhere here) — this test's
    // assertions are EXACT id-list matches: sharing a type with an earlier
    // test's fixture events (all in the SAME real events table, read from
    // this fresh plugin's epoch-zero cursor) would pull those in too,
    // which is realistic outbox behavior but would break the exact-match
    // assertions for reasons unrelated to what this test proves. Plugin is
    // RESTRICTED-scoped so clearance never runs (progress.updated is
    // ITEM_ONLY_TYPES-gated; its itemId fixtures don't correspond to any
    // real catalog_items row, which would clearance-filter it to empty for
    // a general-scoped plugin — a different, correct, but
    // irrelevant-to-this-test behavior). ('plugin.updated' was used before
    // the H-4 fix wave excluded it from the grantable taxonomy entirely.)
    const pluginId = await createSubscriberPlugin({ endpointUrl: subscriber.url, secret, contentClass: "restricted", eventTypes: ["progress.updated"] });

    const base = Date.now();
    const batch1Ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      batch1Ids.push(
        await insertEvent("progress.updated", base + i, {
          userId: "018f6f1e-0000-7000-8000-000000000ba1",
          itemId: `018f6f1e-0000-7000-8000-00000000000${i}`,
          positionMs: 1000,
          state: "in-progress",
          playCount: 0,
          updatedAtMs: base,
        }),
      );
    }

    // ---- "Instance A" delivers batch 1 for real. ----
    const nowA = () => Date.now();
    const pluginA = await loadEventSubscriberPlugin(pluginId);
    const outcomeA = await deliverOnePluginTick({ db, env: testEnv(), now: nowA, random: () => 1 }, pluginA, new PluginCircuitBreaker());
    expect(outcomeA.kind).toBe("delivered");
    expect(subscriber.requests).toHaveLength(1);
    expect(subscriber.requests[0]!.batch!.events.map((e) => e.id)).toEqual(batch1Ids);

    const cursorAfterA = await db.selectFrom("plugin_delivery_cursors").select("cursor_event_id").where("plugin_id", "=", pluginId).executeTakeFirstOrThrow();
    expect(cursorAfterA.cursor_event_id).toBe(batch1Ids[batch1Ids.length - 1]);

    // ---- Simulate a crash between "subscriber ack'd" and "cursor persisted":
    // revert the persisted cursor to its pre-batch-1 value directly (a
    // real crash never gets a chance to run this delivery attempt's DB
    // write at all — reverting it here reproduces the exact same
    // post-crash DB state without needing to interrupt the process
    // mid-function). "Instance A" is now abandoned (never called again). ----
    await db.updateTable("plugin_delivery_cursors").set({ cursor_event_id: null, delivered_batches: 0, delivered_events: 0 }).where("plugin_id", "=", pluginId).execute();

    // ---- "Instance B" (fresh breaker, simulating a worker restart)
    // redelivers batch 1 — a DUPLICATE, never silently dropped. ----
    const instanceBBreaker = new PluginCircuitBreaker();
    const pluginB1 = await loadEventSubscriberPlugin(pluginId);
    const outcomeB1 = await deliverOnePluginTick({ db, env: testEnv(), now: nowA, random: () => 1 }, pluginB1, instanceBBreaker);
    expect(outcomeB1.kind).toBe("delivered");
    expect(subscriber.requests).toHaveLength(2);
    expect(subscriber.requests[1]!.batch!.events.map((e) => e.id)).toEqual(batch1Ids); // exact duplicate of batch 1

    // ---- New events arrive AFTER the (correctly, for real this time)
    // persisted cursor. "Instance B" continues and must deliver them
    // exactly once, with NO loss and NO re-delivery of batch 1. ----
    const batch2Ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      batch2Ids.push(
        await insertEvent("progress.updated", base + 1000 + i, {
          userId: "018f6f1e-0000-7000-8000-000000000ba2",
          itemId: `018f6f1e-0000-7000-8000-00000000001${i}`,
          positionMs: 2000,
          state: "in-progress",
          playCount: 0,
          updatedAtMs: base,
        }),
      );
    }
    const nowB2 = () => Date.now();
    const pluginB2 = await loadEventSubscriberPlugin(pluginId);
    const outcomeB2 = await deliverOnePluginTick({ db, env: testEnv(), now: nowB2, random: () => 1 }, pluginB2, instanceBBreaker);
    expect(outcomeB2.kind).toBe("delivered");
    expect(subscriber.requests).toHaveLength(3);
    expect(subscriber.requests[2]!.batch!.events.map((e) => e.id)).toEqual(batch2Ids);

    // Full accounting: every event ever inserted was delivered at least
    // once (loss never); batch 1 appears exactly twice (the documented
    // at-least-once duplicate), batch 2 exactly once.
    const allDeliveredIds = subscriber.requests.flatMap((r) => r.batch!.events.map((e) => e.id));
    for (const id of [...batch1Ids, ...batch2Ids]) {
      expect(allDeliveredIds).toContain(id);
    }
  });

  it("startPluginDeliveryLoop's stop() waits for an in-flight tick before resolving (clean-shutdown proof)", async () => {
    const secret = "shutdown-secret";
    const subscriber = track(
      await startSubscriber(secret, LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT, (_req, res) => {
        setTimeout(() => {
          res.writeHead(200);
          res.end();
        }, 50);
      }),
    );
    // 'file.relocated', restricted-scoped — see the batch-cap test's
    // comment (H-4 fix wave + per-test type uniqueness).
    const pluginId = await createSubscriberPlugin({ endpointUrl: subscriber.url, secret, contentClass: "restricted", eventTypes: ["file.relocated"] });
    await insertEvent("file.relocated", Date.now(), {
      itemId: "018f6f1e-0000-7000-8000-00000005d0e5",
      mediaFileId: "018f6f1e-0000-7000-8000-00000005d0e6",
      previousPath: "/media/old.mkv",
      newPath: "/media/new.mkv",
      contentHash: "fixture-hash",
      relocatedAtMs: 1,
    });

    const handle = startPluginDeliveryLoop({ db, env: testEnv(), pollIntervalMs: 3_600_000 }); // never fires on its own during this test
    const runPromise = handle.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the tick actually start (mid-flight HTTP call)
    await handle.stop(); // must not resolve before the in-flight tick's DB write completes
    await runPromise;

    const cursorRow = await db.selectFrom("plugin_delivery_cursors").select("cursor_event_id").where("plugin_id", "=", pluginId).executeTakeFirstOrThrow();
    expect(cursorRow.cursor_event_id).not.toBeNull(); // the in-flight delivery was NOT interrupted
    expect(subscriber.requests).toHaveLength(1);
  });
});
