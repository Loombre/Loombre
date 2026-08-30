// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/guard.ts
//
// The wrapping mechanism (docs/PLAN.md §6.4): every catalog read compiles in
// a library-membership filter AND, unless every one of the five restricted-
// content gates has passed, a `content_class = 'general'` filter. This
// module is intentionally NOT exported from the package barrel — see
// src/index.ts. The only way another module in this package (and nothing
// outside it, per the dependency-cruiser rule at the repo root) can read
// catalog_items is through a function in src/query/* that calls this.

import { sql, type RawBuilder, type ReferenceExpression, type SelectQueryBuilder } from 'kysely';
import type { DB } from '../types.js';
import type { ViewerContext } from '../context.js';

/**
 * Applies the mandatory restricted-content guard to a query over
 * `catalog_items`. Always compiles in:
 *   1. `library_id IN (ctx.allowedLibraryIds)` — or an unsatisfiable
 *      `false` predicate when the caller has no allowed libraries at all,
 *      rather than emitting `IN ()` (invalid SQL) or, worse, no filter.
 *   2. `content_class = 'general'`, UNLESS `ctx.restrictedCleared` is true.
 *   3. Missing-file visibility (docs/PLAN.md §8.2, P1.2): an item whose
 *      media_files rows ALL have `missing_since_ms` set (a mount drop, or a
 *      file the scanner hasn't seen on its last full pass) is hidden from
 *      every guarded read, without waiting for the 72h hard-cascade sweep —
 *      that sweep only ever deletes rows, it is not what makes a dropped
 *      mount's items disappear. An item with NO media_files rows at all
 *      (series/season/artist/album container items, which never own files
 *      directly — only their leaf children do) is unaffected by this
 *      clause: "zero files" is not the same condition as "all files
 *      missing", and container items must stay visible regardless of their
 *      children's file state.
 *
 * There is no parameter or code path that skips any of these filters — an
 * "unfiltered" call to this function does not exist.
 *
 * Signature note: `TB` is generic (constrained only to `keyof DB & string`,
 * not literally `'catalog_items'`) so this same function can be called on
 * a `catalog_items` query that has OTHER tables joined into it too. The
 * implementation below builds its predicate as a single raw `sql<boolean>`
 * fragment (guardPredicateSql) rather than Kysely's typed builder API for
 * exactly this reason: Kysely's typed string column references (e.g.
 * `.where('catalog_items.library_id', ...)`) can only be checked against a
 * CONCRETE table-union type, not an abstract generic `TB` — inside a
 * generic function body `TB` is still abstract, so the typed-builder form
 * does not compile here even though it works fine at every call site. Raw
 * `sql.ref('catalog_items.library_id')` sidesteps that: it is an unchecked
 * (but still safely quoted/escaped) identifier reference, appropriate here
 * because the column names are fixed literals this module owns, never
 * caller/user input. This is what also lets applyGuardToJoined() below
 * reuse the EXACT same predicate for a correlated EXISTS subquery instead
 * of re-deriving it — the one place drift could otherwise creep in.
 */
// Missing-file visibility (docs/PLAN.md §8.2, P1.2): an item whose
// media_files rows ALL have missing_since_ms set (a mount drop, or a file
// the scanner hasn't seen on its last full pass) is hidden from every
// guarded read, without waiting for the 72h hard-cascade sweep — that sweep
// only ever deletes rows, it is not what makes a dropped mount's items
// disappear. An item with NO media_files rows at all (series/season/artist/
// album container items, which never own files directly — only their leaf
// children do) is unaffected: "zero files" is not the same condition as
// "all files missing".
//
// Factored out of guardPredicateSql (below) into its own named function,
// rather than inlined, so applyNotMissingFilesFilter (this module's public
// barrel further down) can reuse the EXACT same fragment for a read path
// that needs this rule WITHOUT guardPredicateSql's other two clauses — see
// that function's own doc comment for why (the restricted zone aggregate
// count, src/query/restricted-zone.ts, deliberately does not route through
// ctx.restrictedCleared at all). Single source of truth either way: this is
// the only place the SQL fragment is written.
function missingFileClauseSql() {
  return sql<boolean>`(
    NOT EXISTS (SELECT 1 FROM media_files WHERE media_files.item_id = ${sql.ref('catalog_items.id')})
    OR EXISTS (SELECT 1 FROM media_files WHERE media_files.item_id = ${sql.ref('catalog_items.id')} AND media_files.missing_since_ms IS NULL)
  )`;
}

