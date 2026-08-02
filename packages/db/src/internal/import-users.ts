// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/import-users.ts
//
// Data-freedom import addition (apps/worker/src/import — deliverable E).
// ADDITIVE, minimal: nothing pre-existing lets a caller insert a `users`
// row with a caller-chosen id. src/query/admin.ts's createUserAdmin() (the
// only existing users-insert writer) always mints a fresh id and lives in
// the PUBLIC barrel (users administration is isAdmin-authorized, not
// viewer-guarded — see that file's header), which is the right home for
// every OTHER users write in this codebase; import's restore path is
// different in kind (bulk, id-preserving, guard-free bookkeeping — the same
// P1.13 carve-out every sibling file in this directory relies on), so it
// gets its own narrow writer here rather than growing createUserAdmin an
// id-override parameter it would never otherwise need.
//
// Password/PIN restoration: packages/contract/openapi.yaml's ExportUser
// schema is explicitly documented as "sans secrets (no password hash, no
// PIN hash, no tokens)" — the archive never carries a restorable
// credential, by contract, for any user. insertUserWithId therefore always
// writes the SAME sentinel apps/server/src/session/auth.controller.ts
// already uses for its constant-time-login dummy comparison
// (`DUMMY_PASSWORD_HASH`): a well-formed PHC-encoded argon2id string
// (`$argon2id$...$AAAA...`) whose salt/hash are all-zero bytes, so
// HashService.verify() runs its normal argon2id comparison (never throws
// on a malformed hash) and deterministically returns false for every
// plaintext. Duplicated rather than imported: apps/worker cannot depend on
// apps/server's source (sibling apps, no such workspace edge), and the
// constant is small/stable enough that duplication-with-a-cross-reference
// is the right tradeoff over a new shared package for one string. Restored
// users cannot log in until an admin resets their password (or a future
// self-service "forgot password" flow, if one is ever built) — this is a
// direct, unavoidable consequence of the contract's own "sans secrets"
// design, not an import bug; see apps/worker/src/import/consumer.ts's
// module header for the full accounting of what the archive can and cannot
// restore.

import type { Selectable } from 'kysely';
import type { UsersTable } from '../types.js';
import type { DbOrTx } from './tx.js';

export type ImportUserRow = Selectable<UsersTable>;

/** Same sentinel as apps/server/src/session/auth.controller.ts's
 *  DUMMY_PASSWORD_HASH — see this module's header. */
export const IMPORT_PLACEHOLDER_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface InsertUserWithIdInput {
  /** Omit to let the DB DEFAULT loombre_uuidv7() mint a fresh id (import's
   *  merge-mode "create new" branch); supply the archive's own user id for
   *  the empty-target ID-preservation restore path — see the import
   *  consumer's module header. */
  id?: string;
  username: string;
  /** M1: nullable — ExportUser.email round-trips `null` for an email-less
   *  archived user. */
  email: string | null;
  /** M2: nullable — ExportUser.displayName round-trips the same way. */
  displayName?: string | null;
  isAdmin: boolean;
  createdAtMs: number;
  /** ExportUser carries no updatedAtMs (see module header) — the caller
   *  passes createdAtMs again here for both columns, matching exactly what
   *  the export side itself can prove happened. */
  updatedAtMs: number;
}

/**
 * Id-preserving users insert for the import empty-target restore path.
 * `birth_date`/`max_content_rating` are always NULL (not part of
 * ExportUser either) and `password_hash` is always the unmatchable
 * sentinel above — see module header for both.
 */
export async function insertUserWithId(db: DbOrTx, input: InsertUserWithIdInput): Promise<ImportUserRow> {
  return db
    .insertInto('users')
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      username: input.username,
      email: input.email,
      password_hash: IMPORT_PLACEHOLDER_PASSWORD_HASH,
      birth_date: null,
      max_content_rating: null,
      is_admin: input.isAdmin,
      display_name: input.displayName ?? null,
      created_at_ms: input.createdAtMs,
      updated_at_ms: input.updatedAtMs,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
