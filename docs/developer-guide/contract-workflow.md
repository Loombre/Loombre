# Contract-first workflow

<!-- Sourcing: openapi.yaml size (5311 lines, 85 top-level path keys) and
     codegen output location/mechanism — packages/contract/openapi.yaml,
     packages/contract/scripts/codegen.mjs (openapi-typescript for types,
     a hand-rolled operations table for paths, "GENERATED — do not edit"
     banner, output to packages/sdk/src/generated/{types,paths}.ts).
     Conformance tests — apps/server/test/conformance.spec.ts (unauthenticated
     401 wall over every non-public op, Ajv schema validation of public ops,
     every mounted route maps to a documented contract path) and
     apps/server/test/seeded-conformance.spec.ts. Gate step order —
     scripts/gate.mjs. -->

CLAUDE.md's invariant 1: **`packages/contract/openapi.yaml` is the source
of truth.** Controllers conform to it (and are tested for that), the SDK is
generated from it, and neither is ever hand-written to differ from it. This
page is the concrete workflow that invariant implies.

## The contract itself

`packages/contract/openapi.yaml` is a single ≈8,300-line file describing
132 paths under `/v1` (figures as of 2026-08 — the file only grows;
`wc -l` and a count of its `paths:` keys are the live truth). It's lint-checked
(`redocly lint openapi.yaml`, `packages/contract`'s own `lint` script) and
is what the [API Reference](../api-reference/index.md) is generated from — the same
file, no separate description to keep in sync.

## Adding or changing an endpoint

```
┌─────────────────────┐
│ 1. Edit              │
│ openapi.yaml          │
└──────────┬───────────┘
           │
           ▼
┌─────────────────────┐     regenerates packages/sdk/src/generated/
│ 2. pnpm --filter      │     {types,paths}.ts from the contract via
│ @loombre/contract       │     openapi-typescript + a small hand-rolled
│ run codegen            │     operations table
└──────────┬───────────┘
           │
           ▼
┌─────────────────────┐     gate step: git diff --exit-code -- packages/sdk
│ 3. Commit the          │     — the generated SDK must be committed and
│ generated SDK diff     │     must exactly match what codegen produces.
└──────────┬───────────┘     Never hand-edit files under packages/sdk/src/
           │                  generated/ — the "GENERATED — do not edit"
           │                  banner at the top of each is not a suggestion.
           ▼
┌─────────────────────┐     gate step: oasdiff breaking PREVIOUS.yaml
│ 4. oasdiff checks      │     CURRENT.yaml, against `main`. Field removal,
│ for breaking changes   │     rename, or type change fails here (docs/PLAN.md
└──────────┬───────────┘     §4.1: "additive-only within a major version").
           │
           ▼
┌─────────────────────┐
│ 5. Implement/adjust    │
│ the controller         │
└──────────┬───────────┘
           │
           ▼
┌─────────────────────┐     apps/server/test/conformance.spec.ts +
│ 6. Conformance tests   │     seeded-conformance.spec.ts must pass — every
│ must pass               │     non-public op returns a proper 401 when
└──────────┬───────────┘     unauthenticated, public ops validate against
           │                  their documented schema, and every mounted
           │                  route maps to something actually documented
           │                  (no undocumented surface area).
           ▼
┌─────────────────────┐
│ 7. pnpm gate            │
└─────────────────────┘
```

## What conformance testing actually checks

`apps/server/test/conformance.spec.ts` boots a real Nest application
against a seeded database and walks the contract itself as its test data —
there's no separately maintained list of "endpoints to check." For every
documented, non-public operation it asserts an unauthenticated request
gets a proper RFC 9457 `401`. The public operations — 10 today, spanning
the auth pair, system capabilities, the setup pair, the invite-claim
pair, the password-recovery pair, and the remote-access probe page; the
spec's own `PUBLIC_OPERATION_IDS` set is the live list — are exempt from
that 401 walk, and several of them (`GET /system/capabilities`,
`POST /auth/login`'s TokenPair, `GET /setup/state`,
`POST /auth/forgot-password`) get their responses validated against the
contract's own schemas via Ajv, alongside Ajv checks of RFC 9457 problem
bodies throughout. For authenticated requests it asserts they're not
walled off; and it asserts `/healthz` stays public. Crucially, it also asserts that **every route
Express actually has mounted maps to a documented contract path** — an
endpoint that exists in code but not in `openapi.yaml` fails this check,
not just the reverse.

## Why this order

`sdk-drift` and `oasdiff` run early in `pnpm gate` (right after `codegen`)
because they're structural checks over the contract and its generated
artifact — cheap, and a failure there means the rest of the gate is
checking against a contract state that isn't what will actually ship. See
`scripts/gate.mjs`'s own header comment for the full step order and the
reasoning behind each step's position.
