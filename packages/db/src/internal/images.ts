// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/images.ts

import type { Selectable } from 'kysely';
import type { ImagesTable } from '../types.js';
import type { DbOrTx } from './tx.js';

export type ImageRow = Selectable<ImagesTable>;

export interface UpsertImageInput {
  entityType: string;
  entityId: string;
  kind: ImagesTable['kind'];
  source: ImagesTable['source'];
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
  /** '#rrggbb' extracted alongside blurhash at ingest (P2.11) — omitted/
   *  undefined leaves the column NULL (migrations/0005), not '' (that
   *  sentinel is written only by the backfill consumer for an unreadable
   *  source file, never by the new-image ingest path). */
  dominantColor?: string | null;
  filePath: string;
  createdAtMs: number;
  /** Provider URL (`url:…`) or local path the set was rendered from
   *  (migrations/0046). Omitted/undefined leaves the column NULL
   *  ("unknown") — only the image consumer, which knows the source it
   *  just rendered, records it. */
  sourceRef?: string | null;
}

/**
 * Upsert on the images table's `(entity_type, entity_id, kind, width)`
 * unique constraint — one row per rendered size of a given image kind for
 * a given entity (0001_init.sql). The constraint is NULLS NOT DISTINCT
 * (0004) so the width-NULL "original" row is a real upsert target too.
 */
export async function upsertImage(db: DbOrTx, input: UpsertImageInput): Promise<ImageRow> {
  return db
    .insertInto('images')
    .values({
      entity_type: input.entityType,
      entity_id: input.entityId,
      kind: input.kind,
      source: input.source,
      width: input.width ?? null,
      height: input.height ?? null,
      blurhash: input.blurhash ?? null,
      dominant_color: input.dominantColor ?? null,
      file_path: input.filePath,
      created_at_ms: input.createdAtMs,
      source_ref: input.sourceRef ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['entity_type', 'entity_id', 'kind', 'width']).doUpdateSet({
        source: (eb) => eb.ref('excluded.source'),
        height: (eb) => eb.ref('excluded.height'),
        blurhash: (eb) => eb.ref('excluded.blurhash'),
        dominant_color: (eb) => eb.ref('excluded.dominant_color'),
        file_path: (eb) => eb.ref('excluded.file_path'),
        created_at_ms: (eb) => eb.ref('excluded.created_at_ms'),
        source_ref: (eb) => eb.ref('excluded.source_ref'),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * True if an "original" (width IS NULL) row already exists for
 * (entityType, entityId, kind) — the Stash mapper's (apps/worker/src/
 * stash/apply.ts) dedup guard for SHARED entities (performers/studios) a
 * full sync visits once per referencing scene: without this check, a
 * performer credited on N scenes would re-stage bytes and re-enqueue an
 * 'image' job N times per sync. Deliberately an EXISTENCE check, not a
 * checksum comparison — this module has no record of which Stash blob
 * checksum produced a given images row, so a changed Stash performer/
 * studio image after first ingest is a documented v1 gap (apply.ts's
 * header), not something this helper detects.
 */
export async function hasOriginalImage(db: DbOrTx, entityType: string, entityId: string, kind: ImagesTable['kind']): Promise<boolean> {
  const row = await db
    .selectFrom('images')
    .select('id')
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .where('kind', '=', kind)
    .where('width', 'is', null)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The "original" (width IS NULL) row for (entityType, entityId, kind), or
 * undefined when none exists — the image consumer's (apps/worker/src/
 * image/consumer.ts) stable-identity read: it compares the row's
 * `source_ref` against the source it is about to render and skips the
 * download + re-encode when they match and the file is still on disk.
 * Distinct from `hasOriginalImage` (existence only, for the Stash
 * mapper) because the caller needs `source_ref` and `file_path`.
 */
export async function getOriginalImageForKind(
  db: DbOrTx,
  entityType: string,
  entityId: string,
  kind: ImagesTable['kind']
): Promise<Pick<ImageRow, 'id' | 'file_path' | 'source_ref'> | undefined> {
  return db
    .selectFrom('images')
    .select(['id', 'file_path', 'source_ref'])
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .where('kind', '=', kind)
    .where('width', 'is', null)
    .executeTakeFirst();
}

/**
 * Deletes the image rows for an entity with the given sources (clear-match:
 * `['provider']` — a wrong match's poster/backdrop/logo, never the folder
 * art a scan found or an embedded cover) and returns their file paths so
 * the caller can unlink the files best-effort AFTER the transaction.
 */
export async function deleteImagesForEntity(
  db: DbOrTx,
  entityType: string,
  entityId: string,
  sources: readonly ImagesTable['source'][]
): Promise<string[]> {
  if (sources.length === 0) return [];
  const rows = await db
    .deleteFrom('images')
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .where('source', 'in', sources as ImagesTable['source'][])
    .returning('file_path')
    .execute();
  return rows.map((r) => r.file_path);
}

// ============================================================================
// One-time dominant_color backfill (P2.11) — worker-only queries backing
// apps/worker/src/image/backfill-consumer.ts. Only the width-NULL
// "original" row per (entity_type, entity_id, kind) is selected for
// decoding; the matching variant rows are updated in the same pass by
// copying the original's value (no re-decode per width).
// ============================================================================

export interface ImageNeedingDominantColorRow {
  id: string;
  entity_type: string;
  entity_id: string;
  kind: ImagesTable['kind'];
  file_path: string;
}

/**
 * Id-ordered, cursor-paginated batch of original (width IS NULL) rows still
 * missing a dominant_color (NULL — never '', which is the "computed but
 * unavailable" sentinel and must never be re-selected). `afterId` is the
 * last-processed id from the previous batch (null for the first page).
 */
export async function listImagesNeedingDominantColor(
  db: DbOrTx,
  opts: { afterId: string | null; limit: number }
): Promise<ImageNeedingDominantColorRow[]> {
  let query = db
    .selectFrom('images')
    .select(['id', 'entity_type', 'entity_id', 'kind', 'file_path'])
    .where('width', 'is', null)
    .where('dominant_color', 'is', null)
    .orderBy('id', 'asc')
    .limit(opts.limit);

  if (opts.afterId !== null) {
    query = query.where('id', '>', opts.afterId);
  }

  return query.execute();
}

/** Writes the extracted (or sentinel '') dominant_color onto exactly the
 *  original row identified by `id`. */
export async function setImageDominantColor(db: DbOrTx, id: string, dominantColor: string): Promise<void> {
  await db.updateTable('images').set({ dominant_color: dominantColor }).where('id', '=', id).execute();
}

/** Copies an already-resolved dominant_color onto every variant row
 *  (width IS NOT NULL) of the same (entity_type, entity_id, kind) still
 *  missing one — the "variant rows can copy the original's color" rule. */
export async function copyDominantColorToVariants(
  db: DbOrTx,
  input: { entityType: string; entityId: string; kind: ImagesTable['kind']; dominantColor: string }
): Promise<void> {
  await db
    .updateTable('images')
    .set({ dominant_color: input.dominantColor })
    .where('entity_type', '=', input.entityType)
    .where('entity_id', '=', input.entityId)
    .where('kind', '=', input.kind)
    .where('width', 'is not', null)
    .where('dominant_color', 'is', null)
    .execute();
}
