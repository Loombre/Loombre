// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/search.ts
//
// searchCatalog — full-text search over catalog_items.search_tsv PLUS a
// match on any credited person's or applied tag's name (a match on either
// surfaces the ITEM, docs/PLAN.md §6.4 task spec).
//
// tsquery function choice: websearch_to_tsquery('simple', q). 'simple' is
// mandatory — it is the exact config catalog_items.search_tsv was GENERATED
// with (migrations/0001_init.sql); any other config's tsquery would never
// match the generated column's tokens. websearch_to_tsquery (not
// plainto_tsquery/to_tsquery) is chosen because it is defined to NEVER
// raise a syntax error on arbitrary user input — stray quotes, dashes, or
// punctuation are absorbed as literal terms rather than throwing — which is
// exactly the property the adversarial "tsquery injection attempt string"
// test in packages/db/test/leak.spec.ts exercises: no q value should be
// able to turn `search_tsv @@ websearch_to_tsquery(...)` into a query error
// or a boolean-always-true predicate; websearch_to_tsquery's design (and
// binding q as a parameter, never string-concatenated) rules out both.
//
// Person/tag name matching uses a plain case-insensitive substring (ILIKE),
// backed by a pg_trgm GIN trigram index on `name::text` (migration 0008)
// — substring is the intuitive "search by actor name" UX, and the trigram
// index is what makes it index-backed rather than a sequential scan. The
// `::text` cast (both in the index expression AND in the WHERE clause
// below) matters: people.name/tags.name are CITEXT, whose own `~~*`
// (ILIKE) operator is distinct from plain text's — a query using the
// uncast citext operator silently never matches the expression index (see
// migration 0008's header for the empirical verification). The `q` value
// is bound as a parameter and its LIKE metacharacters are escaped (see
// likePattern below), so this is likewise immune to LIKE-pattern injection.
//
// Query SHAPE (gap-closure lane perf fix, exit-gate finding): the tsv
// match and the two person/tag EXISTS branches used to be OR'd together in
// a single WHERE clause. Postgres cannot generally pull a correlated
// EXISTS combined via OR into an index-backed join plan — it falls back to
// re-running the correlated subplan once per OUTER row of the
// guard-filtered catalog_items scan, which is fine at Phase-1's 29-item
// seed but breached the Tier-0 p95 <=100ms budget at the 50k-item seed
// (measured 147-159ms). Restructured as a UNION of three independently
// planned branches — tsv match, person-name match, tag-name match — each
// branch gets its own best plan (GIN full-text index; GIN trigram index
// via a normal join, not a per-row subplan) and Postgres dedupes the
// UNION the same way the original OR naturally deduped a row matching
// more than one branch (the projected columns, including `rank`, are a
// deterministic function of the row + q, so a row appearing in two
// branches produces byte-identical tuples that UNION's DISTINCT collapses
// into one — never UNION ALL here, that would double-count/paginate a
// multi-branch match twice).
//
// Guard mechanics (the restricted-person-on-general-item finding, see
// STATE.md / mission report): every branch applies `applyGuard(...)` —
// items the viewer cannot see are excluded before matching even runs. The
// person/tag branches are ADDITIONALLY gated by applyContentClassFilter on
// people.content_class / tags.content_class: neither people nor tags carry
// a trigger deriving content_class from the items they're credited/applied
// on (application-chosen, see seed.mjs), so a restricted-class person CAN
// be credited on an otherwise-general item. Without the extra join-level
// filter, searching for that person's name would surface the
// (individually visible) item to an uncleared viewer via a match on a
// person they have no clearance to know exists — the item guard alone
// does not catch this, because the item itself legitimately passes it.
// packages/db/test/leak.spec.ts proves both directions against seed.mjs's
// restrictedCameoPerformer fixture — unchanged by this restructuring
// (same applyGuard/applyContentClassFilter calls, just one call site per
// branch instead of one shared call site with three OR'd conditions).
//
// Ranking: ts_rank(search_tsv, tsquery) + a 0.5 title-prefix boost (ILIKE
// 'q%'), tiebroken by id for a fully deterministic order. Person/tag-only
// matches (no tsv hit) naturally rank at/near 0 and sort after title/tag
// hits, never dropped. Keyset-paginated on (rank, id), both descending,
// via a subquery so the rank expression can be filtered on in the cursor
// WHERE without recomputation drift between pages.

