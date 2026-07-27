# Loombre — Technical Development Plan
### A ground-up media streaming platform competing with Jellyfin and Plex

> **Status:** v1.1 — APPROVED. Name locked: **Loombre** (Spanish: hearth-fire).
> This document is the authoritative spec. The Phase 0 Claude Code orchestration
> prompt (PHASE0_ORCHESTRATION_PROMPT.md) is generated from this plan.
> Verified 2026-07-22: no conflicting media/software product under the name;
> arbitrary mark in this class. Formal USPTO clearance required before public launch.

---

## 1. Product definition

A self-hosted media streaming platform — server, web client, and later native
mobile/TV clients — that a user installs on their own hardware (Windows, macOS,
Linux) to organize and stream movies, TV, and music to any device, locally and
remotely. It is a **peer competitor** to Jellyfin and Plex, not a fork,
derivative, client, or compatible implementation of either. No Jellyfin or
Emby API surface, schema, naming, or code exists anywhere in the project.

**Product principles (ranked, used to break design ties):**
1. **Correct playback everywhere** — the plan engine's decision is right, or the
   failure is diagnosable from its recorded reasons.
2. **Fast on cheap hardware** — an Intel N100 with 4–8 GB RAM is a first-class
   deployment target, not a degraded one.
3. **Future-proof by mechanism** — extension points are designed in, so new
   features are additive, never breaking.
4. **Private by architecture** — multi-user isolation, restricted-content
   gating, and auth are enforced at the data layer, not the UI layer.
5. **Owned end-to-end** — one contract, one generated SDK, every client speaks it.

**v1 scope:** movies, TV, music · multi-user with remote access · web client ·
restricted (adult) content class with opt-in gating · Win/macOS/Linux server.
**Post-v1 (schema-anticipated, not built):** iOS/Android apps, TV apps,
photos, live TV/DVR, plugin system, federation/sharing.

---

## 2. Pain-point ledger — what we are fixing and how

Every architectural decision traces to an observed failure in Jellyfin (JF) or
Plex (PX). This table is the project's institutional memory.

| # | Pain point (source) | Root cause | Our design response |
|---|---------------------|-----------|---------------------|
| P1 | God-object item model; metadata/playback/filesystem entangled (JF `BaseItem`) | Inheritance-tree domain model grown from 2013 | Thin polymorphic `catalog_items` core + typed satellite tables; Catalog/Playback/Session modules share only IDs (§5, §7) |
| P2 | SQLite bottleneck: no concurrent writes, no horizontal scale, decade-long DB consolidation (JF) | DB chosen for zero-config, never escaped | PostgreSQL from commit one; embedded-Postgres bundling for zero-config installs (§6.1) |
| P3 | Transcoding decisions smeared across session code; bugs found only in production (JF, PX) | No pure decision layer | `PlaybackPlan` pure function with typed reasons + offline test matrix (§7) |
| P4 | API grown by accretion: ticks timestamps, inconsistent pagination, 3 image endpoints, undocumented behavior (JF/Emby) | No contract; server code was the spec | OpenAPI contract-first, generated SDK, conformance tests, additive-only evolution policy (§4) |
| P5 | Legacy web client sediment (JF jQuery-era `jellyfin-web`) | UI never rebuilt | One modern Next.js client, performance-budgeted (§9) |
| P6 | Client-side content filtering: hidden libraries leak via search, collections, "recently added" (PX managed users; JF parental controls) | Filtering applied in UI/queries ad hoc | Content-class gating compiled into every query path via a single mandatory query-guard layer; unfiltered queries are impossible by construction (§6.4) |
| P7 | Breaking plugin/API churn every major release (JF in-process plugin DLLs) | Plugins compiled against server internals | Extension points are versioned data contracts (events, providers, webhooks); plugins live out-of-process, post-v1 (§4.4) |
| P8 | Scanner fragility: renames re-import, watch-state loss, metadata clobbering (JF, PX) | File path used as identity | Content-hash + path identity model; scanner is idempotent and rename-aware (§8.2) |
| P9 | Remote access as afterthought or paid gate (JF manual reverse-proxy; PX relay/paywall) | Not designed in | First-class remote access: built-in TLS via ACME or bring-your-own reverse proxy, device auth, bandwidth-aware ladders — free, in core (§10) |
| P10 | Heavy idle footprint on small machines (PX background tasks; JF .NET baseline) | Server assumes dedicated hardware | Explicit hardware tiers with enforced perf budgets in CI (§9) |
| P11 | Adult/sensitive content unsupported (JF hides it poorly; PX prohibits it) | Never a design goal | Native restricted content class: opt-in, PIN-gated, server-enforced, metadata-isolated (§6.4) |
| P12 | Ratings/watch-state trapped in the product | Proprietary state | Clean export/import (open JSON), NFO/sidecar *read* on import — data freedom without API compatibility (§8.4) |