/**
 * The ONE place "may restricted rows reach this caller" is decided (RZI
 * surface scoping, docs/PLAN.md §6.4 as amended 2026-08-30): full five-gate
 * clearance AND a restricted surface, never clearance alone. Both the
 * catalog_items class clause (guardPredicateSql below) and the people/tags
 * class isolation (applyContentClassFilter below) key off this same
 * function, so the two halves of content_class enforcement cannot drift.
 */
function restrictedRowsVisible(ctx: ViewerContext): boolean {
  return ctx.restrictedCleared && ctx.surface === 'restricted';
}

function guardPredicateSql(ctx: ViewerContext) {
  const libraryClause =
    ctx.allowedLibraryIds.length === 0
      ? sql<boolean>`false`
      : sql<boolean>`${sql.ref('catalog_items.library_id')} = ANY(${ctx.allowedLibraryIds}::uuid[])`;

  const contentClassClause = restrictedRowsVisible(ctx)
    ? sql<boolean>`true`
    : sql<boolean>`${sql.ref('catalog_items.content_class')} = 'general'`;

  return sql<boolean>`((${libraryClause}) AND (${contentClassClause}) AND ${missingFileClauseSql()})`;
}

export function applyGuard<TB extends keyof DB & string, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  ctx: ViewerContext
): SelectQueryBuilder<DB, TB, O> {
  return qb.where(guardPredicateSql(ctx));
}

// ============================================================================
// Extensions for non-catalog_items guarded reads (Phase 1 leak-suite wave).
//
// applyGuard() above is deliberately narrow: it only knows how to filter a
// query whose FROM is exactly `catalog_items`. Every other guarded surface
// (search's people/tags joins, listPeople/listTags, continue-watching,
// progress, images, events, export) needs the SAME two clauses — library
// membership and content_class isolation — applied to a DIFFERENT base
// table, or needs to ask "is the item this OTHER row references visible to
// ctx at all" from inside a join/EXISTS. The three functions below are that
// single choke-point, generalized:
//
//   - applyGuardToJoined: the correlated-EXISTS form of applyGuard itself
//     (built from the SAME guardPredicateSql helper applyGuard() itself
//     calls, so it can never drift from applyGuard's semantics, including
//     the missing-file rule) — used by every table that references an item
//     by id but isn't catalog_items (item_people, item_tags, progress,
//     event payloads).
//   - applyLibraryIdFilter: the library-membership half of applyGuard's two
//     clauses, generalized to any table/column (the `libraries` table
//     itself — images' 'library' entity branch, export's library listing).
//   - applyContentClassFilter: the content_class-isolation half, generalized
//     the same way (the `people`/`tags` tables' OWN content_class, via the
//     applyGuardToPeople/applyGuardToTags wrappers below).
// ============================================================================

/**
 * Correlated-EXISTS form of applyGuard(): TRUE iff the catalog_items row
 * referenced by `itemIdColumn` (a column on some OTHER table/join, e.g.
 * `'item_people.item_id'` or `'progress.item_id'`, or — for a computed
 * reference like an event payload's `payload->>'itemId'` — a `sql<...>`
 * fragment) is visible to `ctx` under the exact same rules applyGuard()
 * enforces on catalog_items directly (built from the SAME guardPredicateSql
 * helper — see applyGuard's header for why this is raw SQL rather than
 * Kysely's typed builder API). Returns a plain `Expression<boolean>`, so
 * callers pass it straight to `.where(...)` — no `(eb) => ...` wrapper
 * needed, and no dependency on the caller's own table-union type.
 */
