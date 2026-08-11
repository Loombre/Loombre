// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/remote-direct.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5/R8/RG15, this lane's own mission —
// no migration number is reserved for Direct's own state, deliberately:
// "prefer deriving/storing via the settings rows themselves + a minimal
// state record only if unavoidable"). This IS that minimal state record —
// ONE extra row in the ALREADY-EXISTING server_settings table
// (migrations/0013_server_settings.sql), under a housekeeping key that is
// NOT part of packages/shared/src/settings-registry.ts's public
// SETTINGS_REGISTRY, so it never appears in GET /admin/settings or accepts
// a write through PUT /admin/settings/{key} — those are registry-validated
// surfaces (apps/server/src/settings/settings.service.ts), and this key is
// deliberately outside that surface, the same way provider keys/mail
// credentials live in the keyring rather than as a registry entry. No new
// table, no new migration: server_settings already accepts ANY string key
// (its own migration's header: "no CHECK constraint enumerating valid
// keys, deliberately"), and this module reuses that exact JSONB row shape.
//
// WHAT THIS RECORDS, and why it can't be derived from tls.mode/
// network.trustProxy alone:
//   - `enabled`/`mode` — whether Direct is the admin-selected active path
//     and which sub-mode (RG15: the derived RemotePathId still needs SOME
//     subsystem to say "I am the reason no path is 'none'"; tls.mode='acme'
//     alone can't distinguish "Direct path enabled via the wizard" from an
//     operator who set LOOMBRE_TLS_MODE=acme by hand years before this
//     feature existed and never touched the wizard).
//   - `preEnableTlsMode`/`preEnableTrustProxy` — the mission's own
//     "disableRemoteDirect reverts tls.mode/trust-proxy to their pre-enable
//     values" requirement: a snapshot taken at enable time, restored at
//     disable time. Neither settings.service.ts's own history (it has none
//     — server_settings stores only the CURRENT value per key) nor the
//     outbox (audit trail, not a restore point) can answer "what was this
//     BEFORE Direct's own enable call changed it" without this row.
//
// Deliberately registry-UNAWARE (same posture as src/query/settings.ts's
// own header): this module never imports @loombre/shared, never validates
// against SETTINGS_REGISTRY — that is the CALLER's job (apps/server/src/
// remote/remote-direct.controller.ts, which validates its own request DTOs
// and calls @loombre/shared's SettingsService separately for the REAL
// tls.*/network.trustProxy commits). This module's own value shape
// (RemoteDirectInternalState) is validated only by TypeScript at the
// call site — there is no external admin-facing writer to defend against.
//
// EVENT EMISSION (mission: "outbox remote.enabled {path:'direct'} +
// remote.path.changed same-trx" — GROUND-TRUTHED AND CORRECTED against the
// FROZEN event-schema files, not the mission prose): packages/contract/
// event-schemas/remote.enabled.schema.json's payload is `{enabledAtMs}`
// ONLY (no `path` field), and its own description ties it explicitly to
// "the embedded userspace WireGuard listener" (R1's "Loombre Remote" IS
// the WireGuard path's proper noun, distinct from Tunnel/Direct) —
// apps/worker/src/plugin-delivery/actor-field-map.ts's frozen
// ACTOR_FIELD_MAP confirms the same shape ("remote.enabled"/"remote.disabled"
// name only timestamps). Direct's own enable/disable therefore emits
// `remote.path.changed` ONLY (previousPath/newPath/changedAtMs,
// packages/contract/event-schemas/remote.path.changed.schema.json) — never
// `remote.enabled`/`remote.disabled`, which stay WireGuard-exclusive per
// their own frozen schema. Flagged in this lane's final report for
// orchestrator reconciliation against STATE.md's freeze-note prose (which
// assumed remote.enabled/disabled carried a path field) and against
// whichever lane implements the Tunnel path's own enable/disable (T1),
// which likely has the identical question.

import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';
import { REMOTE_DIRECT_STATE_KEY, withRemotePathEnableGuard, type RemotePathIdValue } from './remote-path-guard.js';

/** Not part of SETTINGS_REGISTRY — see this file's header. The literal
 *  itself lives in src/query/remote-path-guard.ts, which must read this row
 *  without importing this module (dependency-cruiser's no-circular rule is
 *  error-severity, and this module imports the guard). One literal, two
 *  readers. */
const DIRECT_STATE_KEY = REMOTE_DIRECT_STATE_KEY;

export type RemoteDirectMode = 'acme' | 'reverse-proxy';

/** Canonical name for the union; declared alongside the guard for the same
 *  no-circular reason as DIRECT_STATE_KEY above. */
export type RemotePathId = RemotePathIdValue;

export interface RemoteDirectInternalState {
  enabled: boolean;
  mode: RemoteDirectMode | null;
  /** tls.mode's effective value immediately before this enable call — null
   *  when disabled (nothing to revert to). */
  preEnableTlsMode: string | null;
  /** network.trustProxy's effective value immediately before this enable
   *  call — null when disabled. Empty string ("") is a legal snapshot (the
   *  pre-enable value WAS unset) and is distinct from null (never enabled
   *  at all) — callers must check `enabled`, not merely non-null, before
   *  treating this as "the value to restore". */
  preEnableTrustProxy: string | null;
}

