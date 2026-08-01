# Clean clone to green gate

<!-- Sourcing: command list verbatim from CLAUDE.md's "## Commands" section
     (repository root); gate step order + step names from scripts/gate.mjs's
     own top-of-file docblock and step list, which is the authoritative
     order/naming (this page summarizes it, doesn't restate every step's
     rationale — see that file for the full reasoning behind each step's
     position). Prerequisites (Node 24, pnpm 11, Docker) — README.md
     "Running from source". `pnpm dev` = `docker compose -f docker-compose.dev.yml
     up -d && turbo run dev` (root package.json) — the compose step is
     idempotent, which is why steps 2 and 3 below can both invoke it safely.
     ffmpeg prerequisite + LOOMBRE_REQUIRE_FFMPEG semantics —
     apps/worker/test/support/require-ffmpeg.ts's header comment (CI sets
     it; local dev without ffmpeg silently skips those suites otherwise).
     Ports — docker-compose.dev.yml (postgres 5442, adminer 8080),
     apps/web/package.json's `dev` script (next dev, default 3000),
     apps/server/src/main.ts (PORT env, default 3001). -->

This page is the real, literal path from a fresh clone to a passing gate —
no steps skipped, no commands invented beyond what's in `CLAUDE.md` and
`scripts/gate.mjs`.

## Prerequisites

- Node 24
- pnpm 11
- Docker (for the local PostgreSQL instance, via Compose)

  Runtime support policy (standing rule, CLAUDE.md "Runtime support
  policy"): runtimes ship only on **Active LTS** lines — Node 24 today.
  The next Current line (Node 26) runs as a non-blocking CI evidence job
  (`gate-node-next` in `ci.yml`) and is adopted only once it reaches LTS;
  Maintenance LTS is the floor `engines` may accept.

- ffmpeg on your `PATH` (or `LOOMBRE_FFMPEG` pointing at a binary). Without
  it, several worker test suites (probe/session/subtitle/battery
  integration) silently *skip* rather than fail, so a clean-looking local
  `pnpm test`/`pnpm gate` run can hide real coverage gaps. Set
  `LOOMBRE_REQUIRE_FFMPEG=1` to turn that silent skip into a hard failure —
  `LOOMBRE_REQUIRE_FFMPEG=1 pnpm gate:full` is exactly what CI runs, so
  it's the closest local match to what a PR is actually checked against.

## 1. Install dependencies

```bash
pnpm install
```

## 2. Bring up the database and set it up

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm db:migrate
pnpm db:seed
```

The first command brings up PostgreSQL (host port 5442) and Adminer (a
web-based database browser, host port 8080) via `docker-compose.dev.yml`,
detached so this terminal is free again immediately. `db:migrate` applies
every migration in `packages/db`. `db:seed` loads a small, deterministic
dataset so the app has something to browse. (There's also `pnpm db:reset`,
if you need to drop and recreate the schema from scratch — and a separate
`db:seed-large` target used by the performance harness, not needed for
everyday development.)

## 3. Start the dev environment

```bash
pnpm dev
```

`pnpm dev` re-runs the same `docker compose up -d` from step 2 (a harmless
no-op if it's already running) and then starts the server, worker, and web
client in watch mode via Turborepo. **`pnpm dev` stays running** — it's not
a one-shot setup step, it's your dev environment for the rest of this
session — so open a second terminal for everything below.

Once it's up:

| What | Where |
|---|---|
| Web client | `http://localhost:3000` |
| API server | `http://localhost:3001` |
| Adminer (database browser) | `http://localhost:8080` |
| PostgreSQL | `localhost:5442` |

## 4. Run the tests

(From the second terminal.)

```bash
pnpm test
```

Runs every workspace package's test suite via Turborepo. If you're working
specifically on playback decision logic:

```bash
pnpm test:matrix
```

Runs only the playback-engine's offline test matrix — see
[Playback engine & matrix law](architecture/playback-engine.md)
for what that actually is, and
[Authoring a matrix case](matrix-authoring.md) if you're
adding to it.

## 5. Run the gate

```bash
pnpm gate
```

This is the fast inner-loop default, stopping at the first failing step:
`codegen` → `sdk-drift` → `oasdiff` → `depcruise` →
`runtime-imports` → `license-check` → `dep-audit` → `lint` → `typecheck` →
`test` → `db:migrate-check` → `grep-gates` → `docs-build` (see
`scripts/gate.mjs` for the exact step list and the reasoning behind each
step's position — it's a short, heavily-commented file, worth reading
once).

### 5a. Before you push or open a PR: run the full gate

```bash
pnpm gate:full
```

`pnpm gate:full` runs everything `pnpm gate` runs, plus a 14th step,
`web-build-budget`: a production build of `apps/web` and a check of its
bundle size against the docs/PLAN.md §9.3 budget. This step is genuinely
slow (a full Next.js production build), which is why it's not in the fast
`pnpm gate` — but **CI runs `pnpm gate:full`, not the fast gate**, so a
green `pnpm gate` alone does not guarantee a green PR. Run
`LOOMBRE_REQUIRE_FFMPEG=1 pnpm gate:full` (see "Prerequisites" above) for
the closest local match to what CI itself enforces.

## Where to go next

- Making a contract change (a new or modified endpoint)? See
  [Contract-first workflow](contract-workflow.md).
- Touching playback decisions? See
  [Playback engine & matrix law](architecture/playback-engine.md).
- Not sure what a term in this guide means? Check the
  [Glossary](glossary.md).
- `CONTRIBUTING.md` at the repository root has the PR-level expectations
  (feedback-loop-first, the matrix regression law, contract-first rules)
  distilled into one page.