import { sql, type Kysely } from 'kysely';
import type { ContentClass, DB, ItemType } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyGuard } from './guard.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';

export interface SearchCatalogParams {
  q: string;
  cursor?: string;
  limit?: number;
  /**
   * Remediation adi-F2: restrict the page to this SET of item types. The
   * HTTP caller's SearchResult schema admits movie/series/artist/album/
   * track only (no season/episode), and filtering the page AFTER it was cut
   * spends the keyset LIMIT on rows that are then thrown away — short, and
   * at limit=1 routinely EMPTY, pages carrying a non-null `nextCursor`.
   * Applied below with the cursor predicate, i.e. BEFORE ORDER BY/LIMIT.
   *
   * An EMPTY array means "no type can match" (kysely renders `eb.or([])` as
   * `1 = 0`), never "no filter". Omit the key for "no filter".
   */
  itemTypes?: readonly ItemType[];
}

export interface SearchResultRow {
  id: string;
  title: string;
  itemType: ItemType;
  contentClass: ContentClass;
  addedAtMs: number;
  rank: number;
}

export interface SearchCatalogResult {
  rows: SearchResultRow[];
  nextCursor: string | null;
}

interface SearchCursorPayload {
  rank: number;
  id: string;
}

function isSearchCursorPayload(value: unknown): value is SearchCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).rank === 'number' &&
    isCursorRowId((value as Record<string, unknown>).id)
  );
}

const DEFAULT_LIMIT = 50;

function likeContainsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function likePrefixPattern(q: string): string {
  return `${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

type RankedRow = {
  id: string;
  title: string;
  itemType: ItemType;
  contentClass: ContentClass;
  addedAtMs: number;
  rank: number;
};

/** The rank formula, as a single raw expression reused verbatim by every
 *  UNION branch below (so a row matching more than one branch produces
 *  byte-identical tuples and collapses under UNION's DISTINCT — see module
 *  header). `rank` is safe to compute identically regardless of which
 *  branch matched: ts_rank returns 0 (not an error/NULL) for a
 *  tsvector/tsquery pair that doesn't match, so a person/tag-only match
 *  still gets a well-defined (typically 0, or 0.5 with the title-prefix
 *  boost) rank.
 *
 *  Each branch below repeats the identical `.select([...])` call rather
 *  than sharing it through a generic helper: guard.ts's own header
 *  explains why — Kysely's typed builder API (literal column-name
 *  strings like `'catalog_items.id as id'`) only type-checks against a
 *  CONCRETE table-union type, not an abstract generic TB, so a shared
 *  helper would need the same raw-sql-column-reference workaround
 *  guardPredicateSql uses. Three short, concrete, independently-typed
 *  call sites are simpler here than reintroducing that pattern for a
 *  five-column SELECT list. */
function rankExpr(q: string, prefixPattern: string) {
  return sql<number>`ts_rank(${sql.ref('catalog_items.search_tsv')}, websearch_to_tsquery('simple', ${q})) + (CASE WHEN ${sql.ref('catalog_items.title')} ILIKE ${prefixPattern} THEN 0.5 ELSE 0 END)`.as(
    'rank'
  );
}

export async function searchCatalog(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: SearchCatalogParams
): Promise<SearchCatalogResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const q = params.q;
  const containsPattern = likeContainsPattern(q);
  const prefixPattern = likePrefixPattern(q);

  const rank = rankExpr(q, prefixPattern);

  // Branch 1: full-text match on the item's own tsvector (GIN-indexed,
  // migrations/0001_init.sql).
  const tsvBranch = applyGuard(db.selectFrom('catalog_items'), ctx)
    .where(sql<boolean>`${sql.ref('catalog_items.search_tsv')} @@ websearch_to_tsquery('simple', ${q})`)
    .select([
      'catalog_items.id as id',
      'catalog_items.title as title',
      'catalog_items.item_type as itemType',
      'catalog_items.content_class as contentClass',
      'catalog_items.added_at_ms as addedAtMs',
      rank,
    ])
    .$castTo<RankedRow>();

  // Branch 2: credited-person name substring match (GIN trigram-indexed,
  // migration 0008 — see module header for the citext ::text cast note).
  const peopleBranch = applyContentClassFilter(
    applyGuard(
      db
        .selectFrom('catalog_items')
        .innerJoin('item_people', 'item_people.item_id', 'catalog_items.id')
        .innerJoin('people', 'people.id', 'item_people.person_id'),
      ctx
    ).where(sql<boolean>`${sql.ref('people.name')}::text ILIKE ${containsPattern}`),
    ctx,
    'people.content_class'
  )
    .select([
      'catalog_items.id as id',
      'catalog_items.title as title',
      'catalog_items.item_type as itemType',
      'catalog_items.content_class as contentClass',
      'catalog_items.added_at_ms as addedAtMs',
      rank,
    ])
    .$castTo<RankedRow>();

  // Branch 3: applied-tag name substring match — same shape as branch 2.
  const tagsBranch = applyContentClassFilter(
    applyGuard(
      db
        .selectFrom('catalog_items')
        .innerJoin('item_tags', 'item_tags.item_id', 'catalog_items.id')
        .innerJoin('tags', 'tags.id', 'item_tags.tag_id'),
      ctx
    ).where(sql<boolean>`${sql.ref('tags.name')}::text ILIKE ${containsPattern}`),
    ctx,
    'tags.content_class'
  )
    .select([
      'catalog_items.id as id',
      'catalog_items.title as title',
      'catalog_items.item_type as itemType',
      'catalog_items.content_class as contentClass',
      'catalog_items.added_at_ms as addedAtMs',
      rank,
    ])
    .$castTo<RankedRow>();

  const ranked = tsvBranch.union(peopleBranch).union(tagsBranch);

  let outer = db.selectFrom(ranked.as('ranked_items')).selectAll();

  // adi-F2: the eligible-type filter sits HERE, next to the cursor
  // predicate and above ORDER BY/LIMIT, rather than being repeated in each
  // UNION branch — one call site instead of three, on a plain output column
  // Postgres can push down into the set operation (the predicate is
  // immutable and references only a subquery output column, so
  // subquery_is_pushdown_safe admits it), and it cannot perturb the
  // branches' byte-identical tuples that UNION's DISTINCT collapses.
  // Verified, not assumed: EXPLAIN of this shape shows the predicate
  // recheck INSIDE both Append branches, index-driven off
  // catalog_items_type_sort_title_idx — the module header's UNION-perf
  // rationale is preserved (the filter narrows each branch, never
  // materializes the union first).
  if (params.itemTypes) {
    const itemTypes = params.itemTypes;
    outer = outer.where((eb) => eb.or(itemTypes.map((t) => eb('itemType', '=', t))));
  }

  if (params.cursor) {
    const { rank, id } = decodeCursor(params.cursor, isSearchCursorPayload);
    outer = outer.where((eb) =>
      eb.or([eb('rank', '<', rank), eb.and([eb('rank', '=', rank), eb('id', '<', id)])])
    );
  }

  const rows = await outer.orderBy('rank', 'desc').orderBy('id', 'desc').limit(limit).execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ rank: last.rank, id: last.id }) : null;

  return { rows, nextCursor };
}
