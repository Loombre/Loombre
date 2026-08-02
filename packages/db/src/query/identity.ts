// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/identity.ts
//
// "Identity plumbing" reads/writes: users, user_settings,
// library_permissions, devices, refresh_tokens. This is deliberately NOT
// catalog data — it is the input apps/server's auth layer uses to
// AUTHENTICATE a request and BUILD a ViewerContext (docs/PLAN.md §6.4) in
// the first place, so wrapping it in applyGuard() (which requires an
// already-resolved ViewerContext) would be circular.
//
// Home: the PUBLIC barrel (src/index.ts), not @loombre/db/internal. Two
// independent reasons:
//   1. dependency-cruiser's "no-internal-db-outside-worker" rule forbids
//      apps/server from importing the internal subpath at all — that door
//      is reserved for the guard-free scanner/import writer (P1.13).
//   2. CLAUDE.md invariant 4 ("ALL catalog reads go through
//      packages/db/query with a ViewerContext") is scoped to catalog_items
//      reads specifically; these functions never touch catalog_items.
// Every caller still goes through typed, narrow functions here — never a
// raw Kysely handle — so packages/db remains the only place pg/kysely is
// imported (dependency-cruiser's "no-raw-db-driver-outside-packages-db").

import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type {
  DB,
  UsersTable,
  UserSettingsTable,
  DevicesTable,
  RefreshTokensTable,
} from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';
import { createUserAdmin, type CreateUserAdminInput } from './admin.js';

export type UserRow = Selectable<UsersTable>;
export type UserSettingsRow = Selectable<UserSettingsTable>;
export type DeviceRow = Selectable<DevicesTable>;
export type RefreshTokenRow = Selectable<RefreshTokensTable>;

// ============================================================================
// users
// ============================================================================

export async function getUserByUsername(
  db: Kysely<DB>,
  username: string
): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('username', '=', username).executeTakeFirst();
}

/**
 * STATE.md P4.6/P4.10 (onboarding wizard): "is this instance's users table
 * empty" is instance-fact identity plumbing, not viewer-scoped catalog data
 * — same P1.14 precedent as every other function in this file (see module
 * header). GET /setup/state calls this directly (needsSetup = count === 0);
 * it is deliberately a plain count, not a `LIMIT 1 EXISTS`, so a future
 * caller that wants the real number doesn't need a second function.
 */
export async function countUsers(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirst();
  return row ? Number(row.count) : 0;
}

export interface CreateUserAdminAndEmitInput extends CreateUserAdminInput {
  /** The admin who performed the creation (POST /v1/users). Omitted for
   *  first-run onboarding, where no prior user exists to attribute it to —
   *  the new admin is then recorded as their own actor. */
  actorUserId?: string;
}

/**
 * Shared insert-and-emit body for both user-creation entry points below, so
 * `user.created` can never be emitted by one and forgotten by the other.
 * Payload is exactly packages/contract/event-schemas/user.created.schema.json's
 * required set (additionalProperties: false) — never `password_hash` or any
 * other secret, per that schema's description.
 */
async function insertUserAndEmit(
  trx: Transaction<DB>,
  input: CreateUserAdminAndEmitInput
): Promise<UserRow> {
  const row = await createUserAdmin(trx, input);

  await writeEvent(trx, {
    type: 'user.created',
    tsMs: input.nowMs,
    actorUserId: input.actorUserId ?? row.id,
    payload: {
      userId: row.id,
      username: row.username,
      isAdmin: row.is_admin,
      createdAtMs: row.created_at_ms,
    },
  });

  return row;
}

/**
 * createUserAdmin's outbox-transactional sibling — the SAME split
 * setRestrictedUnlockUntil/setRestrictedUnlockUntilAndEmit (below) already
 * established, and for the same reason: src/internal/import-users.ts's
 * bulk-restore path deliberately writes user rows WITHOUT per-row events
 * (apps/worker/test/import/consumer.spec.ts asserts that), so the emission
 * belongs to a separate entry point rather than to createUserAdmin itself.
 *
 * Every interactive user-creation path goes through this one (docs/PLAN.md
 * §4.3: the event row is written in the same transaction as the state
 * change it describes).
 */
