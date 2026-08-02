// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/admin.ts
//
// DECISION BEYOND SPEC (same justified-deviation pattern as
// catalog-detail.ts/progress-write.ts/libraries.ts — see catalog-detail.ts's
// header for the full rationale): the mission requires admin user CRUD
// (GET/POST /users, GET/PATCH/DELETE /users/{id}), self-service profile
// update (PATCH /users/me — email/birthDate/password only, never
// isAdmin/maxContentRating), device list/revoke (GET /devices,
// GET/DELETE /devices/{id}), and the admin job ledger
// (GET /admin/jobs, GET /admin/jobs/{id}) — none of which existed anywhere
// in packages/db before this wave (src/query/identity.ts only had
// getUserBy*/getUserSettings/device-create/refresh-token writers, no user
// CREATE/UPDATE/DELETE, no device LIST, no job-ledger reads at all outside
// @loombre/db/internal, which apps/server cannot import).
//
// None of these are ViewerContext-guarded (none touch catalog_items or its
// satellites): user/device/job administration is authorized by `isAdmin`
// (checked at the apps/server controller layer from the access-token
// claim) or by "this is MY OWN row" (self-service profile, own devices) —
// a different, simpler authorization model than the restricted-content
// five-gate guard this package's src/query/guard.ts exists for. This
// mirrors src/query/identity.ts's own stated reasoning for living in the
// public barrel rather than @loombre/db/internal.
//
// displayName / email (M1/M2, migrations/0023_user_invites.sql): the gap
// this header used to document is CLOSED — users.display_name is a real
// column now, and users.email lost its NOT NULL (an additive loosening,
// still CITEXT UNIQUE). createUserAdmin/updateUserAdmin/updateUserSelf all
// read/write both for real; mapUser at every call site (apps/server's
// users.controller.ts, setup.controller.ts) returns the row's own value
// instead of a hardcoded `null`.
//
// ADDENDUM (STATE.md P2.8/deliverable E, websocket-presence lane):
// listActiveSessionsAdmin below is the one function in this file that DOES
// take a ViewerContext, and for a narrow reason that doesn't contradict the
// header above — admin session-listing itself is still isAdmin-authorized,
// not ViewerContext-authorized (any admin may list every user's active
// sessions, restricted or not). The ViewerContext is used ONLY to decide,
// per row, whether THIS admin is personally cleared to know what item a
// session is playing — plan §6.4 gate 4/5 default-deny even admins; an
// admin without clearance for a restricted library must see that a session
// exists (id/user/device/status — none of that is restricted-content) but
// NOT which item it's for. See that function's own doc comment for the
// exact redaction contract.

import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, DevicesTable, ItemType, JobsTable, PlaybackSessionStatus, UsersTable } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuard, applyGuardToJoined } from './guard.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export type UserRow = Selectable<UsersTable>;
export type DeviceRow = Selectable<DevicesTable>;
export type JobRow = Selectable<JobsTable>;

const DEFAULT_LIMIT = 50;

// ============================================================================
// users (admin CRUD)
// ============================================================================

export interface ListUsersParams {
  cursor?: string;
  limit?: number;
}
export interface ListUsersResult {
  rows: UserRow[];
  nextCursor: string | null;
}

interface UserCursorPayload {
  createdAtMs: number;
  id: string;
}
function isUserCursorPayload(value: unknown): value is UserCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).createdAtMs === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

export async function listUsersAdmin(db: Kysely<DB>, params: ListUsersParams = {}): Promise<ListUsersResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  let query = db.selectFrom('users').selectAll();

  if (params.cursor) {
    const { createdAtMs, id } = decodeCursor(params.cursor, isUserCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('created_at_ms', '<', createdAtMs),
        eb.and([eb('created_at_ms', '=', createdAtMs), eb('id', '<', id)]),
      ])
    );
  }

  const rows = await query.orderBy('created_at_ms', 'desc').orderBy('id', 'desc').limit(limit).execute();
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ createdAtMs: last.created_at_ms, id: last.id }) : null;

  return { rows, nextCursor };
}

