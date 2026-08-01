# Architecture: Catalog, query guard & restricted content

<!-- Sourcing: ViewerContext (userId, allowedLibraryIds, restrictedCleared)
     — packages/db/src/context.ts:9-24. guardPredicateSql / applyGuard —
     packages/db/src/query/guard.ts:80-98 (library-membership + content-
     class + missing-file-visibility predicate; applyGuard as sole
     entry point; guard.ts not exported from packages/db/src/index.ts's
     barrel — only pre-guarded functions like getItemById/listItems are).
     applyGuardToJoined/applyLibraryIdFilter/applyContentClassFilter/
     applyGuardToPeople/applyGuardToTags — same file, generalized variants
     for joined tables, people, and tags. dependency-cruiser rules —
     .dependency-cruiser.cjs: no-raw-db-driver-outside-packages-db (105-112),
     pg-boss-outside-jobs-forbidden (113-120), no-internal-db-outside-worker
     (142-153). Five-gate restricted model — docs/PLAN.md §6.4. Satellite
     tables / thin catalog_items core — docs/PLAN.md §5, pain-point P1. -->

## The shape of the catalog

`catalog_items` is a deliberately thin, polymorphic core table — fields
every media type shares. Type-specific data lives in **satellite tables**
(a movie's runtime, a track's album, an episode's season/episode number),
joined by id rather than crammed into one god-object table. Adding a new
media type is additive: a new `item_type` enum value plus one satellite
table, no changes to existing tables or queries — the direct payoff of
choosing this shape over the inheritance-tree model Loombre's design
explicitly reacts against (docs/PLAN.md's pain-point ledger, P1).

## The guard: why an unfiltered query can't exist

```
                    every catalog read
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │      packages/db/src/query/*.ts       │
        │  (getItemById, listItems, search, …)  │
        │                                        │
        │   requires a ViewerContext:             │
        │     { userId,                           │
        │       allowedLibraryIds,                │
        │       restrictedCleared }               │
        └──────────────────┬───────────────────┘
                            │  applyGuard(ctx)
                            ▼
        ┌─────────────────────────────────────┐
        │   guard.ts's predicate, appended to    │
        │   EVERY query — not called by each      │
        │   query author, applied once at the     │
        │   query-builder layer:                  │
        │     library_id = ANY(allowedLibraryIds) │
        │     AND (content_class = 'general'      │
        │          OR restrictedCleared)          │
        │     AND <missing-file visibility>       │
        └──────────────────┬───────────────────┘
                            │
                            ▼
                  filtered rows only — no caller
                  can construct a query that skips
                  this step; guard.ts itself is not
                  exported from the package's public
                  barrel, only already-guarded query
                  functions are.
```

Two structural facts make "forgot to filter" impossible rather than
merely unlikely:

1. **`guard.ts` isn't part of the public API of `packages/db`.** Only
   functions that already call `applyGuard()` (or its joined/people/tags
   variants) internally are exported — there is no raw query-builder
   handle a consumer package could obtain and misuse.
2. **dependency-cruiser forbids the alternative entirely.** No `pg` or
   `kysely` import is allowed outside `packages/db` (rule
   `no-raw-db-driver-outside-packages-db`), so bypassing the query layer
   by talking to Postgres directly from `apps/server` isn't a lint
   nitpick — it's a build failure. A companion rule restricts `pg-boss`
   itself to `packages/jobs`, and another restricts the guard-free
   `@loombre/db/internal` writer surface (used by the scanner and job
   consumers, which need to write catalog rows without a viewer in the
   loop) to `apps/worker`, `packages/jobs`, and `packages/db` only.

## Restricted content

The `restricted-content` class is gated by five conditions that must ALL
hold before a restricted row is ever sent to a client — server capability
enabled, the user is an adult, the user has opted in with their own PIN,
an explicit per-library permission grant, and a currently-unlocked session
(re-verified on every request, never persisted across logins). Full detail
in docs/PLAN.md §6.4 (internal spec — see this repo). The user-facing
version of the same model, in plain language, is the
[User Guide's restricted content page](../../user-guide/restricted-content.md);
the admin-facing version is
[Users & permissions](../../admin-guide/users-permissions.md).
