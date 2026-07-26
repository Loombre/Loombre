// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/settings.ts
//
// server_settings reads/writes (Addendum A/A4, migrations/
// 0013_server_settings.sql) — instance facts, not viewer-scoped catalog
// data, the SAME P1.14 precedent src/query/identity.ts's header documents
// at length: this lives in the PUBLIC barrel (src/index.ts), not
// @loombre/db/internal, because (1) dependency-cruiser's
// "no-internal-db-outside-worker" rule forbids apps/server from importing
// the internal subpath at all, and (2) CLAUDE.md invariant 4's guard
// requirement is scoped to catalog_items reads specifically — these
// functions never touch catalog_items and need no ViewerContext.
//
// Deliberately registry-UNAWARE: packages/db has no dependency on
// @loombre/shared (where packages/shared/src/settings-registry.ts lives) and
// this addendum does not introduce one. Registry-key allowlisting, schema
// validation, and env-pin lockout checks are ALL the caller's job
// (apps/server/src/settings/settings.service.ts, per this addendum's own
// ARCHITECTURE GUIDANCE) — this module is a thin CRUD + outbox primitive
// that will happily write a row for ANY string key it's given. That is not
// a gap: the admin API layer is the only writer in practice, and it always
// validates against the registry before ever calling upsertServerSettingAndEmit.
//
// Outbox pattern (docs/PLAN.md §4.3): upsertServerSettingAndEmit writes the
// row AND its `settings.updated` event in ONE transaction, exactly like
// createLibrary (src/query/libraries.ts) and
// setRestrictedUnlockUntilAndEmit (src/query/identity.ts) — old/new values
// are read inside the SAME transaction so the event's oldValue can never
// desync from what was actually overwritten by a concurrent writer.
//
// JSONB write note: `value` is deliberately written via `sql\`${json}::jsonb\``
// rather than handed to Kysely as a plain JS value — node-postgres's default
// parameter serialization sends a bare JS array as a POSTGRES ARRAY literal
// and a bare JS string unquoted, BOTH of which fail against a jsonb column
// for anything other than a plain object (verified empirically against a
// live database while building this module). Only an explicit
// JSON.stringify + `::jsonb` cast round-trips every JSON value shape
// (boolean/number/string/array/object) correctly.

import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, ServerSettingsTable } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';

export type ServerSettingRow = Selectable<ServerSettingsTable>;

export async function listServerSettings(db: Kysely<DB>): Promise<ServerSettingRow[]> {
  return db.selectFrom('server_settings').selectAll().execute();
}

export async function getServerSetting(
  db: Kysely<DB>,
  key: string
): Promise<ServerSettingRow | undefined> {
  return db.selectFrom('server_settings').selectAll().where('key', '=', key).executeTakeFirst();
}

export interface UpsertServerSettingInput {
  key: string;
  value: unknown;
  actorUserId: string;
  nowMs: number;
}

export interface UpsertServerSettingResult {
  row: ServerSettingRow;
  /** `null` when this write CREATED the row (no prior value existed). */
  oldValue: unknown | null;
}

export async function upsertServerSettingAndEmit(
  db: Kysely<DB>,
  input: UpsertServerSettingInput
): Promise<UpsertServerSettingResult> {
  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('server_settings')
      .select('value')
      .where('key', '=', input.key)
      .executeTakeFirst();
    const oldValue = existing ? existing.value : null;

    const valueJson = JSON.stringify(input.value);

    const row = await trx
      .insertInto('server_settings')
      .values({
        key: input.key,
        value: sql`${valueJson}::jsonb`,
        updated_at_ms: input.nowMs,
        updated_by: input.actorUserId,
      })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: sql`${valueJson}::jsonb`,
          updated_at_ms: input.nowMs,
          updated_by: input.actorUserId,
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    // Payload shape matches packages/contract/event-schemas/
    // settings.updated.schema.json (A5: "payload: actor userId, key,
    // oldValue, newValue") — envelope.actorUserId already carries the actor
    // too (writeEvent's actorUserId arg below), but the payload repeats it
    // explicitly, same convention as restricted.locked's `userId` field, so
    // a consumer never needs to cross-reference the envelope to know who
    // acted.
    await writeEvent(trx, {
      type: 'settings.updated',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        actorUserId: input.actorUserId,
        key: input.key,
        oldValue,
        newValue: input.value,
      },
    });

    return { row, oldValue };
  });
}

/**
 * Redacted-sentinel sibling of upsertServerSettingAndEmit for A9's
 * provider-key audit events: the payload NEVER carries a real secret value
 * (status/read paths never return or log a key either, per A9) — `oldValue`/
 * `newValue` are always the literal string '[redacted]' regardless of what
 * actually changed, matching packages/contract/event-schemas/
 * settings.updated.schema.json's shared shape without a second schema file.
 * Does NOT touch server_settings (provider keys live in the keyring, never
 * here, per A9) — outbox-only.
 */
export async function emitRedactedSettingsUpdated(
  db: Kysely<DB>,
  input: { key: string; actorUserId: string; nowMs: number }
): Promise<void> {
  await withTransaction(db, async (trx) => {
    await writeEvent(trx, {
      type: 'settings.updated',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        actorUserId: input.actorUserId,
        key: input.key,
        oldValue: '[redacted]',
        newValue: '[redacted]',
      },
    });
  });
}