---

## 3. System architecture

```
┌────────────────────────── Clients ──────────────────────────┐
│  Web (Next.js)      iOS/Android (post-v1)     TV (post-v1)  │
│  ─ all consume the generated TypeScript/Swift/Kotlin SDKs ─ │
└──────────────────────────────┬──────────────────────────────┘
                        HTTPS + WSS (/v1)
┌──────────────────────────────┴──────────────────────────────┐
│                     API Gateway (NestJS)                    │
│   auth · rate limits · query-guard injection · websockets   │
├───────────────┬──────────────────────┬──────────────────────┤
│   Catalog     │   Playback Engine    │   Session & State    │
│ scanner ctrl, │  pure PlaybackPlan   │ users, devices, auth │
│ metadata,     │  fn + session mgmt   │ progress, events     │
│ images,search │  + HLS packaging     │                      │
├───────────────┴──────────────────────┴──────────────────────┤
│  Job Queue (BullMQ/Redis*)   │   Domain Event Outbox        │
├──────────────────────────────┴──────────────────────────────┤
│  Workers (separate process): scan · probe · image · transcode│
├─────────────────────────────────────────────────────────────┤
│  PostgreSQL (embedded or external)   ·   Media filesystem   │
└─────────────────────────────────────────────────────────────┘
```
\* On Tier-0 hardware, Redis is replaced by the in-process `pg-boss` driver —
same job abstraction, one fewer daemon. See §9.2.

**Process model:** one server process (API + modules), one worker process.
Both are separately bootable; on budget installs they run as two processes on
one machine, on serious installs workers scale out. Modules are enforced
boundaries in the monorepo (dependency-cruiser rules in CI): Catalog, Playback,
and Session may not import each other — they communicate via IDs over the DB
and via domain events.

**Monorepo layout** (Turborepo, pnpm, TypeScript strict):
```
apps/server        NestJS: gateway/, catalog/, playback/, session/
apps/worker        job consumers: scan, probe, image, transcode
apps/web           Next.js client
packages/contract  openapi.yaml + event schemas — the source of truth
packages/sdk       generated TS client (CI-regenerated, drift-gated)
packages/playback-engine  pure decision fn + test matrix (zero I/O imports)
packages/db        schema, migrations (hand-rolled scripts/migrate.mjs), query layer (Kysely), seed
packages/shared    enums, ids, time utils (the only cross-module package)
installers/        per-platform packaging (see §11)
```

---

## 4. Future-proofing — the mechanisms

"Future-proof" is a set of enforced mechanisms, not an aspiration. Each is a
CI-checkable rule.

### 4.1 API evolution policy
- **Additive-only within a major version.** New endpoints, new optional fields,
  new enum values (with documented client fallback behavior) are allowed; field
  removal/rename/type-change is not. CI runs `oasdiff` between the PR's
  openapi.yaml and `main` and fails on any breaking classification.
- **Capability negotiation.** `GET /v1/system/capabilities` returns the feature
  flags this server build supports (`music`, `restricted-content`, `hls-ll`,
  ...). Clients feature-detect instead of version-sniffing — the mechanism that
  lets a 2027 client talk to a 2026 server and vice versa.