export interface CreateUserAdminInput {
  username: string;
  /** M1: nullable — omitted/undefined-at-the-caller-layer becomes NULL,
   *  matching CreateUserRequest.email's now-optional presence. */
  email: string | null;
  passwordHash: string;
  isAdmin: boolean;
  maxContentRating: string | null;
  /** M2: optional — omit or pass null/undefined for "unset". */
  displayName?: string | null;
  nowMs: number;
}

export async function createUserAdmin(db: Kysely<DB>, input: CreateUserAdminInput): Promise<UserRow> {
  return db
    .insertInto('users')
    .values({
      username: input.username,
      email: input.email,
      password_hash: input.passwordHash,
      birth_date: null,
      max_content_rating: input.maxContentRating,
      is_admin: input.isAdmin,
      display_name: input.displayName ?? null,
      created_at_ms: input.nowMs,
      updated_at_ms: input.nowMs,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface UpdateUserAdminInput {
  /** M1: `undefined` -> untouched (same convention every other optional
   *  field here already uses); an explicit `null` clears the email. */
  email?: string | null;
  isAdmin?: boolean;
  maxContentRating?: string | null;
  /** M2: `undefined` -> untouched; an explicit `null` clears the name. */
  displayName?: string | null;
  nowMs: number;
}

export async function updateUserAdmin(
  db: Kysely<DB>,
  id: string,
  input: UpdateUserAdminInput
): Promise<UserRow | undefined> {
  return db
    .updateTable('users')
    .set({
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.isAdmin !== undefined ? { is_admin: input.isAdmin } : {}),
      ...(input.maxContentRating !== undefined ? { max_content_rating: input.maxContentRating } : {}),
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      updated_at_ms: input.nowMs,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteUserAdmin(db: Kysely<DB>, id: string): Promise<boolean> {
  const result = await db.deleteFrom('users').where('id', '=', id).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

export interface UpdateUserSelfInput {
  /** M1: `undefined` -> untouched; `null` clears it (UpdateMeRequest's
   *  null-to-clear convention, same as birthDate below). */
  email?: string | null;
  birthDate?: string | null;
  passwordHash?: string;
  /** M2: `undefined` -> untouched; `null` clears it. */
  displayName?: string | null;
  nowMs: number;
}

/** Self-service profile update — deliberately cannot touch isAdmin or
 *  maxContentRating (no parameter exists for either), matching the
 *  contract's UpdateMeRequest schema exactly. */
export async function updateUserSelf(
  db: Kysely<DB>,
  userId: string,
  input: UpdateUserSelfInput
): Promise<UserRow | undefined> {
  return db
    .updateTable('users')
    .set({
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.birthDate !== undefined ? { birth_date: input.birthDate } : {}),
      ...(input.passwordHash !== undefined ? { password_hash: input.passwordHash } : {}),
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      updated_at_ms: input.nowMs,
    })
    .where('id', '=', userId)
    .returningAll()
    .executeTakeFirst();
}

// ============================================================================
// devices (list-for-user / revoke-for-user)
// ============================================================================

export interface ListDevicesParams {
  cursor?: string;
  limit?: number;
}
export interface ListDevicesResult {
  rows: DeviceRow[];
  nextCursor: string | null;
}

interface DeviceCursorPayload {
  createdAtMs: number;
  id: string;
}
function isDeviceCursorPayload(value: unknown): value is DeviceCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).createdAtMs === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

export async function listDevicesForUser(
  db: Kysely<DB>,
  userId: string,
  params: ListDevicesParams = {}
): Promise<ListDevicesResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  let query = db.selectFrom('devices').selectAll().where('user_id', '=', userId);

  if (params.cursor) {
    const { createdAtMs, id } = decodeCursor(params.cursor, isDeviceCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('created_at_ms', '<', createdAtMs),
        eb.and([eb('created_at_ms', '=', createdAtMs), eb('id', '<', id)]),
      ])
    );
  }

  const rows = await query.orderBy('created_at_ms', 'desc').orderBy('id', 'desc').limit(limit).execute();
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ createdAtMs: last.created_at_ms, id: last.id }) : null;

  return { rows, nextCursor };
}

