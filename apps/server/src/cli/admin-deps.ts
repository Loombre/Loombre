// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/admin-deps.ts
//
// Shared dep-bag types for the WHOLE `loombre admin <subcommand>` family
// (admin-reset-pin.ts's H2 pattern, and admin-reset-password.ts's E3a/M14
// twin) — extracted to its own module so admin-reset-pin.ts (the router,
// via runAdminCommand) can import admin-reset-password.ts WITHOUT the two
// files importing each other (dependency-cruiser's "no-circular" rule
// fails the build on any import cycle, no exceptions — see STATE.md
// "Optional mail transport + invitation & reset flows", M8's own note on
// this same constraint for a different pair of modules). Both subcommand
// files import the shared shape from HERE; admin-reset-pin.ts additionally
// re-exports everything below unchanged, so every EXISTING import site
// (admin-node-deps.ts, run-cli.ts, apps/server/test/cli/
// admin-reset-pin.e2e.spec.ts) keeps working without modification.
//
// `AdminDb`'s `typeof import("@loombre/db")` type-query syntax is erased
// at compile time and therefore never emits a runtime import statement —
// see admin-reset-pin.ts's header for why that matters (every CLI command
// except the two `admin` subcommands must stay free of loading kysely/pg
// at all).

export type AdminDb = Awaited<ReturnType<(typeof import("@loombre/db"))["createDb"]>>;

export interface AdminConnection {
  db: AdminDb;
  end(): Promise<void>;
}

export interface AdminDeps {
  /** Opens a fresh database connection for this one CLI invocation. Async
   *  because the real implementation dynamically imports @loombre/db to
   *  obtain `createDb` — see admin-reset-pin.ts's header. */
  connect(): Promise<AdminConnection> | AdminConnection;
  /** Asks `question` on stdin/stdout (or a fake, in tests) and resolves
   *  true only for an affirmative y/yes answer (case-insensitive) — see
   *  isAffirmative below for the exact accept rule. There is NO --yes flag
   *  anywhere in this CLI: the interactive confirmation IS the privilege
   *  boundary (owner brief), not an optional courtesy. */
  confirm(question: string): Promise<boolean>;
  nowMs(): number;
}

export interface AdminCliResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

/** True for a case-insensitive "y"/"yes" — exported so the real
 *  (readline-backed) confirm() implementation (admin-node-deps.ts) shares
 *  the exact same accept rule both subcommands' tests exercise. */
export function isAffirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}