- **Deprecation, not deletion.** Deprecated operations carry `deprecated: true`
  + a `Sunset` header for two minor releases minimum before a major bump.

### 4.2 Database evolution policy
- **Expand → migrate → contract.** Every schema change ships as: add the new
  structure (expand), backfill via job (migrate), remove the old only in a
  later release (contract). No migration may both add and drop in one step.
- **New media types are additive by construction:** add an `item_type` enum
  value + one satellite table. Zero changes to existing tables, queries, or
  the core. (This is the payoff of the P1 design.)
- **`item_attributes` extension table** (`item_id, namespace, key, value JSONB`)
  for future-feature and plugin metadata — extensions get a namespaced sandbox
  without touching core columns. Core code never reads it; only namespaced
  features do.
- **Migrations are forward-only — no `down` migrations exist, anywhere,
  ever.** Dev reset is drop + re-migrate zero-to-current (`pnpm db:reset`:
  `DROP SCHEMA public CASCADE` then replay every migration from scratch —
  `packages/db/scripts/migrate.mjs`). Production rollback = restore the
  pre-upgrade backup + roll forward with a corrected migration (documented
  in `docs/ops/backup.md`'s "Rolling back a failed migration" section).

### 4.3 Domain event outbox
Every state change that any future feature could care about (`item.added`,
`playback.started`, `progress.updated`, `user.created`, `scan.completed`)
writes a typed event row to an `events` outbox table in the same transaction
as the change. Today, consumers are the websocket broadcaster and the activity
log. Tomorrow, they are webhooks, recommendations, Trakt-style sync, plugins —
all buildable without touching the code paths that emit. Event payload schemas
live in `packages/contract` beside the API and follow the same additive-only
policy.

### 4.4 Extension points (designed now, opened post-v1)
- **Metadata providers** are an internal interface (`search`, `fetchDetails`,
  `fetchImages`) with TMDB/TVDB/MusicBrainz as the built-ins. The interface is
  the future plugin boundary — third-party providers (including adult-content
  providers such as a StashDB adapter) implement the same contract
  out-of-process over HTTP, never in-process code loading (P7).
- **Webhooks** on outbox events; **scrobble/export** on the open state format
  (§8.4). Both are contracts, not code hooks.

### 4.5 Codebase rules that keep additions safe
Enforced by CI: dependency-cruiser module boundaries; `tsc --strict` with no
`any` escapes in `packages/*`; the generated-SDK drift gate; conformance test
walking 100% of contract paths; the playback matrix as a permanent regression
wall — a change that flips any recorded plan decision must update the case
file in the same PR with a reason.

---

## 5. Domain model

**Core identity rule (P8):** a catalog item's identity is stable across file
renames, moves, and re-encodes. `media_files` carry both `path` and a
`content_hash` (xxHash3 of first+last 4 MiB + size — cheap, collision-safe
enough for identity hints). The scanner matches hash first, path second; a
moved file re-links to its existing item, preserving watch state, and emits
`file.relocated` instead of delete+add.

**Entity graph:**
```
library ─┬─ catalog_items (type: movie|series|season|episode|artist|album|track)
         │      ├── <type>_details (1:1 satellite, FK=PK)
         │      ├── provider_ids (TMDB/TVDB/MusicBrainz/…)
         │      ├── item_people (cast/crew/performers → people)
         │      ├── item_tags (genres, tags → tags)
         │      ├── item_attributes (namespaced extension data)
         │      └── media_files ── media_streams (typed ffprobe extraction)
users ─┬─ devices (auth + capability profile cache)
       ├─ progress (per user × item)
       ├─ playlists / playlist_items
       └─ user_settings (incl. restricted-content opt-in state)
events (outbox) · jobs · images (managed cache index)
```

Hierarchy is uniform: `parent_id` chains episode→season→series and
track→album→artist, so "continue watching," search, and browse are single
recursive-free queries over one indexed core table with satellite joins only
when a type's details are displayed.

---

## 6. Database design

### 6.1 Engine & packaging
PostgreSQL is the only supported engine (P2) — the embedded/pinned major tracks the standing runtime-currency policy (18 as of the 2026-07 supported-latest sweep; external servers: 17+). To keep zero-config installs
on par with SQLite products, the native installers bundle a managed embedded
Postgres (via `embedded-postgres` per-platform binaries) running as a child
process on a localhost socket, data dir inside the app-data folder. Advanced
users point the server at an external Postgres via one env var. Same schema,
same code — the bundling is purely a packaging concern. Redis is **not**
required on Tier 0 (§9.2).

### 6.2 Global conventions
UUIDv7 primary keys (time-ordered, index-friendly) · all timestamps `BIGINT`
milliseconds · `TEXT` + `CITEXT` where case-insensitive · enums as Postgres
enums · every FK declares its `ON DELETE` behavior deliberately · JSONB only
where shape is inherently unknown (`media_files.probe`, event payloads,
serialized plans, `item_attributes.value`) · every list-endpoint access path
has a covering index reviewed at PR time.

### 6.3 Schema (authoritative DDL follows in Phase 0; structure and rationale here)

Tables and their non-obvious design points:

- **`users`** — argon2id password hash; `birth_date DATE NULL` (basis for age
  rating limits); `max_content_rating TEXT NULL` (admin-set ceiling, e.g. a
  kid profile capped at PG); `is_admin`.
- **`user_settings`** — `restricted_opt_in BOOLEAN NOT NULL DEFAULT FALSE`,
  `restricted_pin_hash TEXT NULL`, `restricted_unlocked_until_ms BIGINT NULL`
  (session-scoped unlock, see §6.4), locale, theme, playback prefs.
- **`devices`** — per-device rotating refresh-token hash; `profile JSONB`
  cache of the device's declared capability profile (codecs, containers, HDR),
  refreshed on login — the input to PlaybackPlan.
- **`libraries`** — `media_kind`, `paths TEXT[]`,
  `content_class content_class NOT NULL DEFAULT 'general'` where
  `content_class AS ENUM ('general','restricted')`. Restricted is a property
  of the **library** (coarse gate) and inherited by items (fine gate) — a
  restricted item can never live in a general library.
- **`library_permissions`** — per user × library visibility; default-deny for
  restricted libraries (must be explicitly granted even to admins' own
  accounts — no implicit access).
- **`catalog_items`** — as in §5, plus `content_class` (denormalized from
  library, trigger-enforced equal to it) so the query guard filters on one
  indexed column without a join; `sort_title`, `year`, `community_rating`,
  `added_at_ms`, `updated_at_ms`, and a generated `search_tsv tsvector`
  column (title + sort_title, GIN-indexed) for search without an external
  search engine on budget hardware.
- **Satellites** — `movie_details`, `series_details`, `season_details`,
  `episode_details`, `artist_details`, `album_details`, `track_details`.
  Each: `item_id UUID PRIMARY KEY REFERENCES catalog_items ON DELETE CASCADE`.
  Content ratings (`content_rating TEXT`, normalized to a rating-system table
  post-v1) live on movie/series satellites.
- **`people` / `item_people`** — role enum (`actor`,`director`,`artist`,
  `performer`,…); people rows carry their own `content_class` so performers
  from restricted libraries never surface in general people search (metadata
  isolation, §6.4).
- **`tags` / `item_tags`** — same `content_class` isolation on tags.
- **`media_files`** — path, `content_hash`, size, container, duration,
  `probe JSONB`, probe timestamp. Multiple files per item = versions
  (4K/1080p) handled natively, another PX/JF sore spot.
- **`media_streams`** — typed per-stream extraction (codec, profile, level,
  bit depth, `color_transfer` for HDR10/HLG/DV detection, channels, bitrate,
  language, default/forced flags). This table, not raw probe JSON, feeds the
  plan engine.
- **`progress`** — PK `(user_id, item_id)`, UPSERT-only writes (concurrent-
  write-safe by construction), `position_ms`, `state`, `play_count`,
  covering index for continue-watching.
- **`playback_sessions`** — serialized plan JSONB as audit trail; live session
  state (heartbeats) kept in memory + periodically flushed, not row-per-tick.
- **`events`** — outbox: `id, type, ts_ms, actor_user_id, payload JSONB,
  processed_at_ms`; BRIN index on time.
- **`jobs`** — queue-agnostic job ledger mirroring BullMQ/pg-boss state for
  the admin UI.
- **`images`** — managed image cache index: `entity_type, entity_id, kind,
  source (provider|embedded|local), width, height, blurhash, file path`.
  Blurhash computed at ingest → instant LQIP placeholders in clients (perf,
  §9.3).

### 6.4 Restricted content — the gating architecture (P6, P11)

Requirement: adult content is natively supported, age-restricted, opt-in, and
invisible unless every gate passes. Design principle: **gating is a server-side
data-layer guarantee; clients never receive rows they must hide.**

**The five gates (all must pass for a restricted row to leave the server):**
1. **Server capability** — instance admin enables the `restricted-content`
   capability; off by default. When off, restricted libraries cannot be created
   and the code paths are inert.
2. **Age eligibility** — user's `birth_date` yields age ≥ 18 (or
   jurisdiction-configured majority age, instance setting). No birth date = not
   eligible. Admin cannot override eligibility for another user below the age.
