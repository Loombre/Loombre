# Conformance testing

<!-- Sourcing: packages/plugin-protocol/src/conform/cli.ts (usage/flags),
     run.ts (suite dispatch by declared capability type), manifest-checks.ts
     (envelope.* checks), metadata-provider-suite.ts (metadata-provider.*
     checks), event-subscriber-suite.ts (event-subscriber.* checks),
     report-format.ts (PASS/WARN/FAIL report shape, exit code), root
     package.json's "lpp:conform" script, packages/plugin-protocol/spec/
     lpp-v1.md §7 (conformance), test/integration.spec.ts (both reference
     plugins pass in full — the automated proof this page describes). -->

`packages/plugin-protocol` ships a conformance CLI that fetches a running
plugin's manifest and, for every capability it declares, runs that
capability's own test suite against it — no Loombre server required, just
your plugin listening somewhere reachable.

## Running it

```
pnpm lpp:conform <url> [--secret <hex>] [--config <json>] [--secret-field NAME=value] [--timeout <ms>] [--replay-window <ms>]
```

- `<url>` — your plugin's base URL (e.g. `http://localhost:4000`). Required.
- `--secret <hex>` — the delivery-signing secret to sign test batches with,
  for an `event-subscriber` capability's suite. Without it, the suite still
  runs but every signature-dependent check is skipped with a warning
  instead of exercised.
- `--config <json>` — a JSON object sent as `X-LPP-Config`, exactly as a
  real host would inject it, for plugins whose endpoints need config
  values to behave sensibly.
- `--secret-field NAME=value` — repeatable; each one is sent as
  `X-LPP-Secret-<NAME>`, mirroring how a real host injects a `secret: true`
  config field.
- `--timeout <ms>` — per-request timeout (default `10000`).
- `--replay-window <ms>` — the window used for the `event-subscriber`
  suite's stale-timestamp check (default `300000`, matching the protocol's
  own default).

It prints a human-readable report and exits non-zero **iff any check
failed** — a clean run with only warnings still exits `0`.

Both reference plugins in this repository pass the full suite:

```
node examples/lpp-reference-provider/server.mjs &
pnpm lpp:conform http://127.0.0.1:<printed-port>

LOOMBRE_LPP_SIGNING_SECRET=<hex> node examples/lpp-discord-notifier/server.mjs &
pnpm lpp:conform http://127.0.0.1:<printed-port> --secret <hex>
```

and `packages/plugin-protocol/test/integration.spec.ts` runs exactly this
as its own automated proof, spawning both plugins as child processes and
asserting a clean report from each.

## What each suite checks

Every run starts with the **envelope** checks (regardless of declared
capabilities): the manifest fetches, parses as JSON, matches the LPP v1
envelope schema, and declares a supported `protocolVersion` and a
non-empty `capabilities` array. A manifest that fails any of these never
reaches a capability-specific suite at all — there's nothing valid to test
against.

For each declared capability, a dedicated suite then runs:

**`metadata-provider`** — round-trips `search`/`details`/`images` with a
well-formed probe request and checks the response against the exact
schemas the spec defines, plus that a deliberately malformed request gets
back an RFC 9457 `application/problem+json` 4xx rather than a crash or a
silent 200. Checks include things like
`metadata-provider.search.status`/`.schema`/`.results`,
`metadata-provider.details.status`/`.schema`, `metadata-provider.images.status`/`.schema`,
and the matching `.malformed` check per endpoint.

**`event-subscriber`** — sends a real, correctly-signed test batch to the
plugin's delivery endpoint and confirms it's acknowledged with a `2xx`
(`event-subscriber.delivery.validSignature`); sends the same batch with a
tampered body so the signature no longer matches, and checks it's rejected
(`event-subscriber.delivery.tamperedBody`); sends a validly-signed but
stale-timestamped batch and checks it's rejected too
(`event-subscriber.delivery.staleTimestamp`). If no `--secret` was
supplied, all three are reported instead as
`event-subscriber.signature.skipped`.

## Reading the pass/warn/fail marks

Each individual check gets exactly one of three marks:

- **PASS** — behaves exactly as the spec requires.
- **WARN** — a **SHOULD**, not a **MUST**, that this plugin doesn't
  satisfy — most commonly the replay-window enforcement
  (`.staleTimestamp`) or a search returning zero results for the probe
  query (`.results`, which is a legitimate outcome for a fixture provider,
  just one the suite can't confirm did anything real). A report with only
  warnings still exits `0` — your plugin is spec-conformant, just not
  maximally hardened.
- **FAIL** — a **MUST** the plugin violates: a malformed response, a
  missing schema field, a rejected valid signature, an accepted tampered
  one. Any FAIL makes the whole run exit non-zero.

The report ends with a `<pass> passed, <warn> warned, <fail> failed` line
and a final `RESULT: PASS`/`RESULT: FAIL`.
