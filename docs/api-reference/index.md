# API Reference

*Generated directly from `packages/contract/openapi.yaml` — the same file every controller is tested against and the SDK is generated from. Never hand-written.*

<a href="./redoc.html" target="_blank" rel="noopener">
  <strong>Open the full API reference &rarr;</strong>
</a>

The reference above is a self-contained static page (built with
[Redocly](https://redocly.com/)'s `build-docs`) listing every endpoint,
request body, response shape, and error format Loombre's API exposes.
It's produced as part of `pnpm docs:build` — see
`scripts/docs/build-api-reference.mjs` if you're looking at the build
tooling rather than the API itself — and always reflects exactly what's
in `packages/contract/openapi.yaml` on this branch, because it's built
from that file, not maintained separately.

::: tip Building locally
The link above only resolves after a full `pnpm docs:build` run — it's a
generated artifact, not a source file in `docs/`, so it isn't present
under `pnpm docs:dev`. Run `pnpm docs:build` and open the built site to
browse it locally.
:::

## What's in the contract

- **~60 endpoints** under `/v1`, covering authentication, catalog browse
  and search, libraries, playback sessions, restricted-content unlock,
  users and permissions, jobs, system info and capabilities, and data
  export/import.
- **RFC 9457 error responses** (`application/problem+json`) throughout —
  one consistent error shape, not a different format per endpoint.
- **Cursor-based pagination** and **millisecond timestamps** everywhere a
  list or a time value appears (CLAUDE.md invariant 5).

## Evolution policy

Changes are additive-only within a major version — see
[Contract + generated SDK](../developer-guide/architecture/contract-and-sdk.md)
for the enforcement mechanism (`oasdiff`, run as a `pnpm gate` step) and
[Contract-first workflow](../developer-guide/contract-workflow.md) for how a
new endpoint actually gets added.