3. **User opt-in** — the user themselves sets `restricted_opt_in = TRUE` and a
   dedicated PIN (argon2id-hashed, separate from password). Admins grant
   *library permission* but cannot opt a user in.
4. **Library permission** — explicit `library_permissions` grant on the
   restricted library (default-deny, including for admins).
5. **Session unlock** — a live unlock: `POST /v1/restricted/unlock` with the
   PIN sets `restricted_unlocked_until_ms` (default 30 min, per-user setting,
   re-verified server-side on every request; device-scoped variant recorded on
   the access token as a claim). Lock endpoint + auto-expiry; unlock state
   never persists across logins.

**Enforcement mechanism:** a single mandatory query-guard. All catalog reads go
through `packages/db`'s query layer, whose entry points require a
`ViewerContext` (user id, resolved content-class clearance, allowed library
ids). The guard appends `content_class = 'general'` unless all five gates pass
— there is no raw-query path exported from the package, and dependency-cruiser
forbids `pg`/`kysely` imports outside `packages/db`. Result: an unfiltered
query is a compile-time impossibility, not a code-review hope. Search (`tsv`),
people, tags, images, continue-watching, and event payloads all flow through
the same guard — the leak surfaces PX/JF missed.

**Metadata isolation:** restricted items' people, tags, and images carry the
class (above); the image endpoint checks the owning entity's class; websocket
events about restricted items are delivered only to sessions currently passing
gate 5. Home-screen rows ("recently added") are computed per-viewer-context,
never cached across users with different clearances (cache keys include a
clearance digest).

