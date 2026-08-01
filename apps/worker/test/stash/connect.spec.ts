// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/connect.spec.ts
//
// Live-DB integration test for apps/worker/src/stash/connect.ts — the S3
// "both ways" proof at the FULL connection-lifecycle level (guard.spec.ts
// already proves the guard logic itself against fixtures; this proves the
// event write + library_stash_connections status bookkeeping that wraps
// it): a supported fixture connects and records status='ok'; the
// unsupported fixture disables with the byte-exact S3 notice AND writes
// an admin-only `stash.provider.disabled` event whose payload matches
// guard.ts's own notice string exactly.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createDb, getLibraryStashConnection, upsertLibraryStashConnectionConfig } from "@loombre/db";
import { ADMIN_ONLY_EVENT_TYPES } from "@loombre/shared/admin-only-event-types";
import { buildFixtureDb } from "./fixtures/build-fixture-db.js";
import { connectToStashLibrary } from "../../src/stash/connect.js";
import { STASH_SUPPORTED_SCHEMA_MAX, STASH_SUPPORTED_SCHEMA_MIN, formatUnsupportedSchemaNotice } from "../../src/stash/guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DB_ROOT = path.resolve(__dirname, "../../../../packages/db");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_DB_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: ReturnType<typeof createDb>;
let workDir: string;

beforeAll(async () => {
  run(path.join(PKG_DB_ROOT, "scripts", "migrate.mjs"), ["reset"]);
  db = createDb(DATABASE_URL);
  workDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-connect-"));
});

afterAll(async () => {
  await db?.destroy();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function makeLibrary(): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto("libraries")
    .values({ name: `lib-${randomUUID()}`, media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

function materializeFixture(sqlFileName: string): string {
  const dbPath = path.join(workDir, `${sqlFileName}-${randomUUID()}.sqlite`);
  const built = buildFixtureDb(path.join(FIXTURES_DIR, sqlFileName), dbPath);
  built.close();
  return dbPath;
}

async function latestEventForLibrary(libraryId: string, type: string): Promise<Record<string, unknown> | undefined> {
  const row = await db
    .selectFrom("events")
    .selectAll()
    .where("type", "=", type)
    .orderBy("ts_ms", "desc")
    .executeTakeFirst();
  if (!row) return undefined;
  const payload = row.payload as Record<string, unknown>;
  if (payload.libraryId !== libraryId) return undefined;
  return payload;
}

describe("connectToStashLibrary — S3 proven both ways at the connection-lifecycle level", () => {
  it("a supported fixture connects: status 'ok', records the outcome, and hands back a working connection", async () => {
    const libraryId = await makeLibrary();
    const sqlitePath = materializeFixture("schema-v85-supported-max.sql");
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath, nowMs: Date.now() });

    const outcome = await connectToStashLibrary({ db }, libraryId);
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.schemaVersion).toBe(85);
      const rows = outcome.connection.db.prepare("SELECT COUNT(*) as n FROM scenes").get() as { n: number };
      expect(rows.n).toBe(2);
      outcome.connection.close();
    }

    const row = await getLibraryStashConnection(db, libraryId);
    expect(row).toMatchObject({ status: "ok", last_seen_schema_version: 85 });
    expect(row?.last_connected_at_ms).not.toBeNull();
  });

  it("the unsupported fixture disables with the exact S3 notice AND writes an admin-only stash.provider.disabled event", async () => {
    const libraryId = await makeLibrary();
    const sqlitePath = materializeFixture("schema-v58-unsupported.sql");
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath, nowMs: Date.now() });

    const outcome = await connectToStashLibrary({ db }, libraryId);
    const expectedNotice = formatUnsupportedSchemaNotice(58);
    expect(outcome).toEqual({ status: "unsupported_schema", notice: expectedNotice, seenVersion: 58 });

    const row = await getLibraryStashConnection(db, libraryId);
    expect(row).toMatchObject({ status: "unsupported_schema", last_seen_schema_version: 58, status_detail: expectedNotice });

    const eventPayload = await latestEventForLibrary(libraryId, "stash.provider.disabled");
    expect(eventPayload).toEqual({
      libraryId,
      seenVersion: 58,
      supportedMin: STASH_SUPPORTED_SCHEMA_MIN,
      supportedMax: STASH_SUPPORTED_SCHEMA_MAX,
      notice: expectedNotice,
    });

    expect(ADMIN_ONLY_EVENT_TYPES).toContain("stash.provider.disabled");
  });

  it("a nonexistent sqlite_path yields status 'unreachable' and never writes a disabled event", async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: path.join(workDir, "does-not-exist.sqlite"), nowMs: Date.now() });

    const outcome = await connectToStashLibrary({ db }, libraryId);
    expect(outcome.status).toBe("unreachable");

    const row = await getLibraryStashConnection(db, libraryId);
    expect(row?.status).toBe("unreachable");
    expect(await latestEventForLibrary(libraryId, "stash.provider.disabled")).toBeUndefined();
  });

  it("a library with no configured connection at all yields 'unreachable' without throwing", async () => {
    const libraryId = await makeLibrary();
    const outcome = await connectToStashLibrary({ db }, libraryId);
    expect(outcome.status).toBe("unreachable");
  });

  it("a library whose connection is admin-disabled yields 'unreachable' without ever opening the sqlite file", async () => {
    const libraryId = await makeLibrary();
    const sqlitePath = materializeFixture("schema-v85-supported-max.sql");
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath, enabled: false, nowMs: Date.now() });

    const outcome = await connectToStashLibrary({ db }, libraryId);
    expect(outcome.status).toBe("unreachable");
    // enabled:false is a config write, not an outcome — status stays
    // never_connected (recordStashConnectionOutcome is never called for
    // a disabled connection, matching the "config-only write leaves
    // status alone" contract stash-connections.spec.ts already proves).
    const row = await getLibraryStashConnection(db, libraryId);
    expect(row?.status).toBe("never_connected");
  });
});
