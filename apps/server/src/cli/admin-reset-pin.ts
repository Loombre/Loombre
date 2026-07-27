// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/admin-reset-pin.ts
//
// `loombre admin reset-pin <username>` (H2, owner brief) — the server-local
// PIN-reset recovery path: clears a user's restricted_pin_hash +
// restricted_opt_in (+ any live unlock) so their next opt-in flow starts
// fresh with a brand-new 4-digit PIN (P4.22 contract, users-me.controller.ts's
// first-time-opt-in branch). Filesystem access to the running server IS the
// privilege boundary here — there is deliberately NO HTTP surface for this
// (see restricted.controller.ts / users-me.controller.ts's own headers).
//
// `@loombre/db` is DYNAMICALLY imported — `await import("@loombre/db")`,
// below — ONLY when this module's logic actually runs (i.e. only once the
// CLI dispatcher has already committed to the `admin` branch). This keeps
// every other command (--help/--version/paths/doctor) free of loading
// kysely/pg at all (run-cli.ts's own header/B-1 adjudication), and keeps
// this file's OWN top-level imports free of a static `@loombre/db` import
// too — the `AdminDb` type below uses TypeScript's `typeof import(...)`
// type-query syntax, which is erased at compile time and therefore never
// emits a runtime import statement, regardless of the dynamic import()
// expression elsewhere in this file.
//
// Dep-bag seam (house doctorDeps pattern, doctor.ts): AdminDeps.connect()
// is how the real implementation (admin-node-deps.ts) hands this pure
// logic a live database handle without this file importing @loombre/db
// eagerly itself; AdminDeps.confirm() is the ONLY interactive-stdin
// primitive in this repo (there is no other precedent — the real
// implementation uses node:readline/promises).

export type AdminDb = Awaited<ReturnType<(typeof import("@loombre/db"))["createDb"]>>;

export interface AdminConnection {
  db: AdminDb;
  end(): Promise<void>;
}

export interface AdminDeps {
  /** Opens a fresh database connection for this one CLI invocation. Async
   *  because the real implementation dynamically imports @loombre/db to
   *  obtain `createDb` — see this file's header. */
  connect(): Promise<AdminConnection> | AdminConnection;
  /** Asks `question` on stdin/stdout (or a fake, in tests) and resolves
   *  true only for an affirmative y/yes answer (case-insensitive) — see
   *  runAdminResetPin below for the exact accept rule. There is NO --yes
   *  flag anywhere in this CLI: the interactive confirmation IS the
   *  privilege boundary (owner brief), not an optional courtesy. */
  confirm(question: string): Promise<boolean>;
  nowMs(): number;
}

export interface AdminCliResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

const USAGE = "loombre admin reset-pin <username>";

function isAffirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/**
 * Dispatches `loombre admin <rest...>`. Only `reset-pin <username>` exists
 * today — any other shape (missing subcommand, unknown subcommand, missing
 * or extra arguments) is a usage error that NEVER touches `deps` (proven by
 * apps/server/test/cli/run-cli.spec.ts's THROWING_ADMIN_DEPS fixture).
 */
export async function runAdminCommand(rest: string[], deps: AdminDeps): Promise<AdminCliResult> {
  const [subcommand, username, ...extra] = rest;

  if (subcommand === undefined) {
    return { exitCode: 1, stdout: [], stderr: [`loombre: missing admin subcommand.`, `Usage: ${USAGE}`] };
  }
  if (subcommand !== "reset-pin") {
    return { exitCode: 1, stdout: [], stderr: [`loombre: unknown admin subcommand "${subcommand}"`, `Usage: ${USAGE}`] };
  }
  if (!username || extra.length > 0) {
    return { exitCode: 1, stdout: [], stderr: [`loombre: usage: ${USAGE}`] };
  }

  return runAdminResetPin(username, deps);
}

/**
 * B-3/B-5 (owner brief): the actual reset. Unknown user -> clean one-line
 * error naming the username, exit 1, no stack (getUserByUsername returning
 * undefined is an ordinary, expected outcome — never thrown). A declined
 * confirmation aborts with NOTHING changed and NO event emitted — the
 * database is never even asked to reset anything until the operator has
 * explicitly confirmed, by name, what is about to be cleared.
 */
export async function runAdminResetPin(username: string, deps: AdminDeps): Promise<AdminCliResult> {
  const { getUserByUsername, resetRestrictedPinAndEmit } = await import("@loombre/db");
  const connection = await deps.connect();
  const { db, end } = connection;
  try {
    const user = await getUserByUsername(db, username);
    if (!user) {
      return { exitCode: 1, stdout: [], stderr: [`loombre: no such user "${username}"`] };
    }

    const confirmed = await deps.confirm(
      `Reset the restricted-content PIN for "${username}"? This clears their PIN, turns off their ` +
        `restricted-content opt-in, and ends any active unlock — they will set a brand-new PIN the next ` +
        `time they opt in. [y/N] `,
    );
    if (!confirmed) {
      return { exitCode: 1, stdout: [], stderr: ["aborted, nothing changed"] };
    }

    const result = await resetRestrictedPinAndEmit(db, { userId: user.id, username: user.username, nowMs: deps.nowMs() });

    if (!result.cleared) {
      return {
        exitCode: 0,
        stdout: [`"${username}" has no restricted-content settings to clear (never opted in). Nothing changed.`],
        stderr: [],
      };
    }

    return {
      exitCode: 0,
      stdout: [
        `Cleared the restricted-content PIN and opt-in for "${username}".`,
        `Their next opt-in will require a brand-new 4-digit PIN.`,
      ],
      stderr: [],
    };
  } finally {
    await end();
  }
}

/** True for a case-insensitive "y"/"yes" — exported so the real
 *  (readline-backed) confirm() implementation shares the exact same accept
 *  rule this module's tests exercise. */
export { isAffirmative };