export function applyGuardToJoined(
  ctx: ViewerContext,
  itemIdColumn: string | RawBuilder<unknown>
) {
  const itemIdRef = typeof itemIdColumn === 'string' ? sql.ref(itemIdColumn) : itemIdColumn;
  return sql<boolean>`EXISTS (
    SELECT 1 FROM catalog_items
    WHERE catalog_items.id = ${itemIdRef}
    AND ${guardPredicateSql(ctx)}
  )`;
}

/**
 * The library-membership half of applyGuard's two clauses, generalized to
 * any query/column — `WHERE <column> IN ctx.allowedLibraryIds`, or the
 * unsatisfiable `WHERE false` when the caller has no allowed libraries at
 * all (never a bare `IN ()`, mirroring applyGuard's own empty-set handling).
 */
export function applyLibraryIdFilter<TB extends keyof DB & string, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  ctx: ViewerContext,
  column: ReferenceExpression<DB, TB>
): SelectQueryBuilder<DB, TB, O> {
  return ctx.allowedLibraryIds.length === 0
    ? qb.where(sql<boolean>`false`)
    : qb.where(column, 'in', ctx.allowedLibraryIds);
}

/**
 * The content_class-isolation half of applyGuard's two clauses, generalized
 * to any query/column — `WHERE <column> = 'general'` unless
 * restrictedRowsVisible(ctx) (clearance AND a restricted surface — see that
 * function's doc comment). Used directly by callers that join in
 * `people`/`tags` as a foreign table (search's match clauses), and via the
 * applyGuardToPeople/applyGuardToTags wrappers below when people/tags is
 * itself the query's base table.
 */
export function applyContentClassFilter<TB extends keyof DB & string, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  ctx: ViewerContext,
  column: ReferenceExpression<DB, TB>
): SelectQueryBuilder<DB, TB, O> {
  return restrictedRowsVisible(ctx) ? qb : qb.where(column, '=', 'general');
}

/** applyContentClassFilter specialized to the `people` table as the query's
 *  base table (docs/PLAN.md §6.4 metadata isolation) — listPeople /
 *  getPersonById's content_class half; the "credited on >=1 visible item"
 *  half is applyGuardToJoined against item_people.item_id, composed by the
 *  callers in src/query/people.ts. */
export function applyGuardToPeople<O>(
  qb: SelectQueryBuilder<DB, 'people', O>,
  ctx: ViewerContext
): SelectQueryBuilder<DB, 'people', O> {
  return applyContentClassFilter(qb, ctx, 'people.content_class');
}

/** applyContentClassFilter specialized to the `tags` table — see
 *  applyGuardToPeople above; src/query/tags.ts is the tag-side analogue. */
export function applyGuardToTags<O>(
  qb: SelectQueryBuilder<DB, 'tags', O>,
  ctx: ViewerContext
): SelectQueryBuilder<DB, 'tags', O> {
  return applyContentClassFilter(qb, ctx, 'tags.content_class');
}

/**
 * The missing-file visibility rule alone (docs/PLAN.md §8.2/P1.2) —
 * guardPredicateSql's third clause, decomposed out the same way
 * applyLibraryIdFilter/applyContentClassFilter decompose its first two,
 * for a read path over `catalog_items` that needs EXACTLY this rule
 * WITHOUT applyGuard's ctx.restrictedCleared-driven content_class branch.
 * Currently one caller: src/query/restricted-zone.ts's
 * getRestrictedZoneCountForViewer, which is deliberately visible to
 * entitled viewers "regardless of lock state" (design/phosphor README's
 * U10 disclosure) — it computes library membership itself (the entitled
 * subset of ctx.allowedLibraryIds that are actually restricted libraries)
 * and applies its own explicit `content_class = 'restricted'` predicate,
 * so it cannot route through a ViewerContext's restrictedCleared branch at
 * all; it still needs the SAME missing-file rule every other guarded read
 * enforces, from the SAME source (missingFileClauseSql) applyGuard itself
 * uses, so the two can never drift apart.
 */
export function applyNotMissingFilesFilter<TB extends keyof DB & string, O>(
  qb: SelectQueryBuilder<DB, TB, O>
): SelectQueryBuilder<DB, TB, O> {
  return qb.where(missingFileClauseSql());
}