**Adult metadata providers:** the provider interface (§4.4) treats adult
sources (e.g., a StashDB-compatible adapter) as ordinary providers scoped to
restricted libraries only — provider registry entries carry a
`content_class`, and the scanner refuses to run a restricted provider against
a general library.

---

## 7. Playback engine

### 7.1 The pure decision function (P3)
```
plan(mediaInfo: MediaStreams[], device: DeviceProfile,
     network: NetworkConditions, policy: ServerPolicy, clock: Ms) → PlaybackPlan
```
- Deterministic, side-effect-free, zero I/O — lives in
  `packages/playback-engine`, imported by the server, testable on its own.
- Output: `decision (direct-play | direct-stream | remux | transcode)`,
  per-track actions, subtitle strategy (`none | embed | hls-vtt | burn-in`),
  ordered deterministic ffmpeg args, bitrate ladder, and **typed reasons** —
  the diagnosable "why," e.g. `video-codec-unsupported`,
  `hdr-tone-map-required`, `bitrate-exceeds-network`,
  `audio-channels-exceed-device`.
- **Direct-play bias** is policy: the engine must prove a transcode is needed
  (a reason per deviation), because on Tier-0 hardware every avoided transcode
  is the performance strategy (§9).

### 7.2 The test matrix
Table-driven YAML cases (`{mediaInfo, device, network} → {decision, reasons}`),
grown continuously; target ≥ 500 cases by Phase 3 exit covering: H.264/HEVC/AV1
× 8/10-bit × SDR/HDR10/HLG/DV-profile-8 · AAC/AC3/EAC3/TrueHD/FLAC/Opus ·
SRT/ASS/PGS/VobSub subtitles · device classes (evergreen browser, Safari,
constrained TV profile placeholder, mobile placeholder) · network rungs. The
matrix is the permanent regression wall (§4.5). Golden-file tests additionally
snapshot ffmpeg args for a canonical subset so arg-building regressions diff
loudly.