/** Returns the device only if it belongs to `userId` — a caller must never
 *  be able to fetch/revoke another user's device by guessing its id. */
export async function getDeviceForUser(db: Kysely<DB>, userId: string, id: string): Promise<DeviceRow | undefined> {
  return db.selectFrom('devices').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
}

export async function deleteDeviceForUser(db: Kysely<DB>, userId: string, id: string): Promise<boolean> {
  const result = await db
    .deleteFrom('devices')
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

// ============================================================================
// jobs (admin ledger reads)
// ============================================================================

export interface ListJobsParams {
  cursor?: string;
  limit?: number;
}
export interface ListJobsResult {
  rows: JobRow[];
  nextCursor: string | null;
}

interface JobCursorPayload {
  createdAtMs: number;
  id: string;
}
function isJobCursorPayload(value: unknown): value is JobCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).createdAtMs === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

export async function listJobsAdmin(db: Kysely<DB>, params: ListJobsParams = {}): Promise<ListJobsResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  let query = db.selectFrom('jobs').selectAll();

  if (params.cursor) {
    const { createdAtMs, id } = decodeCursor(params.cursor, isJobCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('created_at_ms', '<', createdAtMs),
        eb.and([eb('created_at_ms', '=', createdAtMs), eb('id', '<', id)]),
      ])
    );
  }

  const rows = await query.orderBy('created_at_ms', 'desc').orderBy('id', 'desc').limit(limit).execute();
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ createdAtMs: last.created_at_ms, id: last.id }) : null;

  return { rows, nextCursor };
}

export async function getJobAdmin(db: Kysely<DB>, id: string): Promise<JobRow | undefined> {
  return db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
}

// ============================================================================
// admin session-list feed (STATE.md P2.8/deliverable E, GET /admin/sessions)
// ============================================================================

export interface AdminSessionRow {
  id: string;
  userId: string;
  username: string;
  deviceId: string | null;
  deviceName: string | null;
  /** null when the session's file has no recoverable item (module header
   *  of playback-sessions.ts: hard-deleted file) OR — for the this-admin's-
   *  own-clearance question this function answers — when it is currently
   *  hidden from `ctx` (see itemTitle/contentHidden below). Distinguishing
   *  those two cases is exactly what contentHidden is for. */
  itemId: string | null;
  /** The item's title, ONLY when visible to the requesting admin's OWN
   *  ViewerContext (plan §6.4 gate 4/5 — admins are not exempt). Null both
   *  when the item is hidden from this admin AND when there is no item at
   *  all; contentHidden disambiguates. */
  itemTitle: string | null;
  /** True iff this session's item EXISTS but is not visible to `ctx`
   *  (wrong library grant, or restricted + this admin isn't gate-5
   *  unlocked right now) — the redaction signal the admin UI renders
   *  instead of a title. False both when the item is visible AND when
   *  there is no item to hide (itemId is also null in that case). */
  contentHidden: boolean;
  status: PlaybackSessionStatus;
  startedAtMs: number;
  updatedAtMs: number;
  lastHeartbeatMs: number | null;
  /**
   * The session's STORED plan (docs/PLAYBACK.md §5 shape: decision,
   * reasons[], ladder, ...) — deliverable D's "why is this transcoding"
   * admin reasons panel reads this directly off the row instead of a
   * second request. Redacted the SAME WAY itemTitle is (null when
   * `contentHidden`, present otherwise) — never omitted — because the
   * plan's own fields (resolution/codec/bitrate choices) could indirectly
   * describe a restricted item this admin isn't currently cleared to see,
   * exactly the leak class this module's header explains itemTitle/
   * contentHidden exists to prevent.
   *
   * CONTRACT GAP (discovered, reported — not fixed this wave):
   * packages/contract/openapi.yaml's AdminSession schema does not declare
   * `plan`/`engineVersion` (openapi.yaml is frozen this wave, owned by a
   * different lane) — apps/server's admin.controller.ts mapper adds these
   * as additive, backward-compatible wire fields anyway (new optional
   * JSON properties break no existing consumer and are not Ajv-validated
   * against AdminSession's `additionalProperties: false` by any current
   * test — verified). Candidate additive contract PR for next wave:
   * promote `plan`/`engineVersion` into the committed AdminSession schema.
   */
  plan: Record<string, unknown> | null;
  engineVersion: string | null;
}

