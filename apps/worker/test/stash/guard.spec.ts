// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/guard.spec.ts
//
// STATE.md S3, proven BOTH WAYS: every supported-version fixture connects
// + reads its schema_migrations row correctly; the unsupported fixture's
// version is recognized as outside the pinned range with the byte-exact
// notice format. This suite exercises guard.ts against the real fixture
// databases via the real adapter (test/stash/fixtures/*.sql, built by
// build-fixture-db.ts) — not just hand-constructed {version} objects — so
// a fixture DDL mistake in schema_migrations itself would also be caught
// here.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtureDb } from "./fixtures/build-fixture-db.js";
import { openStashConnection, type StashConnection } from "../../src/stash/adapter.js";
import {
  STASH_SUPPORTED_SCHEMA_MAX,
  STASH_SUPPORTED_SCHEMA_MIN,
  checkStashSchemaVersion,
  formatUnsupportedSchemaNotice,
  readSchemaVersion,
} from "../../src/stash/guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

let workDir: string;
const openConns: StashConnection[] = [];

afterAll(() => {
  for (const conn of openConns) conn.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function openFixture(sqlFileName: string): Promise<StashConnection> {
  if (!workDir) workDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-guard-"));
  const dbPath = path.join(workDir, `${sqlFileName}.sqlite`);
  const built = buildFixtureDb(path.join(FIXTURES_DIR, sqlFileName), dbPath);
  built.close();
  const conn = await openStashConnection({ path: dbPath });
  openConns.push(conn);
  return conn;
}

describe("checkStashSchemaVersion (pure)", () => {
  it("accepts the exact lower bound", () => {
    expect(checkStashSchemaVersion({ version: STASH_SUPPORTED_SCHEMA_MIN, dirty: false })).toEqual({
      supported: true,
      version: STASH_SUPPORTED_SCHEMA_MIN,
    });
  });

  it("accepts the exact upper bound", () => {
    expect(checkStashSchemaVersion({ version: STASH_SUPPORTED_SCHEMA_MAX, dirty: false })).toEqual({
      supported: true,
      version: STASH_SUPPORTED_SCHEMA_MAX,
    });
  });

  it("rejects one below the lower bound with the exact S3 notice format", () => {
    const result = checkStashSchemaVersion({ version: STASH_SUPPORTED_SCHEMA_MIN - 1, dirty: false });
    expect(result.supported).toBe(false);
    expect(result).toMatchObject({
      supported: false,
      version: STASH_SUPPORTED_SCHEMA_MIN - 1,
      notice: `Stash schema v${STASH_SUPPORTED_SCHEMA_MIN - 1} unsupported; supported: ${STASH_SUPPORTED_SCHEMA_MIN}-${STASH_SUPPORTED_SCHEMA_MAX}`,
    });
  });

  it("rejects one above the upper bound with the exact S3 notice format", () => {
    const result = checkStashSchemaVersion({ version: STASH_SUPPORTED_SCHEMA_MAX + 1, dirty: false });
    expect(result.supported).toBe(false);
    expect(result).toMatchObject({
      supported: false,
      version: STASH_SUPPORTED_SCHEMA_MAX + 1,
      notice: `Stash schema v${STASH_SUPPORTED_SCHEMA_MAX + 1} unsupported; supported: ${STASH_SUPPORTED_SCHEMA_MIN}-${STASH_SUPPORTED_SCHEMA_MAX}`,
    });
  });

  it("formatUnsupportedSchemaNotice matches the exact required wording", () => {
    expect(formatUnsupportedSchemaNotice(58)).toBe(`Stash schema v58 unsupported; supported: ${STASH_SUPPORTED_SCHEMA_MIN}-${STASH_SUPPORTED_SCHEMA_MAX}`);
  });
});

describe("S3 proven both ways against real fixture databases", () => {
  it("schema-v67-supported-min.sql connects and reads version 67 as supported (lower bound)", async () => {
    const conn = await openFixture("schema-v67-supported-min.sql");
    const schema = readSchemaVersion(conn.db);
    expect(schema).toEqual({ version: 67, dirty: false });
    expect(checkStashSchemaVersion(schema)).toEqual({ supported: true, version: 67 });
  });

  it("schema-v85-supported-max.sql connects and reads version 85 as supported (upper bound)", async () => {
    const conn = await openFixture("schema-v85-supported-max.sql");
    const schema = readSchemaVersion(conn.db);
    expect(schema).toEqual({ version: 85, dirty: false });
    expect(checkStashSchemaVersion(schema)).toEqual({ supported: true, version: 85 });
  });

  it("schema-v58-unsupported.sql connects but is rejected by the guard with the exact notice", async () => {
    const conn = await openFixture("schema-v58-unsupported.sql");
    const schema = readSchemaVersion(conn.db);
    expect(schema).toEqual({ version: 58, dirty: false });
    const result = checkStashSchemaVersion(schema);
    expect(result).toEqual({
      supported: false,
      version: 58,
      notice: `Stash schema v58 unsupported; supported: ${STASH_SUPPORTED_SCHEMA_MIN}-${STASH_SUPPORTED_SCHEMA_MAX}`,
    });
  });
});
