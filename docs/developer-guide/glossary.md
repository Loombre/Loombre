# Glossary

<!-- Sourcing: guard/ViewerContext — packages/db/src/context.ts,
     packages/db/src/query/guard.ts. Outbox — docs/PLAN.md §4.3, events
     table (packages/db/migrations/0001_init.sql). Satellite tables —
     docs/PLAN.md §5 domain model / pain-point P1. Lanes/tiers (process) —
     STATE.md "## Addendum A" burn-up table + CLAUDE.md "Two-strikes rule".
     Hardware tiers — docs/PLAN.md §9, docs/install/index.md "System
     requirements". pg-boss, burn-up, conformance, sdk-drift, oasdiff,
     RFC 9457, UUIDv7 — CLAUDE.md invariants + scripts/gate.mjs. -->

Internal shorthand used throughout the codebase, STATE.md, and this guide,
defined once here rather than re-explained on every page.

### Guard (query guard)

The mandatory filtering layer every catalog read passes through —
`packages/db`'s query functions take a `ViewerContext` (user id, allowed
library ids, whether the viewer has passed restricted-content clearance,
and the requesting surface — `'general'` or `'restricted'`) and append a
filtering predicate that makes an unfiltered query a compile-time
impossibility, not a convention. Restricted rows pass the predicate only
when clearance holds AND the surface is `'restricted'` — never on
clearance alone (docs/PLAN.md §6.4 as amended 2026-08-30). See
[Catalog, query guard & restricted content](architecture/catalog-query-guard.md).

### Outbox (domain event outbox)

A single `events` table that every meaningful state change writes a typed
row into, in the *same transaction* as the change itself (`item.added`,
`playback.started`, `scan.completed`, and so on). Today's consumers are
the websocket broadcaster and the activity log; the mechanism exists so
future consumers (webhooks, sync, plugins) never need to touch the code
paths that emit. See
[Jobs, worker & outbox](architecture/jobs-worker.md).

### Satellite tables

Loombre's core catalog table (`catalog_items`) is intentionally thin —
fields common to every media type. Type-specific data (a movie's runtime,
a track's album, an episode's season number) lives in separate "satellite"
tables joined by id, rather than one god-object table with columns for
every media type at once. Adding a new media type is additive: a new
`item_type` enum value plus one satellite table, with zero changes to
existing tables or queries.

### Lane

A scoped, independently-trackable unit of work within a phase or addendum
(tracked in `STATE.md`) — for example, this documentation work is lane
"D1" within "Addendum A." Lanes exist so parallel work streams have clear
ownership boundaries and an explicit blocked-on relationship to each other
(visible in STATE.md's lane burn-up tables) rather than an implicit,
easy-to-collide shared scope.

### Tier

Two unrelated meanings, both real, disambiguated by context:

- **Hardware tier** (Tier-0/1/2) — a deployment class Loombre is explicitly
  designed and performance-budgeted for, from a $100-class mini PC
  (Tier-0) to a dedicated server with a discrete GPU (Tier-2). See
  [docs/install/index.md](../install/index.md#system-requirements) for the concrete
  specs and commitments per tier.
- **Escalation tier** (CLAUDE.md's "two-strikes rule") — an internal
  working agreement for this project's AI-assisted development process: a
  worker failing twice at a given tier of effort escalates to the next.
  Unrelated to hardware tiers; if you see "tier" in a process/STATE.md
  context versus a performance-budget context, it means different things.

### pg-boss

The job-queue driver Loombre actually uses (`packages/jobs`) — a
PostgreSQL-backed queue, not Redis/BullMQ. This is a deliberate Tier-0
choice: one fewer daemon to run on budget hardware, at the cost of
Postgres itself carrying the queue's write load.

### Matrix / burn-up

"The matrix" is `packages/playback-engine/matrix/` — one YAML file per
playback-decision test case. "Burn-up" is `matrix/burnup.json`, the
manifest recording every case's status, checked for consistency by
`matrix-meta.spec.ts` and re-verified against actual `plan()` output by
`matrix.spec.ts`. See
[Authoring a matrix case](matrix-authoring.md).

### Conformance (tests)

Tests (`apps/server/test/conformance.spec.ts` and
`seeded-conformance.spec.ts`) that verify the running server actually
matches `openapi.yaml` — not just "does this feature work," but "does
every documented operation behave as documented, and does every actually-
mounted route appear in the contract." See
[Contract-first workflow](contract-workflow.md).

### SDK drift / oasdiff

Two `pnpm gate` steps guarding the contract: **sdk-drift** fails if
`packages/sdk`'s generated files don't exactly match what
`packages/contract`'s codegen would produce right now (i.e., you forgot to
regenerate/commit). **oasdiff** fails if the current `openapi.yaml`
contains a breaking change relative to `main` (docs/PLAN.md §4.1's
additive-only policy, enforced mechanically rather than by review
vigilance alone).

### RFC 9457

The IETF standard for machine-readable HTTP error responses
(`application/problem+json`) — every Loombre API error follows this shape,
rather than an ad hoc error format per endpoint.

### UUIDv7

The ID format used throughout the schema — time-sortable UUIDs, so IDs
generated close in time sort close together (useful for cursor pagination
and index locality) without leaking a literal auto-increment counter.
