// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/remote-posture.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7/RG4, S1 lane). RG4's adjudication:
// system_notices stays HUMAN-composed only (one-active-slot), so a posture
// regression/recovery is reported ONLY through the admin-only outbox
// events (posture.regressed/posture.recovered, packages/contract/
// event-schemas — schemas frozen at Wave 0) — never auto-composed into
// system_notices. This file is the two narrow, system-generated (no
// admin actor — ACTOR_FIELD_MAP maps both types to `[]`, actorUserId is
// always null here, same posture as plugin.health-changed's own
// system-generated writes) writers apps/server's background regression
// scheduler calls; it never touches system_notices at all.
//
// Lives in the PUBLIC barrel (src/index.ts), not @loombre/db/internal, for
// the same reason src/query/notices.ts/invites.ts do: this is instance-
// administration/audit data, not viewer-scoped catalog data, so wrapping it
// in applyGuard() would be both wrong and impossible.

import type { Kysely } from 'kysely';
import type { DB } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';

// Deliberately plain `string` for checkKey/grade below, not an imported
// union type: this package has no dependency on @loombre/shared anywhere
// else, and the closed sets (packages/shared/src/remote/posture-model.ts's
// PostureCheckKey/PostureGrade) are already pinned by event-schemas.spec.ts
// + the JSON Schema payload files, not by this file's own types.

export interface RecordPostureRegressedInput {
  checkKey: string;
  previousGrade: string;
  newGrade: string;
  regressedAtMs: number;
}

/** Writes ONE `posture.regressed` admin-only event. System-generated
 *  (the background regression scheduler, not a request handler) —
 *  actorUserId is always null, matching ACTOR_FIELD_MAP's `[]` entry for
 *  this type (no user-correlating identifier in the payload either). */
export async function recordPostureRegressedEvent(db: Kysely<DB>, input: RecordPostureRegressedInput): Promise<void> {
  await withTransaction(db, async (trx) => {
    await writeEvent(trx, {
      type: 'posture.regressed',
      tsMs: input.regressedAtMs,
      actorUserId: null,
      payload: {
        checkKey: input.checkKey,
        previousGrade: input.previousGrade,
        newGrade: input.newGrade,
        regressedAtMs: input.regressedAtMs,
      },
    });
  });
}

export interface RecordPostureRecoveredInput {
  checkKey: string;
  previousGrade: string;
  newGrade: string;
  recoveredAtMs: number;
}

/** The recovery-direction twin — see recordPostureRegressedEvent's doc
 *  comment for the shared reasoning. */
export async function recordPostureRecoveredEvent(db: Kysely<DB>, input: RecordPostureRecoveredInput): Promise<void> {
  await withTransaction(db, async (trx) => {
    await writeEvent(trx, {
      type: 'posture.recovered',
      tsMs: input.recoveredAtMs,
      actorUserId: null,
      payload: {
        checkKey: input.checkKey,
        previousGrade: input.previousGrade,
        newGrade: input.newGrade,
        recoveredAtMs: input.recoveredAtMs,
      },
    });
  });
}
