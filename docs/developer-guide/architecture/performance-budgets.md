# Architecture: Performance budgets

<!-- Sourcing: moved verbatim (lightly reworded intro) from README.md, where
     this was the only home for it. Job names `perf-t0`, `perf-web-budget`,
     `perf-lighthouse` and their `ubuntu-latest` runner — .github/workflows/
     ci.yml. Scripts `scripts/perf-t0.mjs`, `scripts/perf-web-budget.mjs`,
     `scripts/perf-baseline-check.mjs` and the `perf:*` package.json scripts
     — verified by direct inspection. Budget values and the
     update-requires-reason rule — perf/baselines.json +
     scripts/perf-baseline-check.mjs's own header. -->

Loombre's hardware-tier commitments (Tier-0 in particular: a 4-core, 4 GB
mini PC is a *supported* deployment, not a degraded one) are only real if
something fails the build when they stop being true. This page is that
mechanism: which budgets are enforced, by which job, and what it takes to
change one.

Three blocking CI jobs (`perf-t0`, `perf-web-budget`, `perf-lighthouse` in
`.github/workflows/ci.yml`), all `ubuntu-latest`-only:

| Budget | Enforced by | Command |
|---|---|---|
| Server idle RSS <= 220 MB | `scripts/perf-t0.mjs` | `pnpm perf:t0` |
| Endpoint p95 <= 100ms (browse, item detail, continue-watching, search-as-you-type) @ 50k-item seed | `scripts/perf-t0.mjs` | `pnpm perf:t0` |
| Scan throughput >= 200 files/min | `scripts/perf-t0.mjs` | `pnpm perf:t0` |
| `/browse` first-load JS <= 200 KB gz | `scripts/perf-web-budget.mjs` | `pnpm perf:web-budget` |
| Lighthouse performance >= 0.90 (throttled mobile, `/login`) | `apps/web/lighthouserc.cjs` (`@lhci/cli` via pinned npx — kept OUT of the workspace lockfile: lighthouse transitively depends on a crash-reporting SDK that the D14 telemetry grep-gate bans from the repo; error reporting is opt-in and never enabled) | `pnpm perf:lighthouse` |

`pnpm perf:t0` needs `pnpm db:seed && pnpm db:seed-large` run first (the
50k-item library its endpoint measurements run against) and a built
`apps/server` (`pnpm --filter "@loombre/server..." run build`).
`pnpm perf:lighthouse` needs a built + running `apps/web` (`next start` —
handled by `lighthouserc.cjs`'s `startServerCommand`) and builds it itself
via `pnpm perf:web-budget`'s own step, or you can build first.

The stack idle-RSS figure named in plan §9.2 (server + worker + embedded PG
<= 500 MB) is measured and reported (server + worker, best-effort) but NOT
hard-enforced: embedded PG doesn't exist yet (a Phase-4 packaging concern),
so a server+worker-only sum can't honestly represent the number it's named
after.

## `perf/baselines.json` — update-requires-reason

`perf/baselines.json` is a hand-curated ledger of every enforced budget's
value + last-measured number + a `reason` string explaining it. If a PR
changes ANY field of an existing entry — the budget itself, or a
`lastMeasured*` figure — vs the copy on `main`, that entry's `reason` MUST
also change in the same diff, or `scripts/perf-baseline-check.mjs` (run in
the `perf-t0` CI job as `pnpm perf:baseline-check`) fails the build. This
makes "quietly loosen a budget" or "quietly baseline away a regression"
impossible without a human explaining why, in the commit that does it.

This is distinct from `perf/t0-baseline.json` and
`perf/web-budget-result.json`, which ARE wholesale-overwritten by every
`pnpm perf:t0` / `pnpm perf:web-budget` run — those are raw measurement
output, not the reasoned ledger.

## Where this is specified

`docs/PLAN.md` §9 defines the tier commitments and the budget numbers
themselves; `STATE.md` (P2.6 / D15) records them as ENFORCING rather than
aspirational. The operator-facing counterpart — how to run a Tier-0 audit
against real hardware — is the
[Tier-0 performance audit runbook](../../ops/t0-audit-runbook.md).