export const REMOTE_DIRECT_DISABLED_STATE: Readonly<RemoteDirectInternalState> = {
  enabled: false,
  mode: null,
  preEnableTlsMode: null,
  preEnableTrustProxy: null,
};

/** Reads the current internal state row — REMOTE_DIRECT_DISABLED_STATE
 *  (never a thrown/undefined signal) when no row has EVER been written yet,
 *  the exact same "absence of a row means the default" convention
 *  src/query/settings.ts's own table-level COMMENT documents for every
 *  other server_settings key. */
export async function getRemoteDirectInternalState(db: Kysely<DB>): Promise<RemoteDirectInternalState> {
  const row = await db
    .selectFrom('server_settings')
    .select('value')
    .where('key', '=', DIRECT_STATE_KEY)
    .executeTakeFirst();
  if (!row) return REMOTE_DIRECT_DISABLED_STATE;
  // Trusted cast: the ONLY writer of this key is upsertDirectStateRow below,
  // in this same file — no external admin-facing surface can reach this
  // row (see header), so there is no untrusted-shape case to defend against
  // the way settings.ts must for registry-key rows.
  return row.value as RemoteDirectInternalState;
}

async function upsertDirectStateRow(
  trx: Transaction<DB>,
  value: RemoteDirectInternalState,
  actorUserId: string,
  nowMs: number,
): Promise<void> {
  const json = JSON.stringify(value);
  await trx
    .insertInto('server_settings')
    .values({
      key: DIRECT_STATE_KEY,
      value: sql`${json}::jsonb`,
      updated_at_ms: nowMs,
      updated_by: actorUserId,
    })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        value: sql`${json}::jsonb`,
        updated_at_ms: nowMs,
        updated_by: actorUserId,
      }),
    )
    .execute();
}

export interface EnableRemoteDirectStateInput {
  mode: RemoteDirectMode;
  preEnableTlsMode: string;
  preEnableTrustProxy: string;
  previousActivePath: RemotePathId;
  actorUserId: string;
  nowMs: number;
}

/** ONE transaction: persists the new internal-state row AND emits exactly
 *  one `remote.path.changed` event (previousPath -> 'direct') — the
 *  mission's "outbox ... + remote.path.changed same-trx" requirement,
 *  corrected to the single real event type per this file's header.
 *
 *  LD-9: that transaction is now the guarded one (withRemotePathEnableGuard)
 *  — it throws RemotePathConflictError, writing and emitting nothing, if
 *  another remote-access path is enabled by the time it commits. See
 *  src/query/remote-path-guard.ts's design note. */
export async function enableRemoteDirectStateAndEmit(db: Kysely<DB>, input: EnableRemoteDirectStateInput): Promise<void> {
  await withRemotePathEnableGuard(db, 'direct', async (trx) => {
    await upsertDirectStateRow(
      trx,
      {
        enabled: true,
        mode: input.mode,
        preEnableTlsMode: input.preEnableTlsMode,
        preEnableTrustProxy: input.preEnableTrustProxy,
      },
      input.actorUserId,
      input.nowMs,
    );
    await writeEvent(trx, {
      type: 'remote.path.changed',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { previousPath: input.previousActivePath, newPath: 'direct', changedAtMs: input.nowMs },
    });
  });
}

// isRemoteWireguardActive used to live here (D1's own best-effort, WG-only,
// defensively-raw-SQL 409 ground truth — see this lane's original report:
// "409-check covers WG only (integration extends via canonical
// resolveActivePath, assigned to WG2)"). REMOVED by WG2 (STATE.md RG15
// integration unification): superseded by the canonical
// packages/db/src/query/remote-active-path.ts resolveActivePath(), which
// checks ALL THREE subsystems (not WG only) via the REAL typed DB
// interface (not raw defensive SQL — every table it reads now genuinely
// exists in this package's own `DB` type, unlike at D1's isolated-worktree
// dispatch time). apps/server/src/remote/remote-direct.controller.ts's own
// 409 check now goes through the injected RemoteActivePathReader token
// instead of calling this function.

export interface DisableRemoteDirectStateInput {
  actorUserId: string;
  nowMs: number;
}

/** ONE transaction: resets the internal-state row to disabled AND emits
 *  exactly one `remote.path.changed` event ('direct' -> 'none'). Callers
 *  must have ALREADY reverted tls.mode/network.trustProxy via
 *  SettingsService (separate, already-atomic-per-key writes — see this
 *  file's header) before calling this; it does not touch those keys. */
export async function disableRemoteDirectStateAndEmit(db: Kysely<DB>, input: DisableRemoteDirectStateInput): Promise<void> {
  await withTransaction(db, async (trx) => {
    await upsertDirectStateRow(trx, REMOTE_DIRECT_DISABLED_STATE, input.actorUserId, input.nowMs);
    await writeEvent(trx, {
      type: 'remote.path.changed',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { previousPath: 'direct', newPath: 'none', changedAtMs: input.nowMs },
    });
  });
}
