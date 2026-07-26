// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/db.provider.ts
//
// The one place apps/server obtains a @loombre/db handle. Deliberately typed
// via `ReturnType<typeof createDb>` rather than `import type { Kysely } from
// "kysely"` — the latter would be a real (if type-only) import of the
// `kysely` package, which dependency-cruiser's "no-raw-db-driver-outside-
// packages-db" rule forbids outside packages/db (tsPreCompilationDeps: true
// tracks type-only imports too). This keeps the raw driver import
// exclusively inside packages/db while still giving this file a precise
// type for the connection it holds.
//
// DATABASE_URL default mirrors packages/db/scripts/migrate.mjs and
// packages/db/seed/seed.mjs (docker-compose.dev.yml's host port, D18).

import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createDb } from "@loombre/db";

export type LoombreDb = ReturnType<typeof createDb>;

const DEFAULT_DATABASE_URL = "postgres://loombre:loombre@localhost:5442/loombre";

@Injectable()
export class DbProvider implements OnModuleDestroy {
  readonly db: LoombreDb;

  constructor() {
    const connectionString = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
    this.db = createDb(connectionString);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