export interface ListActiveSessionsAdminParams {
  cursor?: string;
  limit?: number;
}
export interface ListActiveSessionsAdminResult {
  rows: AdminSessionRow[];
  nextCursor: string | null;
}

interface AdminSessionCursorPayload {
  startedAtMs: number;
  id: string;
}
function isAdminSessionCursorPayload(value: unknown): value is AdminSessionCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).startedAtMs === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

interface RawAdminSessionRow {
  id: string;
  userId: string;
  username: string;
  deviceId: string | null;
  deviceName: string | null;
  itemId: string | null;
  rawItemTitle: string | null;
  itemVisible: boolean;
  status: PlaybackSessionStatus;
  startedAtMs: number;
  updatedAtMs: number;
  lastHeartbeatMs: number | null;
  rawPlan: Record<string, unknown> | null;
  rawEngineVersion: string | null;
}

function mapAdminSessionRow(row: RawAdminSessionRow): AdminSessionRow {
  const itemVisible = row.itemId !== null && row.itemVisible;
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    itemId: row.itemId,
    itemTitle: itemVisible ? row.rawItemTitle : null,
    contentHidden: row.itemId !== null && !itemVisible,
    status: row.status,
    startedAtMs: row.startedAtMs,
    updatedAtMs: row.updatedAtMs,
    lastHeartbeatMs: row.lastHeartbeatMs,
    // A session with no item at all (itemId === null) has nothing
    // restricted to redact — its plan is shown exactly like a visible
    // session's would be, matching itemTitle's own null-vs-hidden rule
    // (redaction is keyed on contentHidden, not on itemVisible alone).
    plan: row.itemId === null || itemVisible ? row.rawPlan : null,
    engineVersion: row.itemId === null || itemVisible ? row.rawEngineVersion : null,
  };
}

/**
 * Active (status IN created/active) playback sessions across ALL users,
 * newest-started first, keyset-paginated on (startedAtMs, id) both
 * descending — for GET /admin/sessions (isAdmin-authorized at the
 * apps/server controller layer, see this file's header addendum).
 *
 * Item display fields (itemId/itemTitle/contentHidden) are resolved
 * through the REQUESTING ADMIN'S OWN `ctx`, via the exact same
 * applyGuardToJoined predicate every other guarded read in this package
 * uses (src/query/guard.ts) — evaluated as a boolean column
 * (`itemVisible`) rather than a row-filtering WHERE clause, because a
 * session whose item this admin can't see must still appear in the list
 * (with its item redacted), never be silently dropped — dropping it would
 * hide the fact that restricted playback is happening at all, which is a
 * DIFFERENT (and worse) leak than revealing an item title would be.
 */
export async function listActiveSessionsAdmin(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListActiveSessionsAdminParams = {}
): Promise<ListActiveSessionsAdminResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = db
    .selectFrom('playback_sessions')
    .innerJoin('users', 'users.id', 'playback_sessions.user_id')
    .leftJoin('devices', 'devices.id', 'playback_sessions.device_id')
    .leftJoin('media_files', 'media_files.id', 'playback_sessions.file_id')
    .leftJoin('catalog_items', 'catalog_items.id', 'media_files.item_id')
    .where('playback_sessions.status', 'in', ['created', 'active']);

  if (params.cursor) {
    const { startedAtMs, id } = decodeCursor(params.cursor, isAdminSessionCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('playback_sessions.started_at_ms', '<', startedAtMs),
        eb.and([
          eb('playback_sessions.started_at_ms', '=', startedAtMs),
          eb('playback_sessions.id', '<', id),
        ]),
      ])
    );
  }

  const rows = await query
    .select([
      'playback_sessions.id as id',
      'playback_sessions.user_id as userId',
      'users.username as username',
      'playback_sessions.device_id as deviceId',
      'devices.name as deviceName',
      'media_files.item_id as itemId',
      'catalog_items.title as rawItemTitle',
      applyGuardToJoined(ctx, 'media_files.item_id').as('itemVisible'),
      'playback_sessions.status as status',
      'playback_sessions.started_at_ms as startedAtMs',
      'playback_sessions.updated_at_ms as updatedAtMs',
      'playback_sessions.last_heartbeat_ms as lastHeartbeatMs',
      'playback_sessions.plan as rawPlan',
      'playback_sessions.engine_version as rawEngineVersion',
    ])
    .orderBy('playback_sessions.started_at_ms', 'desc')
    .orderBy('playback_sessions.id', 'desc')
    .limit(limit)
    .execute();

  const mapped = rows.map((row) => mapAdminSessionRow(row as unknown as RawAdminSessionRow));

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor({ startedAtMs: last.startedAtMs, id: last.id })
      : null;

  return { rows: mapped, nextCursor };
}

