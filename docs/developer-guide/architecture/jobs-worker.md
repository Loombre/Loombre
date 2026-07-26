# Architecture: Jobs, worker & outbox

<!-- Sourcing: pg-boss as the actual driver (not BullMQ/Redis) —
     packages/jobs/src/queue.ts:16 (imports PgBoss from 'pg-boss'),
     packages/jobs/package.json:7,27. createJobQueue() — queue.ts:42,
     mirrors lifecycle into the jobs ledger (src/ledger.ts). Job types —
     packages/jobs/src/types.ts:182-193 (JobPayloads), 199-209 (JOB_TYPES):
     scan, probe, image, metadata, import, image-backfill, hwprobe,
     transcode, subtitle-extract, pg-upgrade. Consumer registration —
     apps/worker/src/index.ts (queue.work(...) call sites for each type).
     Outbox / events table — packages/db/migrations/0001_init.sql:590-609
     ("-- events (outbox)" comment, columns id/type/ts_ms/actor_user_id/
     payload/processed_at_ms). Guarded read side —
     packages/db/src/query/events.ts (readEventsForViewer). -->

## Why pg-boss, not Redis

docs/PLAN.md's architecture diagram names BullMQ/Redis as the general
case, with a Tier-0 alternative: "on Tier-0 hardware, Redis is replaced by
the in-process `pg-boss` driver — same job abstraction, one fewer daemon."
What's actually implemented in `packages/jobs` today is the pg-boss path —
PostgreSQL-backed, no separate queue daemon to run alongside the database
you already need. `createJobQueue()` wraps pg-boss and mirrors every job's
lifecycle transitions into a `jobs` ledger table as it goes, so job state
is queryable the normal way (the [Jobs dashboard](../../admin-guide/jobs-dashboard.md)
reads from this ledger, not from pg-boss's own internal tables directly).

## Job types

A closed registry (`packages/jobs/src/types.ts`) — `scan`, `probe`,
`image`, `metadata`, `import`, `image-backfill`, `hwprobe`, `transcode`,
`subtitle-extract`, `pg-upgrade`. `apps/worker/src/index.ts` is the single
entry point that registers a consumer for each, via `queue.work(...)` —
that file is the map from job type to handler module (`scan/scanner.ts`,
`probe/consumer.ts`, `metadata/consumer.ts`, `image/consumer.ts`,
`transcode/...`, `import/consumer.ts`, `subtitles/consumer.ts`, and so on).
CLAUDE.md invariant 6 — nothing spawns a conversion process inline from a
request path; it always goes through this queue, handled by the worker
process.

## The outbox

```
        a state change happens
        (item added, scan completes,
         playback starts, progress ticks, …)
                    │
                    │  same DB transaction
                    ▼
        ┌───────────────────────────┐
        │   events table (the        │
        │   "outbox")                 │
        │   id · type · ts_ms ·       │
        │   actor_user_id · payload   │
        │   (JSONB) · processed_at_ms │
        └─────────────┬─────────────┘
                       │
          read side: packages/db/src/query/events.ts's
          readEventsForViewer() — same guard model as
          catalog reads (per-event-type visibility
          checked against live state, not a payload
          snapshot)
                       │
           ┌───────────┴────────────┐
           ▼                        ▼
    websocket broadcaster      activity log
    (today's consumers)

    tomorrow: webhooks, sync, plugins — all addable
    without touching the code paths that emit events
```

Every event that any future feature could plausibly care about
(`item.added`, `playback.started`, `progress.updated`, `user.created`,
`scan.completed`, …) is written as a typed row in the **same transaction**
as the change it describes (docs/PLAN.md §4.3). This is what makes the
outbox reliable: there's no window where the state change committed but
the event didn't, or vice versa. Event payload schemas live in
`packages/contract` alongside the API and follow the same additive-only
evolution policy as the rest of the contract.

## See also

- [Libraries & scanning](../../admin-guide/libraries.md) — the admin-facing view
  of what the `scan` job actually does.
- [Jobs dashboard](../../admin-guide/jobs-dashboard.md) — the admin-facing view of
  the job ledger this page describes from the implementation side.
