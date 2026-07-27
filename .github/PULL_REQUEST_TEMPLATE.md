## What / Why

<!-- Link to the plan section this addresses (e.g., docs/PLAN.md § 2.1) -->

## Checklist

- [ ] `pnpm gate:full` passes locally (CI's actual bar — `pnpm gate` alone is the faster inner-loop check and includes a `docs-build` step; see `docs/developer-guide/getting-started.md`)
- [ ] Contract changes are additive-only (oasdiff clean)
- [ ] New decision rules in `packages/playback-engine` land with matrix cases in this PR (`matrix/burnup.json` updated too)
- [ ] Schema changes follow expand → migrate → contract pattern
- [ ] No `pg`/`kysely` imports outside `packages/db`
- [ ] STATE.md updated if a decision was made
- [ ] Provenance recorded in LICENSE-INTENT.md for any third-party code
- [ ] Docs updated if user/admin/operator-visible behavior changed (right guide, right register — see each guide's audience statement)