### 7.3 Execution
- Sessions produce **HLS** (fMP4 segments; TS fallback for compatibility) via
  worker-pool ffmpeg processes; segment-ahead window adaptive to device buffer;
  seek-into-unproduced-region restarts the pipeline at the keyframe with the
  session preserved.
- **Hardware acceleration:** first-boot capability probe runs ffmpeg
  self-tests per backend — VideoToolbox (macOS), QSV & VAAPI (Linux), NVENC
  (Linux/Windows), AMF (Windows), D3D11/QSV (Windows) — and records a verified
  capability matrix (survives driver quirks like the iHD VDENC gaps). The plan
  engine consumes verified capabilities, never assumed ones.
- **Tone mapping** (HDR→SDR) prefers hardware paths (OpenCL/VideoToolbox/
  Vulkan) with CPU zscale fallback gated by a policy knob that Tier-0 defaults
  to "refuse + reason" rather than melt the CPU.
- FFmpeg is **bundled per platform** (pinned official/BtbN builds with hwaccel
  enabled), path-isolated from any system ffmpeg; the arg-builder targets the
  pinned version only.
- Music: gapless-capable delivery via direct stream where the device allows;
  transcode to Opus/AAC ladder otherwise; ReplayGain/R128 tags read at probe
  and exposed in the plan.

---

## 8. Catalog pipeline

### 8.1 Scanner
Worker-side, incremental, idempotent. Watches library paths (chokidar with
polling fallback for network mounts — SMB/NFS are first-class, per your own
mergerfs/Samba topology); full scans are resumable jobs with checkpointing.
Concurrency capped by tier (§9.2). Filename/folder parsing via a
deterministic, fixture-tested ruleset (movies: `Title (Year)`; TV:
`S01E01`/dated/absolute; music primarily by tags not filenames — tag-first is
the anti-JF choice for music correctness).

### 8.2 Identity & rename handling (P8)
As §5: hash-first matching, `file.relocated` events, watch state preserved.
Deletion is soft (missing-file grace window, default 72 h) before cascade —
protects against transient mount drops nuking a library, a classic self-hosted
disaster.

### 8.3 Metadata & images
Provider chain per library kind with per-field precedence (local NFO/tags >
provider > filename inference), stored provenance per field (`metadata_lock`
per field, not per item — finer than JF). Image ingest: original cached →
pre-scaled variants (3 sizes, WebP/AVIF) generated at ingest time by the image
worker, never on request (Tier-0 rule: request paths do no CPU-heavy work);
blurhash computed alongside (§6.3).

### 8.4 Data freedom (P12)
`GET /v1/export` streams an open JSON archive: users (sans secrets), libraries,
items + provider ids, progress, playlists. Import endpoint accepts the same.
NFO/sidecar/embedded tags are **read** on import for interoperability with a
user's existing library conventions; we never write NFO in v1 (optional
post-v1 writer behind a setting).