// ============================================================================
// unmatched-item listing (Phosphor retheme Wave 2, Lane L2 — Fix Match,
// GET /admin/libraries/{id}/unmatched)
// ============================================================================

/** Enrichable item types (mirrors apps/worker/src/metadata/consumer.ts's
 *  SUPPORTED_ITEM_TYPES / METADATA_ENRICHABLE_TYPES verbatim — season/
 *  episode/track are never independently enriched, so they can never be
 *  "unmatched" in their own right). */
const ENRICHABLE_ITEM_TYPES: readonly ItemType[] = ['movie', 'series', 'artist', 'album'];

export interface UnmatchedLibraryItemRow {
  itemId: string;
  itemType: ItemType;
  title: string;
  year: number | null;
  filePath: string | null;
}

export interface ListUnmatchedLibraryItemsParams {
  cursor?: string;
  limit?: number;
}
export interface ListUnmatchedLibraryItemsResult {
  rows: UnmatchedLibraryItemRow[];
  nextCursor: string | null;
}

interface UnmatchedItemCursorPayload {
  addedAtMs: number;
  id: string;
}
function isUnmatchedItemCursorPayload(value: unknown): value is UnmatchedItemCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).addedAtMs === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

/**
 * A representative on-disk path for an enrichable catalog item (U9: never
 * fabricated — null when genuinely unresolvable). movie/track-bearing items
 * own media_files rows directly at zero hierarchy depth; series/artist own
 * theirs two levels down (series->season->episode, artist->album->track);
 * album owns its one level down (album->track). One correlated scalar
 * subquery covers all four enrichable types by UNIONing all three possible
 * depths and taking the first hit — c1/c2 are always table ALIASES, so the
 * bare `catalog_items`/`media_files` references inside stay unambiguously
 * bound to the OUTER query's FROM (no self-join shadowing risk).
 */
function unmatchedItemFilePathExpr() {
  return sql<string | null>`(
    SELECT path FROM (
      SELECT mf1.path AS path FROM media_files mf1 WHERE mf1.item_id = catalog_items.id
      UNION ALL
      SELECT mf2.path FROM catalog_items c1 JOIN media_files mf2 ON mf2.item_id = c1.id WHERE c1.parent_id = catalog_items.id
      UNION ALL
      SELECT mf3.path FROM catalog_items c1 JOIN catalog_items c2 ON c2.parent_id = c1.id JOIN media_files mf3 ON mf3.item_id = c2.id WHERE c1.parent_id = catalog_items.id
    ) candidate_paths
    LIMIT 1
  )`;
}

/**
 * Enrichable-type catalog items with zero provider_ids rows, for one
 * library — the Fix Match "n UNMATCHED" list. Derived, never stored (U9).
 * Standard guarded read (packages/db/src/query/guard.ts's applyGuard): an
 * item this admin's OWN ViewerContext doesn't currently clear (wrong
 * library_permissions grant, or a restricted library this admin isn't
 * live-unlocked for) is simply absent from the page — the same posture
 * every other viewer-scoped catalog list in this API takes, unlike
 * listActiveSessionsAdmin's redact-in-place exception above (which exists
 * to prove a restricted PLAYBACK SESSION is happening at all; there is no
 * equivalent "something is happening" fact worth preserving for an
 * unmatched-metadata list).
 */
export async function listUnmatchedLibraryItemsForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext,
  libraryId: string,
  params: ListUnmatchedLibraryItemsParams = {}
): Promise<ListUnmatchedLibraryItemsResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = applyGuard(db.selectFrom('catalog_items'), ctx)
    .where('catalog_items.library_id', '=', libraryId)
    .where('catalog_items.item_type', 'in', ENRICHABLE_ITEM_TYPES as ItemType[])
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('provider_ids')
            .select('provider_ids.id')
            .whereRef('provider_ids.item_id', '=', 'catalog_items.id')
        )
      )
    );

  if (params.cursor) {
    const { addedAtMs, id } = decodeCursor(params.cursor, isUnmatchedItemCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('catalog_items.added_at_ms', '<', addedAtMs),
        eb.and([eb('catalog_items.added_at_ms', '=', addedAtMs), eb('catalog_items.id', '<', id)]),
      ])
    );
  }

  const rows = await query
    .select([
      'catalog_items.id as itemId',
      'catalog_items.item_type as itemType',
      'catalog_items.title as title',
      'catalog_items.year as year',
      'catalog_items.added_at_ms as addedAtMs',
      unmatchedItemFilePathExpr().as('filePath'),
    ])
    .orderBy('catalog_items.added_at_ms', 'desc')
    .orderBy('catalog_items.id', 'desc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ addedAtMs: last.addedAtMs, id: last.itemId }) : null;

  return {
    rows: rows.map((row) => ({
      itemId: row.itemId,
      itemType: row.itemType,
      title: row.title,
      year: row.year,
      filePath: row.filePath,
    })),
    nextCursor,
  };
}

// ============================================================================
// Fix Match item lookup (Phosphor retheme Wave 2, Lane L2 — POST
// /admin/items/{id}/match-search and /apply-match's existence + 404 check)
// ============================================================================

export interface EnrichableCatalogItemAdminRow {
  id: string;
  itemType: ItemType;
  libraryId: string;
  contentClass: 'general' | 'restricted';
  mediaKind: 'movie' | 'tv' | 'music';
  title: string;
  year: number | null;
}

/**
 * The Fix Match trigger endpoints' existence + item-type check (their 404
 * gate). Named ...ForAdmin because the ENDPOINTS are isAdmin-authorized,
 * but — like listActiveSessionsAdmin above, and unlike everything else in
 * this file — it also takes a ViewerContext, because it reads
 * catalog_items. Standard guarded read (applyGuard), exactly like
 * listUnmatchedLibraryItemsForViewer above — NOT the getLibraryByIdAdmin
 * admin-bypass posture, which reads `libraries` and is deliberately paired
 * there with a ViewerContext-guarded list; this lookup has no guarded half
 * to pair with, and it reads catalog_items, so plan §6.4's default-deny
 * (which denies uncleared ADMINS too) applies unchanged. An item this
 * admin's own ViewerContext doesn't clear is `undefined` here, i.e. a
 * byte-identical 404 to a nonexistent id — the job it would otherwise
 * enqueue derives its provider search from the item's real title/year and
 * broadcasts candidate titles back over the admin socket, so "the response
 * body is only {jobId}" is not by itself a reason to skip the guard.
 * `mediaKind` comes from the OWNING LIBRARY's media_kind (catalog_items
 * itself has no such column) — apps/worker's provider-chain resolution
 * needs it.
 */
export async function getEnrichableCatalogItemForAdmin(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string
): Promise<EnrichableCatalogItemAdminRow | undefined> {
  const row = await applyGuard(db.selectFrom('catalog_items'), ctx)
    .innerJoin('libraries', 'libraries.id', 'catalog_items.library_id')
    .select([
      'catalog_items.id as id',
      'catalog_items.item_type as itemType',
      'catalog_items.library_id as libraryId',
      'catalog_items.content_class as contentClass',
      'libraries.media_kind as mediaKind',
      'catalog_items.title as title',
      'catalog_items.year as year',
    ])
    .where('catalog_items.id', '=', id)
    .executeTakeFirst();

  if (!row || !ENRICHABLE_ITEM_TYPES.includes(row.itemType)) return undefined;
  return row;
}