export async function createUserAdminAndEmit(
  db: Kysely<DB>,
  input: CreateUserAdminAndEmitInput
): Promise<UserRow> {
  return withTransaction(db, (trx) => insertUserAndEmit(trx, input));
}

export interface CreateFirstAdminInput {
  username: string;
  email: string;
  passwordHash: string;
  /** M2 (scope extension beyond the M1/M2 brief's explicit call sites —
   *  logged in Lane A's freeze report): FirstAdminRequest has always
   *  declared+read `displayName` (setup.controller.ts's own header
   *  documented the identical silent-discard gap createUserAdmin had) but
   *  had nowhere to persist it; wired through now that the column exists,
   *  for the same H1-class reason. */
  displayName?: string | null;
  nowMs: number;
}

/**
 * Race-safe first-admin creation (STATE.md P4.10): POST /setup/first-admin
 * must succeed for EXACTLY ONE of any number of concurrent callers when the
 * users table is empty, and be a permanent no-op (returns `undefined`, zero
 * rows written) the instant any user exists — including two requests that
 * both observe an empty table before either one writes.
 *
 * Race safety strategy: a TRANSACTION-SCOPED Postgres advisory lock
 * (`pg_advisory_xact_lock`, keyed by a fixed hashtext-derived id every
 * caller shares) serializes every concurrent caller around the
 * count-then-insert critical section below. The second of two concurrent
 * callers blocks on the lock until the first COMMITs (or ROLLBACKs); by the
 * time it acquires the lock, the count it observes already reflects the
 * first caller's write (or lack thereof). `pg_advisory_xact_lock`
 * auto-releases at COMMIT/ROLLBACK — no separate unlock call, and no way
 * for a crashed or timed-out caller to leave it held. This is strictly
 * stronger than relying on `users.username`'s unique constraint alone: two
 * callers presenting DIFFERENT usernames would otherwise both pass a naive
 * "SELECT count then INSERT" race and both succeed, which is exactly the
 * "exactly one 201" invariant this function exists to prevent.
 *
 * Reuses insertUserAndEmit (above — createUserAdmin's insert plus the
 * `user.created` outbox row; argon2id hashing happens in the caller, this
 * function only receives the already-hashed password) for the actual
 * insert, so first-admin creation and every other admin-created user share
 * one column list, one code path, and one emission — never duplicated. The
 * event lands inside the advisory-locked transaction below, so the losing
 * caller of a race writes neither a user row nor an event.
 */
