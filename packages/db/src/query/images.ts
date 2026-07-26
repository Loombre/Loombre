// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/images.ts
//
// getImageEntityAccess — the single authorization choke-point the future
// image-serving endpoint (`GET /v1/images/{entityType}/{id}/{kind}`) must
// call before streaming bytes (leak todo 4, docs/PLAN.md §6.4: "the image
// endpoint checks the owning entity's content_class before serving, for
// EVERY image kind"). `images` is a deliberately polymorphic table (no FK
// on entity_id — migrations/0001_init.sql comment) covering four owning
// entity kinds today; each gets its own visibility rule, all built from the
// same guard.ts primitives so none of the four can silently diverge from
// the catalog_items guard's semantics:
//
//   - 'catalog_item': the owning item must pass applyGuard() directly.
//   - 'person' / 'tag': content_class isolation (applyGuardToPeople/Tags)
//     AND credited-on/applied-to >=1 item visible to ctx
//     (applyGuardToJoined) — identical to listPeople/listTags's rule, so an
//     image can never be fetched for a person/tag that couldn't otherwise
//     be discovered through browse/search.
//   - 'library': membership in ctx.allowedLibraryIds. The task spec states
//     this branch as membership alone; this implementation additionally
//     requires content_class = 'general' unless ctx.restrictedCleared
//     (mirroring every other branch and library.created's event-visibility
//     rule) — DECISION BEYOND SPEC: without it, a viewer who holds gate 4
//     (explicit library permission) but has not passed gate 5 (live
//     session unlock) — see test/leak.spec.ts's `adminClearedButNotUnlocked`
//     context — would still see a restricted library's own image (e.g. its
//     backdrop), which is exactly the gate-5-bypass leak getItemById's
//     existing test already guards against for items. Keeping "library
//     permission without live unlock" leak-free for images as well as items
//     was judged to be what the spec intended, not an oversight to
//     preserve.
//
// entity_type values accepted here — 'catalog_item' | 'person' | 'tag' |
// 'library' — match what packages/db/seed/seed.mjs and
// src/internal/images.ts already write into the images.entity_type column
// today. This is a separate vocabulary from the OpenAPI contract's
// ImageEntityType enum (movie|series|season|episode|artist|album|track,
// packages/contract/openapi.yaml) used on the REST path parameter — mapping
// a contract-level item_type down to the 'catalog_item' entityType this
// function expects is the future image controller's job (apps/server, out
// of this package's surface), not this query layer's.

import type { Kysely, Selectable } from 'kysely';
import type { DB, ImagesTable } from '../types.js';
import type { ViewerContext } from '../context.js';
import {
  applyContentClassFilter,
  applyGuard,
  applyGuardToJoined,
  applyGuardToPeople,
  applyGuardToTags,
  applyLibraryIdFilter,
} from './guard.js';

export type ImageRow = Selectable<ImagesTable>;

export type ImageEntityType = 'catalog_item' | 'person' | 'tag' | 'library';

export interface GetImageEntityAccessParams {
  entityType: ImageEntityType;
  entityId: string;
}

async function isEntityVisible(
  db: Kysely<DB>,
  ctx: ViewerContext,
  entityType: ImageEntityType,
  entityId: string
): Promise<boolean> {
  switch (entityType) {
    case 'catalog_item': {
      const row = await applyGuard(
        db.selectFrom('catalog_items').select('catalog_items.id'),
        ctx
      )
        .where('catalog_items.id', '=', entityId)
        .executeTakeFirst();
      return row !== undefined;
    }
    case 'person': {
      const row = await applyGuardToPeople(db.selectFrom('people'), ctx)
        .innerJoin('item_people', 'item_people.person_id', 'people.id')
        .where('people.id', '=', entityId)
        .where(applyGuardToJoined(ctx, 'item_people.item_id'))
        .select('people.id')
        .executeTakeFirst();
      return row !== undefined;
    }
    case 'tag': {
      const row = await applyGuardToTags(db.selectFrom('tags'), ctx)
        .innerJoin('item_tags', 'item_tags.tag_id', 'tags.id')
        .where('tags.id', '=', entityId)
        .where(applyGuardToJoined(ctx, 'item_tags.item_id'))
        .select('tags.id')
        .executeTakeFirst();
      return row !== undefined;
    }
    case 'library': {
      const row = await applyContentClassFilter(
        applyLibraryIdFilter(db.selectFrom('libraries'), ctx, 'libraries.id'),
        ctx,
        'libraries.content_class'
      )
        .where('libraries.id', '=', entityId)
        .select('libraries.id')
        .executeTakeFirst();
      return row !== undefined;
    }
  }
}

/**
 * Returns every image row for `(entityType, entityId)` if — and only if —
 * the owning entity is visible to ctx; an empty array otherwise
 * (indistinguishable from "no images exist", matching getItemById's
 * existence-hiding contract in src/query/items.ts).
 */
export async function getImageEntityAccess(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: GetImageEntityAccessParams
): Promise<ImageRow[]> {
  const visible = await isEntityVisible(db, ctx, params.entityType, params.entityId);
  if (!visible) return [];

  return db
    .selectFrom('images')
    .selectAll()
    .where('entity_type', '=', params.entityType)
    .where('entity_id', '=', params.entityId)
    .execute();
}
