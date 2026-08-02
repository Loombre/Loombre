// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/admin-reset-password.ts
//
// `loombre admin reset-password <username>` (E3a/M14, STATE.md "Optional
// mail transport + invitation & reset flows") — the H2 pattern applied to
// passwords: server-local, interactively confirmed, no --yes flag (the
// confirmation IS the privilege boundary, not an optional courtesy — same
// as admin-reset-pin.ts's own reset-pin). Generates a random temporary
// password, argon2id-hashes it, stores the hash, sets
// users.must_change_password, revokes EVERY refresh token the user holds,
// and emits `user.password-reset` (actor: 'cli', actorUserId: null — the
// CLI runs outside any authenticated session, same posture as
// resetRestrictedPinAndEmit). The temporary password is printed to stdout
// EXACTLY ONCE and never stored in plaintext anywhere, never logged again,
// never placed in the event payload.
//
// `@loombre/db` is DYNAMICALLY imported for the SAME reason
// admin-reset-pin.ts's own header explains: every command except the two
// `admin` subcommands must stay free of loading kysely/pg at all.
// `@loombre/shared` (generateTemporaryPassword) and `hash-wasm` (argon2id)
// are BOTH plain, eager, top-level imports — neither drags in a database
// driver, so neither needs to wait for the `admin` branch to commit the
// way `@loombre/db` does.
//
// argon2id cost parameters are a DELIBERATE, independently-maintained copy
// of apps/server/src/common/hash.service.ts's own constants (that file's
// own header documents the same "independently parameterized argon2id
// call site" posture against packages/db/seed/seed.mjs's offline-generated
// hashes) — this CLI has no Nest DI container to inject HashService from,
// and duplicating five primitive numbers is simpler and more auditable
// than inventing a cross-cutting non-DI hashing module for one caller.

import { randomBytes } from "node:crypto";
import { argon2id } from "hash-wasm";
import { generateTemporaryPassword } from "@loombre/shared";
import type { AdminCliResult, AdminDeps } from "./admin-deps.js";

// Mirrors apps/server/src/common/hash.service.ts's ARGON2ID_* constants
// exactly — see this file's header.
const ARGON2ID_ITERATIONS = 2;
const ARGON2ID_PARALLELISM = 1;
const ARGON2ID_MEMORY_KIB = 19_456;
const ARGON2ID_HASH_LENGTH = 32;
const ARGON2ID_SALT_LENGTH = 16;

async function hashTemporaryPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(ARGON2ID_SALT_LENGTH);
  return argon2id({
    password: plaintext,
    salt,
    iterations: ARGON2ID_ITERATIONS,
    parallelism: ARGON2ID_PARALLELISM,
    memorySize: ARGON2ID_MEMORY_KIB,
    hashLength: ARGON2ID_HASH_LENGTH,
    outputType: "encoded",
  });
}

const USAGE = "loombre admin reset-password <username>";

// Mirrors admin-reset-pin.ts's own RESET_PIN_HELP shape/rationale exactly
// (L2, owner brief — a --help branch that works standalone, no reachable
// Postgres required).
const RESET_PASSWORD_HELP: string[] = [
  USAGE,
  "",
  "Set a random temporary password for a user (recovery for a forgotten",
  "password), shown ONCE. The user must change it on next login and every",
  "existing session for that account is signed out immediately.",
  "Interactive confirmation required (type y/yes) — there is no --yes flag;",
  "the confirmation prompt IS the privilege boundary. Needs DATABASE_URL / a",
  "reachable Postgres; every other `loombre` command does not.",
];

/**
 * Parses `admin reset-password <rest...>` (rest here is EVERYTHING after
 * the `reset-password` subcommand token itself — admin-reset-pin.ts's
 * runAdminCommand already stripped that off before calling this). Mirrors
 * runAdminCommand's own reset-pin argument-parsing branches exactly:
 * `--help`/`-h` succeeds without ever reaching `deps`; a missing username
 * or extra arguments is a usage error that also never reaches `deps`
 * (apps/server/test/cli/run-cli.spec.ts's THROWING_ADMIN_DEPS fixture
 * proves this for reset-pin — the reset-password e2e suite proves the
 * same for this subcommand).
 */
export async function runAdminResetPasswordCommand(
  username: string | undefined,
  extra: string[],
  deps: AdminDeps,
): Promise<AdminCliResult> {
  if (username === "--help" || username === "-h") {
    return { exitCode: 0, stdout: [...RESET_PASSWORD_HELP], stderr: [] };
  }
  if (!username || extra.length > 0) {
    return { exitCode: 1, stdout: [], stderr: [`loombre: usage: ${USAGE}`] };
  }

  return runAdminResetPassword(username, deps);
}

/**
 * The actual reset. Unknown user -> clean one-line error naming the
 * username, exit 1, no stack (same posture as admin-reset-pin.ts's
 * runAdminResetPin — getUserByUsername returning undefined is an
 * ordinary, expected outcome, never thrown). A declined confirmation
 * aborts with NOTHING changed, no temporary password generated, and no
 * event emitted.
 */
export async function runAdminResetPassword(username: string, deps: AdminDeps): Promise<AdminCliResult> {
  const { getUserByUsername, resetUserPasswordAndEmit } = await import("@loombre/db");
  const connection = await deps.connect();
  const { db, end } = connection;
  try {
    const user = await getUserByUsername(db, username);
    if (!user) {
      return { exitCode: 1, stdout: [], stderr: [`loombre: no such user "${username}"`] };
    }

    const confirmed = await deps.confirm(
      `Reset the password for "${username}"? This sets a new temporary password (shown once), ` +
        `forces them to change it on next login, and signs them out of every device. [y/N] `,
    );
    if (!confirmed) {
      return { exitCode: 1, stdout: [], stderr: ["aborted, nothing changed"] };
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashTemporaryPassword(temporaryPassword);

    await resetUserPasswordAndEmit(db, {
      userId: user.id,
      username: user.username,
      passwordHash,
      actor: "cli",
      actorUserId: null,
      nowMs: deps.nowMs(),
    });

    return {
      exitCode: 0,
      stdout: [
        `Temporary password for "${username}" (shown once — write it down now):`,
        temporaryPassword,
        `They must change it on next login; every existing session for this account has been signed out.`,
      ],
      stderr: [],
    };
  } finally {
    await end();
  }
}
