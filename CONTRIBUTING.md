# Contributing to Loombre

Loombre is a ground-up, contract-first media server — see
[`docs/PLAN.md`](docs/PLAN.md) for the authoritative technical spec and
architecture invariants. This
page distills the working rules that actually matter for a PR to land,
plus the concrete commands to run before opening one. For a guided tour of
the codebase itself, start with the
[Developer Guide](docs/developer-guide/index.md) (published at
[www.loombre.com/docs](https://www.loombre.com/docs); `pnpm docs:build`
builds the same rendered site locally) — if a
term below is unfamiliar, the Developer Guide's
[Glossary](docs/developer-guide/glossary.md) defines every piece of
internal shorthand in one place.

## Before you write code: feedback-loop-first

No implementation code lands before a failing check exists that proves
it's needed — a failing test, a lint rule, a contract diff, a matrix case.
This isn't process for its own sake: it's what makes "does this change
actually do what it claims" checkable by someone other than its author,
including future-you. If you're not sure what the failing check should
look like yet, that's a sign to figure that out first.

## The gate

```bash
pnpm gate
```

This runs the ordered sequence stopping at the first failure: `codegen` →
`sdk-drift` → `version-stamp` → `oasdiff` → `depcruise` →
`runtime-imports` →
`license-check` → `go-licenses-check` → `dep-audit` → `lint` → `typecheck` →
`test` → `installers-test` → `scripts-test` → `db:migrate-check` →
`grep-gates` → `docs-build`. See
`scripts/gate.mjs`'s own header comment for what each step checks and why
it's positioned where it is.

```bash
pnpm gate:full
```

`pnpm gate` is the fast inner-loop default — **it is a looser local path
than CI now runs**, deliberately: an 18th step, `web-build-budget`
(builds `apps/web` for production and checks its bundle size against
docs/PLAN.md §9.3), is expensive enough that folding it into the fast
gate would slow down every inner-loop run. `pnpm gate:full` runs it —
`pnpm gate`'s 17 steps plus that 18th. **CI runs `pnpm gate:full`, so
that's the real bar a PR is checked against** — run it before pushing or
opening a PR. It's the only local path that catches a production-build-
only failure class (e.g. a barrel import pulling a `node:`-scheme module
into the client graph), which plain `pnpm gate`/`pnpm test` cannot see.

New to the codebase? The Developer Guide's
[clean clone to green gate](docs/developer-guide/getting-started.md)
page is the concrete first-time walkthrough, prerequisites included.

## Contract-first rules

`packages/contract/openapi.yaml` is the source of truth for the entire
API surface (the contract-first invariant):

- Never hand-write `packages/sdk`'s generated files. Edit
  `openapi.yaml`, run `pnpm --filter @loombre/contract run codegen`, and
  commit the regenerated output — the `sdk-drift` gate step fails if it
  doesn't exactly match.
- Contract changes are **additive-only** within a major version — no
  removed fields, no renamed fields, no changed types. The `oasdiff` gate
  step enforces this mechanically against `main`.
- A controller change needs a passing conformance test
  (`apps/server/test/conformance.spec.ts`,
  `apps/server/test/seeded-conformance.spec.ts`) — these check the running
  server against the contract itself, including that every mounted route
  is actually documented.

Full workflow, with a diagram:
[Contract-first workflow](docs/developer-guide/contract-workflow.md).

## The playback-engine matrix regression law

`packages/playback-engine` is a pure decision function with zero I/O
(the engine-purity invariant). **Every new or changed decision rule ships with
matrix cases in the same PR** — not a follow-up PR, the same one:

1. Add or change the decision logic in `packages/playback-engine/src/`.
2. Add a case file under `packages/playback-engine/matrix/` (one YAML
   file per case, citing the `docs/PLAYBACK.md` section it proves).
3. Update `matrix/burnup.json` in the same diff — `matrix-meta.spec.ts`
   fails if the manifest and the on-disk case files disagree.
4. Run `pnpm test:matrix` locally — it's the exact check CI runs, and it
   re-verifies every case's *actual* output against what `burnup.json`
   claims is correct, so a decision change that silently flips an
   existing case's outcome is caught here, not discovered later.

Full walkthrough, with an example case:
[Authoring a matrix case](docs/developer-guide/matrix-authoring.md).

## Other architecture invariants that fail review

The full set is enforced mechanically by `pnpm gate` (dependency-cruiser,
grep-gates, contract drift checks); the ones worth calling
out because they're easy to trip without realizing it:

- **No `pg`/`kysely` imports outside `packages/db`.** All catalog reads go
  through `packages/db`'s query layer with a `ViewerContext` —
  dependency-cruiser enforces this as a build failure, not a lint
  suggestion. See
  [Catalog, query guard & restricted content](docs/developer-guide/architecture/catalog-query-guard.md).
- **No telemetry, analytics, or phone-home of any kind, ever.** Not
  behind a flag, not opt-in-by-default, not for crash reporting. Crash
  logs stay local. `grep-gates` scans for known telemetry SDK import
  patterns as a build failure.
- **Nothing spawns a conversion process inline from a request path.**
  Long-running work goes through the job queue (`packages/jobs`).
- **Milliseconds everywhere, cursor pagination, UUIDv7, RFC 9457 errors.**
  Consistency here is what keeps the generated SDK and every client
  simple.
- **Zero third-party media-server API surface, schema, or naming, anywhere**
  — this is both a product rule and a licensing-compatibility rule (see
  `LICENSE-INTENT.md`). `grep-gates` checks for this too.
- **Performance budgets are enforced in CI, and changing one requires a
  stated reason in the same diff.** See
  [Performance budgets](docs/developer-guide/architecture/performance-budgets.md).

## Licensing and provenance

Loombre is AGPL-3.0-only. Every dependency (direct or transitive) must
carry an AGPL-compatible license — `pnpm gate`'s `license-check` step
enforces an explicit allow-list. If you copy any snippet, file, or
algorithm from another project, it needs a provenance entry in
[`LICENSE-INTENT.md`](LICENSE-INTENT.md) (source, license, date, what was
taken) — copied code without one is a review-blocking issue, not a
formality.

By contributing, you affirm your contribution is your own original work
(or work you have the right to contribute under a compatible license),
consistent with `LICENSE-INTENT.md`'s contributor-provenance rule.

## Opening a PR

- Fill out the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) honestly
  — every box is something CI or a reviewer will actually check.
- Record a real decision in `reports/state/DECISIONS.md` (the project's
  live, append-only decision ledger), and close any open item your change
  settles in `reports/state/OPEN.md` — that tier is the living record of
  what's been decided and why. The root `STATE.md` is the frozen
  historical ledger; never append to it.
- Small, focused PRs over large ones where the two are actually
  equivalent in risk — a contract change plus its conformance tests plus
  its SDK regeneration is normally one PR; unrelated refactors are not.

## Code of Conduct

Taking part in this project — issues, PRs, discussions — means agreeing to
the [Code of Conduct](CODE_OF_CONDUCT.md). It applies to everyone equally,
maintainers included.

## Reporting a security issue

Please don't open a public issue for a security vulnerability — see
[`SECURITY.md`](SECURITY.md) for private disclosure instructions.

## Questions

If something in this file, `docs/PLAN.md`, or the Developer Guide is unclear
or seems to contradict the actual codebase, please open an issue — a
confusing contributor-facing doc is a real bug, not a nitpick.
