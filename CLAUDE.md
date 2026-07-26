# Loombre — Media Platform

Ground-up, fully owned media streaming platform. NOT a an upstream media server/a proprietary server fork,
client, or compatible server. Zero an upstream media server/an upstream media server API surface, schema, or naming.
Authoritative spec: docs/PLAN.md. Private repo; AGPL-3.0 relicense-ready (see
LICENSE-INTENT.md — all deps AGPL-compatible, all provenance recorded).

## Architecture invariants (violating any fails review)
1. Contract-first: packages/contract/openapi.yaml is the source of truth.
   Controllers conform (tested); the SDK is generated; never hand-write either.
2. packages/playback-engine is pure: no I/O, no framework imports, clock is an
   argument. Every decision rule lands with matrix cases in the same PR.
3. Postgres only. Real columns/FKs/enums. JSONB only for: ffprobe output,
   event payloads, serialized plans, item_attributes values, device
   capability profiles, user settings prefs, server_settings.value,
   plugins.manifest, plugins.config (the plan §6.3 whitelist + Addendum
   A/AD5 + LPP v1 Lane W2/LD3).
4. ALL catalog reads go through packages/db/query with a ViewerContext.
   No `pg`/`kysely` imports outside packages/db (dependency-cruiser enforced).
   Restricted-content filtering is compiled in by the guard — unfiltered
   queries must be impossible, not discouraged.
5. Milliseconds everywhere. Cursor pagination. UUIDv7. RFC 9457 errors.
6. Long-running work goes through the job queue; nothing spawns ffmpeg inline.
7. No telemetry, analytics, or phone-home of any kind. Crash logs are local.
8. NFO/sidecar reading lives only in the scanner import path.
9. Tier-0 rule: request paths do no CPU-heavy work (images pre-scaled at
   ingest; hashing/blurhash in worker_threads).

## Runtime support policy (N2, standing rule — supported-latest sweep 2026-07-25)
Runtimes ship only on Active-LTS lines (Node: 24 today — .nvmrc, engines,
CI, Docker, bundled installers all agree). Current lines run as
NON-BLOCKING CI evidence jobs (ci.yml `gate-node-next`); adopt a Current
line only after it reaches LTS, against that job's accumulated history.
Maintenance-LTS is the engines floor; EOL lines are removed on sight.
Databases ship GA majors only. No betas/RCs/pre-release versions anywhere
in the dependency tree.

## Commands
- `pnpm dev` — compose up + server + worker + web in watch mode
- `pnpm test` / `pnpm test:matrix` — full suite / playback matrix only
- `pnpm gate` — codegen → sdk-drift-check → oasdiff → depcruise → license-check
  → dep-audit → lint → typecheck → test → db:migrate-check → grep-gates  (CI runs this)
- `pnpm db:migrate` / `pnpm db:reset` / `pnpm db:seed`

## Working agreements
- Feedback-loop-first: no implementation code before a failing check exists.
- STATE.md is the database; context is the cache. Update at boundaries.
- Two-strikes rule: a worker failing twice at a tier escalates one tier.
- Disk over context over recall — re-read files before editing them.

## Authoritative documents
- docs/PLAN.md — technical development plan v1.1 (the spec; wins conflicts)
- docs/PLAYBACK.md — playback engine spec (governs plan §7)
- STATE.md — goal / decisions / frozen / open; update at boundaries
