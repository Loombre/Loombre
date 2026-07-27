// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/migrate.ts
//
// Programmatic migration runner — the RUNTIME twin of scripts/migrate.mjs
// (KEEP THE APPLY SEMANTICS IN SYNC; the shared contract is: plain SQL
// files from migrations/ in filename order, one transaction per file,
// bookkeeping in schema_migrations keyed by filename). This module exists
// because installed embedded-mode deployments (the installer channels)
// have no repo checkout and no pnpm: apps/server's bootstrap calls
// runPendingMigrations() right after provisioning the embedded cluster it
// exclusively owns. Forward-only migrations (docs/PLAN.md, H4) are what
// make boot-time auto-migration safe there. External-mode deployments
// keep the operator-run path (this function is NOT called for them —
// an operator's database is not ours to alter unprompted).
//
// migrations/ ships with the package ("files" in package.json) and is
// resolved relative to this compiled file: dist/migrate.js -> ../migrations.

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export interface RunPendingMigrationsOptions {
  log?: (message: string) => void;
}

export interface MigrationRunResult {
  appliedCount: number;
  totalCount: number;
}

export function isMigrationFile(name: string): boolean {
  // Dotfiles excluded: macOS tar writes AppleDouble "._*.sql" metadata
  // entries into archives (a locally-built tarball fed one to PG as
  // binary garbage — "invalid message format", linux smoke round 9).
  // KEEP IN SYNC with scripts/migrate.mjs's listMigrationFiles.
  return name.endsWith(".sql") && !name.startsWith(".");
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter(isMigrationFile).sort();
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function ensureBookkeepingTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename      TEXT PRIMARY KEY,
      checksum      TEXT NOT NULL,
      applied_at_ms BIGINT NOT NULL
    );
  `);
}

async function applyMigrationFile(client: pg.Client, filename: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await ensureBookkeepingTable(client);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, applied_at_ms)
       VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO NOTHING`,
      [filename, sha256(sql), Date.now()],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`migration ${filename} failed: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

/** Applies every migration not yet recorded in schema_migrations. */
export async function runPendingMigrations(
  databaseUrl: string,
  options: RunPendingMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const log = options.log ?? (() => {});
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureBookkeepingTable(client);
    const { rows } = await client.query("SELECT filename FROM schema_migrations ORDER BY filename");
    const applied = new Set(rows.map((r: { filename: string }) => r.filename));
    const files = listMigrationFiles();
    let appliedCount = 0;
    for (const filename of files) {
      if (applied.has(filename)) {
        continue;
      }
      log(`migrate: applying ${filename}`);
      await applyMigrationFile(client, filename);
      appliedCount += 1;
    }
    log(`migrate: ${appliedCount} applied, ${files.length} total`);
    return { appliedCount, totalCount: files.length };
  } finally {
    await client.end();
  }
}
