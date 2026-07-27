// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/admin-node-deps.ts
//
// The real (non-fake) AdminDeps implementation — mirrors doctor-node-deps.ts:
// the only file under apps/server/src/cli that touches a real database
// connection or real stdin/stdout for the `admin` command family. Kept
// separate from admin-reset-pin.ts so that module's logic stays a pure
// function of injected dependencies (apps/server/test/cli/run-cli.spec.ts,
// admin-reset-pin.e2e.spec.ts fake this entirely); this file is exercised
// indirectly by the CLI e2e test instead (real DATABASE_URL, real
// confirm()-shaped answers piped to a spawned readline interface would be
// its own integration concern — out of scope here, same posture doctor-
// node-deps.ts documents for itself).
//
// node:readline/promises is the ONLY interactive-stdin primitive anywhere
// in this repo (grep-verified at H2 recon time) — there is no other
// precedent to follow or diverge from.

import { createInterface } from "node:readline/promises";
import type { AdminConnection, AdminDeps } from "./admin-reset-pin.js";
import { isAffirmative } from "./admin-reset-pin.js";

const DEFAULT_DATABASE_URL = "postgres://loombre:loombre@localhost:5442/loombre";

async function connect(): Promise<AdminConnection> {
  // Dynamically imported here too (not just in admin-reset-pin.ts) so that
  // NEITHER file forces @loombre/db (and therefore kysely/pg) to resolve
  // merely by being imported — only actually calling connect() does.
  const { createDb } = await import("@loombre/db");
  const connectionString = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
  const db = createDb(connectionString);
  return { db, end: () => db.destroy() };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return isAffirmative(answer);
  } finally {
    rl.close();
  }
}

export const REAL_ADMIN_DEPS: AdminDeps = { connect, confirm, nowMs: () => Date.now() };
