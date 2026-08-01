# Architecture: Contract + generated SDK

<!-- Sourcing: see docs/developer-guide/contract-workflow.md's sourcing
     comment — same facts, presented here as the architecture-tour framing
     rather than a step-by-step workflow. -->

```
 packages/contract/openapi.yaml   (≈5,300 lines, 85 paths — hand-written,
        │                          lint-checked via `redocly lint`)
        │
        │  redocly build-docs                 openapi-typescript + a small
        │  ───────────────────►                hand-rolled operations table
        │                                              │
        ▼                                              ▼
  API Reference (this site)          packages/sdk/src/generated/{types,paths}.ts
                                       ("GENERATED — do not edit" banner)
                                                      │
                                                      ▼
                                        packages/sdk (the client every
                                        consumer — apps/web today, future
                                        native clients — imports)
```

`openapi.yaml` is the one artifact every other piece derives from — never
the reverse. Two consequences that are enforced, not just documented:

- **The SDK is never hand-edited.** `pnpm --filter @loombre/contract run
  codegen` regenerates it deterministically; the `sdk-drift` gate step
  (`git diff --exit-code -- packages/sdk`) fails if what's committed
  doesn't match what codegen produces right now.
- **Controllers are tested against the contract, not the other way
  around.** `apps/server/test/conformance.spec.ts` and
  `seeded-conformance.spec.ts` boot a real server and check it against
  `openapi.yaml` itself — including that every actually-mounted route is
  documented, not just that documented routes behave correctly.

## Evolution policy

Changes are additive-only within a major version (docs/PLAN.md §4.1) —
new endpoints, new optional fields, new enum values are fine; removing or
renaming a field, or changing its type, is not. `oasdiff` (a `pnpm gate`
step) diffs the current contract against `main` and fails on anything it
classifies as breaking. Deprecation uses `deprecated: true` plus a
`Sunset` header, held for two minor releases minimum, rather than deletion.

## See also

- [Contract-first workflow](../contract-workflow.md) — the
  concrete step-by-step for adding or changing an endpoint.
- [API Reference](../../api-reference/index.md) — the generated output itself.
