// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/helpers.ts
//
// Shared live-DB test scaffolding for the scanner exit-gate suites
// (rename-relocate, mount-drop, resume, idempotency) and the identity/
// music-tag-first unit suites. Mirrors packages/db/test/*.spec.ts's
// self-sufficient convention (each spec file resets the schema itself);
// apps/worker/vitest.config.ts forces sequential file execution for the
// same reason packages/db/vitest.config.ts does.
//
// `pg` is imported directly here for raw row/event assertions — test/ is
// excluded from the repo-root dependency-cruiser pg/kysely ban (see
// .dependency-cruiser.cjs's `exclude` option), the same carve-out
// packages/db/test/*.spec.ts already relies on.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDb, ensureTestDatabase, resolveTestDatabaseUrl } from "@loombre/db";
import type { QueueLike } from "../../src/scan/scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");

// PER-SUITE DATABASE (Wave A / A1's recommendation, swept at pre-D
// consolidation). This suite RESETS the schema in its own hook; on the
// shared `<base>_test` database a sibling package's reset landing mid-run
// wipes it out from under whatever is executing and presents as a product
// bug. `ensureTestDatabase` gives it one of its own — resolved at module
// load (top-level await) so every describe-scope handle below is built
// against the right connection string.
export const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), "worker_scan_test");

export function resetSchema(): void {
  const result = spawnSync(process.execPath, [path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), "reset"], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`migrate.mjs reset failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

export function makeDb(): ReturnType<typeof createDb> {
  return createDb(DATABASE_URL);
}

export function makeRawClient(): pg.Client {
  return new pg.Client({ connectionString: DATABASE_URL });
}

export interface CreateLibraryInput {
  name: string;
  mediaKind: "movie" | "tv" | "music";
  paths: string[];
}

export async function createLibrary(raw: pg.Client, input: CreateLibraryInput): Promise<string> {
  const now = Date.now();
  const result = await raw.query<{ id: string }>(
    `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
     VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [input.name, input.mediaKind, input.paths, now]
  );
  return result.rows[0]!.id;
}

/** In-memory QueueLike — captures every enqueue() call instead of touching
 * a real pg-boss/jobs-ledger queue, so these tests exercise runScan's own
 * logic without pg-boss's async worker-registration timing. */
export interface MemoryQueue {
  queue: QueueLike;
  calls: Array<{ type: "probe" | "image" | "metadata"; payload: Record<string, unknown> }>;
}

export function makeMemoryQueue(): MemoryQueue {
  const calls: MemoryQueue["calls"] = [];
  const queue: QueueLike = {
    async enqueue(type: "probe" | "image" | "metadata", payload: Record<string, unknown>) {
      calls.push({ type, payload });
      return `fake-job-${calls.length}`;
    },
  } as QueueLike;
  return { queue, calls };
}

/** A tmp directory per test file/case, auto-namespaced so parallel test
 * runs (across different vitest processes/CI jobs) never collide. */
export function makeTmpLibraryDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `loombre-${prefix}-`));
  return dir;
}

/** Writes a small deterministic "fake media" file: valid extension, plain
 * bytes (hashing/identity doesn't require valid media — real ffmpeg-backed
 * fixtures are reserved for the probe consumer's own integration test).
 * `seed` differentiates content across files so distinct fake movies/
 * episodes/tracks hash differently; `sizeBytes` pads/repeats the seed out
 * to an exact size so tests can exercise the <8MiB / >=8MiB hash branches
 * deliberately when needed. */
export function writeFakeMediaFile(absPath: string, seed: string, sizeBytes = 256): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const seedBuf = Buffer.from(seed, "utf8");
  const out = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    out[i] = seedBuf[i % seedBuf.length]!;
  }
  writeFileSync(absPath, out);
}