---

## 9. Performance engineering — budget hardware as a contract

### 9.1 Hardware tiers (documented, tested, CI-enforced where feasible)
| Tier | Reference hardware | Commitment |
|------|--------------------|------------|
| T0 | Intel N100 / 4 GB RAM / HDD, or Pi-5-class ARM | Full functionality; ≥ 2 simultaneous 1080p hw transcodes or 8+ direct-play streams |
| T1 | Quad-core desktop + iGPU or entry dGPU / 8–16 GB | 4+ 4K→1080p hw transcodes, sub-second library nav at 50k items |
| T2 | Dedicated server + dGPU (your 265K/3060 Ti class) | Worker scale-out, 10+ transcodes |

### 9.2 Server budgets (regression-tested in CI on a T0-throttled container)
- Idle RSS (server + worker + embedded PG) ≤ **500 MB**; server process alone
  ≤ 220 MB.
- p95 API latency ≤ **100 ms** on T0 against a 50k-item seeded library for the
  hot paths (browse page, item detail, continue-watching, search-as-you-type).
- Cold start ≤ 5 s; scan throughput ≥ 200 files/min on HDD (probe-bound).
- Techniques (mandated, not optional): Kysely over an ORM (no hydration tax);
  hot-path queries are reviewed SQL with covering indexes; keyset pagination
  end-to-end; Node worker_threads for hashing/blurhash; streams everywhere
  (no whole-file buffering); `pg-boss` on T0 to drop the Redis daemon (§3);
  per-tier concurrency caps (scan/probe/transcode) auto-set from detected
  CPU/RAM at first boot, overridable.
- Native-module policy: pure-JS or prebuilt binaries only (no node-gyp at
  install time) — protects the Win/macOS/ARM install experience.

### 9.3 Web client budgets
- ≤ **200 KB** gzipped JS on the browse route; route-level code splitting;
  RSC for browse surfaces; virtualized grids (50k-item libraries scroll at
  60 fps); blurhash LQIPs → zero layout shift; image `srcset` from the
  pre-scaled variants; Lighthouse perf ≥ 90 in CI on a throttled profile.
- Player: hls.js with MSE, capability-probed at login to build the device
  profile (§6.3 devices), Safari native-HLS path.

---

## 10. Security & remote access (P9)

- **Auth:** argon2id passwords; 15-min access JWT + per-device rotating
  refresh tokens (hash-stored, reuse-detection revokes the device); restricted
  unlock as a separate short-lived claim (§6.4 gate 5).