export async function createFirstAdminIfEmpty(
  db: Kysely<DB>,
  input: CreateFirstAdminInput
): Promise<UserRow | undefined> {
  return withTransaction(db, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('loombre:setup:first-admin'))`.execute(trx);

    const existing = await trx
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst();
    if (existing && Number(existing.count) > 0) {
      return undefined;
    }

    return insertUserAndEmit(trx, {
      username: input.username,
      email: input.email,
      passwordHash: input.passwordHash,
      isAdmin: true,
      maxContentRating: null,
      displayName: input.displayName ?? null,
      nowMs: input.nowMs,
    });
  });
}

/**
 * M1: `email` is now nullable (migrations/0023_user_invites.sql), but this
 * function's own `= $literal` comparison ALREADY never matches a NULL row
 * — SQL equality against NULL is never true, never false, it's NULL, which
 * a WHERE clause treats as "exclude" — so an email-less user can never be
 * returned here regardless of what string is looked up (verified;
 * identity.spec.ts pins this with a dedicated regression case). No code
 * change was needed for M1's "must never match NULL" requirement; this
 * comment records that the invariant was checked, not assumed.
 */
export async function getUserByEmail(
  db: Kysely<DB>,
  email: string
): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
}

export async function getUserById(db: Kysely<DB>, id: string): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}

// ============================================================================
// user_settings
// ============================================================================

export async function getUserSettings(
  db: Kysely<DB>,
  userId: string
): Promise<UserSettingsRow | undefined> {
  return db
    .selectFrom('user_settings')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

export interface UpdateRestrictedSettingsInput {
  userId: string;
  optIn: boolean;
  /** New PIN hash, or `null` to clear it (opt-out). Leaving the existing
   *  hash untouched is expressed by the caller re-passing it, not by a
   *  third "leave as-is" state — this function always sets the column. */
  pinHash: string | null;
  updatedAtMs: number;
}

/**
 * Gate 3 (opt-in + PIN, docs/PLAN.md §6.4). Upserts because a fresh user
 * row could in principle lack a user_settings row (no DB-level auto-create
 * trigger); in practice every seeded/created user gets one, but this stays
 * correct either way.
 */
export async function updateRestrictedSettings(
  db: Kysely<DB>,
  input: UpdateRestrictedSettingsInput
): Promise<UserSettingsRow> {
  const row = await db
    .insertInto('user_settings')
    .values({
      user_id: input.userId,
      restricted_opt_in: input.optIn,
      restricted_pin_hash: input.pinHash,
      updated_at_ms: input.updatedAtMs,
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        restricted_opt_in: input.optIn,
        restricted_pin_hash: input.pinHash,
        updated_at_ms: input.updatedAtMs,
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row;
}

export interface UpdateUserPrefsInput {
  userId: string;
  /** The FULL prefs object to store (locale/theme/subtitlePreferredLanguage/
   *  audioPreferredLanguage/autoplayNextEpisode — H1, orchestrator
   *  adjudication A-5). This function always REPLACES the whole `prefs`
   *  JSONB value, mirroring updateRestrictedSettings' always-sets-the-
   *  column posture below — the caller (apps/server's putMySettings) is
   *  responsible for assembling the full object, since the contract's
   *  UserSettings is itself a full-replace PUT body, not a patch. */
  prefs: Record<string, unknown>;
  updatedAtMs: number;
}

/**
 * user_settings.prefs writer (H1, orchestrator adjudication A-5). "Guarded"
 * here does NOT mean applyGuard() — see this file's header: identity
 * plumbing is deliberately outside that mechanism, which exists for
 * ViewerContext-scoped catalog_items reads. This writer's actual guard is
 * strict self-scoping by `user_id` (every call site passes the
 * AUTHENTICATED caller's own userId — there is no admin-on-behalf-of-
 * another-user path, same posture as updateRestrictedSettings below) plus
 * validated values (the caller — apps/server/src/catalog/
 * users.controller.ts's putMySettings — checks locale length, the theme
 * enum, and known-language-list membership via
 * @loombre/shared's isKnownLanguageCode BEFORE this function is ever
 * called; this module trusts its input the same way upsertServerSettingAndEmit
 * trusts the registry-checked caller in src/query/settings.ts).
 *
 * Upserts for the same reason updateRestrictedSettings does (a fresh user
 * row could in principle lack a user_settings row). Only `prefs` and
 * `updated_at_ms` are ever written — `restricted_opt_in`/
 * `restricted_pin_hash`/`restricted_unlocked_until_ms` are UNTOUCHED (A-5),
 * both on insert (they fall through to the column defaults: FALSE/NULL/NULL)
 * and on conflict (they are simply absent from doUpdateSet, so Postgres
 * leaves the existing values alone).
 *
 * JSONB write note: `prefs` goes through `sql\`${json}::jsonb\``, not a bare
 * Kysely value — see src/query/settings.ts's module header for why a plain
 * JS object/array/string sent through node-postgres's default parameter
 * serialization does not round-trip correctly against a jsonb column.
 */
export async function updateUserPrefs(
  db: Kysely<DB>,
  input: UpdateUserPrefsInput
): Promise<UserSettingsRow> {
  const prefsJson = JSON.stringify(input.prefs);
  const row = await db
    .insertInto('user_settings')
    .values({
      user_id: input.userId,
      prefs: sql`${prefsJson}::jsonb`,
      updated_at_ms: input.updatedAtMs,
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        prefs: sql`${prefsJson}::jsonb`,
        updated_at_ms: input.updatedAtMs,
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row;
}

/**
 * Gate 5 (live session unlock, docs/PLAN.md §6.4). `unlockedUntilMs = null`
 * clears the unlock immediately (POST /restricted/lock).
 */
export async function setRestrictedUnlockUntil(
  db: Kysely<DB>,
  userId: string,
  unlockedUntilMs: number | null,
  updatedAtMs: number
): Promise<void> {
  await db
    .updateTable('user_settings')
    .set({ restricted_unlocked_until_ms: unlockedUntilMs, updated_at_ms: updatedAtMs })
    .where('user_id', '=', userId)
    .execute();
}

/**
 * setRestrictedUnlockUntil's outbox-transactional sibling (STATE.md
 * P2.8/deliverable E, websocket-presence lane): used ONLY by
 * apps/server/src/session/restricted.controller.ts's explicit POST
 * /restricted/unlock and POST /restricted/lock handlers, so that a user's
 * own already-connected websocket sockets learn about the gate-5
 * transition immediately (packages/db/src/query/events.ts's USER_ONLY_TYPES
 * delivery, apps/server/src/gateway/ws-broadcaster.service.ts). Emits
 * `restricted.unlocked` when `unlockedUntilMs` is non-null, else
 * `restricted.locked` — payload is always `{userId}` per those schemas.
 *
 * Deliberately NOT the behavior of the plain setRestrictedUnlockUntil above
 * (which stays event-free): that function is also called from
 * apps/server/src/session/auth.controller.ts's login path to unconditionally
 * reset gate 5 on every login (P1.14) — always emitting a `restricted.locked`
 * there would be noisy/wrong for the overwhelmingly common case of a user
 * who was never unlocked in the first place, and login has no natural
 * "this was actually a user-facing lock action" semantics the way the
 * dedicated /restricted/lock endpoint does. Keeping the two functions
 * separate means every OTHER existing call site (login, and this file's
 * own tests) is completely unaffected by this addition.
 */
export async function setRestrictedUnlockUntilAndEmit(
  db: Kysely<DB>,
  userId: string,
  unlockedUntilMs: number | null,
  nowMs: number
): Promise<void> {
  await withTransaction(db, async (trx) => {
    await trx
      .updateTable('user_settings')
      .set({ restricted_unlocked_until_ms: unlockedUntilMs, updated_at_ms: nowMs })
      .where('user_id', '=', userId)
      .execute();

    await writeEvent(trx, {
      type: unlockedUntilMs !== null ? 'restricted.unlocked' : 'restricted.locked',
      tsMs: nowMs,
      actorUserId: userId,
      payload: { userId },
    });
  });
}

export interface ResetRestrictedPinInput {
  userId: string;
  username: string;
  nowMs: number;
}

export interface ResetRestrictedPinResult {
  /** False when the user had no user_settings row at all (never opted in)
   *  — a true no-op: nothing was updated and no event was written. */
  cleared: boolean;
}

/**
 * H2 (owner brief): the ONLY restricted-content PIN recovery path in v1 —
 * `loombre admin reset-pin <username>` (apps/server/src/cli/
 * admin-reset-pin.ts), server-local and interactively confirmed there.
 * Deliberately NOT reachable over HTTP (apps/server/src/session/
 * restricted.controller.ts and users-me.controller.ts's headers both note
 * this): filesystem access to the running server IS the privilege boundary,
 * not a bearer token.
 *
 * Clears ALL THREE gate-3/gate-5 columns UNCONDITIONALLY (restricted_opt_in
 * -> false, restricted_pin_hash -> null, restricted_unlocked_until_ms ->
 * null) whenever a user_settings row exists for this user, regardless of
 * what state it was already in — never a partial or conditional clear. This
 * is deliberate: "the user's next opt-in flow starts fresh" (owner brief)
 * requires optIn itself to go false, so PUT /users/me/restricted's
 * first-time-opt-in branch (users-me.controller.ts: `!currentlyOptedIn ||
 * currentPinHash === null`) governs the next attempt and demands a
 * brand-new 4-digit PIN under the P4.22 contract — the same path a user who
 * never opted in at all goes through.
 *
 * No-op (no UPDATE, no event) when the user has NO user_settings row at
 * all — there is nothing to clear and nothing worth auditing; mirrors
 * updateRestrictedSettings's own "a fresh user row could in principle lack
 * a user_settings row" note above. A user who opted out (row exists, but
 * already opt_in=false/pin_hash=null) still gets the unconditional
 * clear-and-emit — the row's existence is the only precondition, not its
 * current values, so the audit trail always reflects that a reset was
 * actually performed by an operator.
 *
 * Emits `user.restricted-pin-reset` (ADMIN_ONLY delivery — apps/server/src/
 * plugins/event-taxonomy.ts) with payload `{userId, username, actor: 'cli'}`
 * — NEVER a hash or PIN. `actorUserId` (the envelope's own actor-attribution
 * field) is `null`: the CLI runs outside any authenticated user session and
 * has no user id to attribute this to; the payload's own `actor: 'cli'`
 * field is what carries that provenance instead (packages/contract/
 * event-schemas/user.restricted-pin-reset.schema.json).
 */
export async function resetRestrictedPinAndEmit(
  db: Kysely<DB>,
  input: ResetRestrictedPinInput
): Promise<ResetRestrictedPinResult> {
  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('user_settings')
      .select('user_id')
      .where('user_id', '=', input.userId)
      .executeTakeFirst();
    if (!existing) {
      return { cleared: false };
    }

    await trx
      .updateTable('user_settings')
      .set({
        restricted_opt_in: false,
        restricted_pin_hash: null,
        restricted_unlocked_until_ms: null,
        updated_at_ms: input.nowMs,
      })
      .where('user_id', '=', input.userId)
      .execute();

    await writeEvent(trx, {
      type: 'user.restricted-pin-reset',
      tsMs: input.nowMs,
      actorUserId: null,
      payload: { userId: input.userId, username: input.username, actor: 'cli' },
    });

    return { cleared: true };
  });
}

// ============================================================================
// library_permissions
// ============================================================================

export interface LibraryPermissionSummary {
  generalLibraryIds: string[];
  restrictedLibraryIds: string[];
}

/**
 * Gate 4 (explicit library grant, docs/PLAN.md §6.4) — split by the
 * library's content_class so callers can apply gates 1-3 before deciding
 * whether the restricted half is visible at all.
 */
export async function getLibraryPermissionSummary(
  db: Kysely<DB>,
  userId: string
): Promise<LibraryPermissionSummary> {
  const rows = await db
    .selectFrom('library_permissions')
    .innerJoin('libraries', 'libraries.id', 'library_permissions.library_id')
    .select(['libraries.id as libraryId', 'libraries.content_class as contentClass'])
    .where('library_permissions.user_id', '=', userId)
    .execute();

  const generalLibraryIds: string[] = [];
  const restrictedLibraryIds: string[] = [];
  for (const row of rows) {
    if (row.contentClass === 'restricted') {
      restrictedLibraryIds.push(row.libraryId);
    } else {
      generalLibraryIds.push(row.libraryId);
    }
  }
  return { generalLibraryIds, restrictedLibraryIds };
}

// ============================================================================
// devices
// ============================================================================

export interface CreateDeviceInput {
  userId: string;
  name: string;
  platform: string | null;
  profile: Record<string, unknown>;
  nowMs: number;
}

/** Login registers a fresh device row every call (STATE.md P1.14) — device
 *  de-duplication/rename is a future UX concern, not an auth-correctness
 *  one; each device row is what refresh_tokens.device_id anchors to. */
export async function createDevice(db: Kysely<DB>, input: CreateDeviceInput): Promise<DeviceRow> {
  return db
    .insertInto('devices')
    .values({
      user_id: input.userId,
      name: input.name,
      platform: input.platform,
      profile: input.profile,
      last_seen_ms: input.nowMs,
      created_at_ms: input.nowMs,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getDeviceById(db: Kysely<DB>, id: string): Promise<DeviceRow | undefined> {
  return db.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function touchDevice(db: Kysely<DB>, id: string, nowMs: number): Promise<void> {
  await db.updateTable('devices').set({ last_seen_ms: nowMs }).where('id', '=', id).execute();
}

export interface UpdateDeviceForLoginInput {
  profile: Record<string, unknown>;
  nowMs: number;
}

/**
 * Login device-row reuse (STATE.md P2.16): when a login presents a
 * `deviceId` that resolves to a device the AUTHENTICATING USER already owns
 * (ownership is the caller's responsibility to check first — see
 * @loombre/db's `getDeviceForUser` — this function does not re-check it),
 * the row is refreshed in place rather than a duplicate device being
 * created: profile is replaced with whatever the client declared this
 * time (device capabilities can legitimately change — browser update,
 * different codec support) and `last_seen_ms` advances. `id`/`user_id`/
 * `created_at_ms` are untouched.
 */
export async function updateDeviceForLogin(
  db: Kysely<DB>,
  id: string,
  input: UpdateDeviceForLoginInput
): Promise<DeviceRow> {
  return db
    .updateTable('devices')
    .set({ profile: input.profile, last_seen_ms: input.nowMs })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ============================================================================
// refresh_tokens (P1.14 — rotation + reuse/theft detection)
// ============================================================================

export interface InsertRefreshTokenInput {
  userId: string;
  deviceId: string | null;
  tokenHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  rotatedFrom: string | null;
}

export async function insertRefreshToken(
  db: Kysely<DB>,
  input: InsertRefreshTokenInput
): Promise<RefreshTokenRow> {
  return db
    .insertInto('refresh_tokens')
    .values({
      user_id: input.userId,
      device_id: input.deviceId,
      token_hash: input.tokenHash,
      issued_at_ms: input.issuedAtMs,
      expires_at_ms: input.expiresAtMs,
      rotated_from: input.rotatedFrom,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findRefreshTokenByHash(
  db: Kysely<DB>,
  tokenHash: string
): Promise<RefreshTokenRow | undefined> {
  return db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
}

/**
 * Revokes a single refresh-token row, returning TRUE iff this call was the
 * one that flipped it (matched a still-live row). The
 * `WHERE revoked_at_ms IS NULL` guard makes revocation a compare-and-swap:
 * when two rotations race the same token, exactly one gets `true` and the
 * loser gets `false` — the caller uses that to avoid minting a second live
 * child from an already-consumed token (rotate() below).
 */
export async function revokeRefreshTokenById(
  db: Kysely<DB>,
  id: string,
  revokedAtMs: number
): Promise<boolean> {
  const result = await db
    .updateTable('refresh_tokens')
    .set({ revoked_at_ms: revokedAtMs })
    .where('id', '=', id)
    .where('revoked_at_ms', 'is', null)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}

/**
 * Token-theft response (docs/PLAN.md §10, task spec): reuse of an
 * already-rotated/revoked refresh token revokes the WHOLE hash chain —
 * every ancestor (rotated_from predecessors) AND every descendant (rows
 * whose rotated_from points into the chain), not just the reused row.
 * Descendants matter because an attacker who reused an old token may have
 * done so *after* the legitimate client already rotated further ahead; the
 * still-active tip of that legitimate chain must die too, since we can no
 * longer tell which party is the genuine holder.
 *
 * Returns the number of previously-active rows that were revoked.
 */
export async function revokeRefreshTokenChain(
  db: Kysely<DB>,
  startId: string,
  revokedAtMs: number
): Promise<number> {
  const visited = new Set<string>();
  let frontier: string[] = [startId];

  while (frontier.length > 0) {
    const toVisit = frontier.filter((id) => !visited.has(id));
    if (toVisit.length === 0) break;
    for (const id of toVisit) visited.add(id);

    const rows = await db
      .selectFrom('refresh_tokens')
      .select(['id', 'rotated_from'])
      .where('id', 'in', toVisit)
      .execute();

    const children = await db
      .selectFrom('refresh_tokens')
      .select('id')
      .where('rotated_from', 'in', toVisit)
      .execute();

    const next = new Set<string>();
    for (const row of rows) {
      if (row.rotated_from) next.add(row.rotated_from);
    }
    for (const row of children) {
      next.add(row.id);
    }
    frontier = [...next].filter((id) => !visited.has(id));
  }

  if (visited.size === 0) return 0;

  const result = await db
    .updateTable('refresh_tokens')
    .set({ revoked_at_ms: revokedAtMs })
    .where('id', 'in', [...visited])
    .where('revoked_at_ms', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows ?? 0);
}

/**
 * Logout (POST /auth/logout): revokes every still-active refresh token for
 * one (user, device) pair. LogoutRequest carries no refresh token itself —
 * only an optional deviceId — so logout scopes by device, not by chain
 * walk; any token for that device that hasn't already been rotated/revoked
 * dies. Returns the number of rows revoked.
 */
export async function revokeRefreshTokensForDevice(
  db: Kysely<DB>,
  userId: string,
  deviceId: string,
  revokedAtMs: number
): Promise<number> {
  const result = await db
    .updateTable('refresh_tokens')
    .set({ revoked_at_ms: revokedAtMs })
    .where('user_id', '=', userId)
    .where('device_id', '=', deviceId)
    .where('revoked_at_ms', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/**
 * Password recovery (E3/M14/M15): revokes EVERY still-active refresh token
 * for a user, across ALL devices — unlike revokeRefreshTokensForDevice
 * (one device) or revokeRefreshTokenChain (one chain), this is a whole-
 * account sweep. Used by resetUserPasswordAndEmit below and by
 * packages/db/src/query/password-reset.ts's resetPasswordViaTokenAndEmit
 * whenever a password changes by ANY path (admin/CLI temporary-password
 * reset, or a self-service token-based reset): a stolen or shared password
 * must not leave any existing session alive. `db` accepts a
 * `Transaction<DB>` (Kysely's Transaction extends Kysely, see
 * internal/tx.ts) so callers compose this into the SAME transaction as the
 * password_hash write and the user.password-reset event (outbox pattern,
 * docs/PLAN.md §4.3). Returns the number of rows revoked.
 */
export async function revokeAllRefreshTokensForUser(
  db: Kysely<DB>,
  userId: string,
  revokedAtMs: number
): Promise<number> {
  const result = await db
    .updateTable('refresh_tokens')
    .set({ revoked_at_ms: revokedAtMs })
    .where('user_id', '=', userId)
    .where('revoked_at_ms', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

// F5's revokeOtherRefreshTokensForUser lives in src/query/admin.ts, NOT
// here, despite being a refresh_tokens operation like its neighbors above
// — this file already imports createUserAdmin FROM admin.ts (see this
// file's own import list), so admin.ts importing something back FROM
// here would be a circular module dependency (depcruise's no-circular
// rule, enforced repo-wide, caught it). See admin.ts's own doc comment on
// that function for the full rationale.

// ============================================================================
// password recovery — admin/CLI temporary-password reset (E3a, M14)
// ============================================================================

export interface ResetUserPasswordAdminInput {
  userId: string;
  username: string;
  /** Already argon2id-hashed by the caller (apps/server's HashService, or
   *  the CLI's own hash-wasm call — see apps/server/src/cli/
   *  admin-reset-password.ts) — this module never hashes a plaintext
   *  secret itself, same posture as createUserAdmin/updateUserSelf. */
  passwordHash: string;
  /** 'cli' (loombre admin reset-password <username>, actorUserId always
   *  null — the CLI runs outside any authenticated session, same posture
   *  as resetRestrictedPinAndEmit) or 'admin' (POST /users/{id}/reset-password,
   *  actorUserId = the acting admin). */
  actor: 'cli' | 'admin';
  actorUserId: string | null;
  nowMs: number;
}

/**
 * H2 pattern applied to passwords (E3a/M14): the admin/CLI-driven
 * temporary-password reset. One transaction: sets `users.password_hash` to
 * the caller-supplied hash of a freshly generated temporary password (the
 * PLAINTEXT is never seen by this module — the caller generates it,
 * prints/returns it ONCE, and hands this function only the hash),
 * `must_change_password -> TRUE` (enforced server-side by
 * apps/server/src/gateway/auth.guard.ts's guard chain, not merely
 * advisory), revokes EVERY refresh token the user holds (revokeAllRefreshTokensForUser
 * above — every existing session dies, matching resetRestrictedPinAndEmit's
 * "ends any active unlock" unconditional-clear posture), and emits
 * `user.password-reset` (ADMIN_ONLY delivery, packages/contract/
 * event-schemas/user.password-reset.schema.json) with payload
 * `{userId, username, actor}` — NEVER the password or its hash, matching
 * resetRestrictedPinAndEmit's own "never a hash or PIN" rule exactly.
 */
export async function resetUserPasswordAndEmit(
  db: Kysely<DB>,
  input: ResetUserPasswordAdminInput
): Promise<void> {
  return withTransaction(db, async (trx) => {
    await trx
      .updateTable('users')
      .set({
        password_hash: input.passwordHash,
        must_change_password: true,
        // R-F7 (opus adversarial review, fix wave): credentials-changed
        // epoch — see migrations/0026_password_changed_epoch.sql and
        // apps/server/src/gateway/auth.guard.ts's verifyAndAttach.
        password_changed_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
      })
      .where('id', '=', input.userId)
      .execute();

    await revokeAllRefreshTokensForUser(trx, input.userId, input.nowMs);

    await writeEvent(trx, {
      type: 'user.password-reset',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { userId: input.userId, username: input.username, actor: input.actor },
    });
  });
}