- **Transport:** built-in ACME (Let's Encrypt HTTP-01/DNS-01) for direct
  exposure, or plain HTTP behind a user's reverse proxy with
  `trust-proxy` config — both first-class, documented paths. HSTS on by
  default when TLS is terminated internally.
- **Hardening:** per-IP and per-user rate limits on auth and search; login
  anomaly log + optional fail2ban-compatible log format (matching your
  besideclone posture); path traversal impossible by construction (all file
  access resolves through `media_files` rows, never client-supplied paths);
  CSP + strict CORS on the web client; secrets in OS keychain/DPAPI where
  available, else 0600 file.
- **Isolation:** every request executes under a `ViewerContext`; admin
  endpoints are a separate guard + audit-logged to the event outbox.
- **Updates:** signed release manifests; server checks and notifies, never
  auto-applies (self-hosted trust posture).

---

## 11. Cross-platform distribution

| Platform | Primary channel | Notes |
|----------|-----------------|-------|
| Linux | Docker/Compose (canonical) + tarball w/ systemd unit | Your openSUSE box is the reference T2 |
| Windows | MSI installer (WiX): service registration, firewall rule, tray controller | Embedded PG + bundled ffmpeg |
| macOS | Signed/notarized .pkg + menubar controller; Homebrew cask | VideoToolbox path is the differentiator vs JF on Macs |

Single Node runtime bundled per platform (no user-installed Node); app-data in
platform-correct locations (XDG / `%ProgramData%` / `~/Library/Application
Support`); case-insensitivity and long-path handling in the scanner tested via
per-OS CI runners (the matrix runs on ubuntu/windows/macos GitHub runners —
cross-platform is CI-enforced, not claimed). First-run web onboarding wizard:
admin creation → library paths → hardware probe → capability report.

---

## 12. Phased roadmap (supersedes earlier sketch)

| Phase | Duration | Exit criteria |
|-------|----------|---------------|
| **0 — Contracts & harness** | 2–4 wk | Monorepo boots; contract + SDK pipeline; full schema incl. restricted-content structures + query-guard skeleton; CI gate incl. oasdiff, drift-gate, module-boundary rules, T0 perf harness scaffold; failing 10-case plan matrix |
| **1 — Catalog slice** | 8–12 wk | Movies+TV+music scan/identify/metadata/images against your real library over SMB; identity/rename tests green; restricted library end-to-end gated (all five gates) with a test suite that *proves* leak-impossibility (search, people, tags, images, events) |
| **2 — Direct play + web client** | 6–10 wk | Auth/devices/remote access; browse/detail/player at §9.3 budgets; music playback; daily-drivable for direct-play libraries; T0 budgets green in CI |
| **3 — Playback engine** | 5–9 mo | Matrix ≥ 500 cases green; hw-accel verified matrix on all three OSes; HDR tone-map paths; seek-into-transcode; audio ladders |
| **4 — Product hardening** | 2–3 mo | Installers all platforms; onboarding wizard; export/import; admin surfaces; perf budget audit on reference T0 hardware (physical N100) |
| **Post-v1** | — | iOS/Android (SDK codegen → Swift/Kotlin), TV clients, plugins/webhooks GA, photos, live TV |

Solo + Claude Code orchestration estimate: **14–20 months to v1**. Phases 1–3
each get their own orchestration prompt derived from this plan; Phase 0's is
regenerated next.

---

## 13. Risk register

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Plan-engine edge-case grind exceeds estimate (it did for everyone) | High | Matrix-first development; direct-play bias shrinks the surface; per-device-class rollout |
| Embedded-Postgres packaging friction (upgrades, ARM, AV false positives on Win) | Medium | Pin per-platform binaries; PG major upgrades via dump/restore job; Docker canonical path unaffected |
| Node perf ceiling on T0 for probe/hash/image | Medium | Work already routed to worker_threads + bundled native ffmpeg/sharp prebuilds; escape hatch: rewrite individual workers in Rust behind the same job contract (job queue makes this a drop-in, by design) |
| Restricted-content legal variance by jurisdiction | Medium | Instance-level majority-age setting; capability off by default; no hosted service component — operator responsibility, documented |
| Scope creep into post-v1 features | High | This document is the scope contract; additions require editing §1 first |
| Solo-maintainer bus factor / motivation over 18 mo | Medium | Phase 2 daily-drivable milestone; STATE.md discipline; each phase independently shippable to your own homelab |

---

## 14. Owner decisions — RESOLVED 2026-07-22
1. **Name:** **Loombre**. Repo `loombre`, npm scope `@loombre/*`, DB `loombre`,
   CLI `loombre`. Ambient uses noted (icon pack, radio app, Loombre Studio
   agency, loombre-io Umbrel fork) — none in class; monitor loombre-io.
2. **License:** private now → **AGPL-3.0** at public launch. Repo carries
   `LICENSE-INTENT.md` from commit one; all dependencies must be
   AGPL-compatible (checked in CI via license-checker deny-list); clean
   provenance (no copied third-party code without recorded license) so the
   relicense is a one-commit event.
3. **Restricted-content majority age:** 18, instance-configurable **upward
   only** (floor is hard-coded).
4. **Telemetry:** none, ever. No phone-home of any kind. Crash reports are
   written to a local file only; sharing is a deliberate manual user action.
   CI grep-gate bans analytics/telemetry SDK imports.
