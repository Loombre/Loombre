# Developer Guide

*This guide is for developers — it assumes you can code, but not that you already know this codebase.*

Loombre is a ground-up, contract-first media server: PostgreSQL-backed,
TypeScript throughout, one OpenAPI contract driving a generated SDK, and a
playback decision engine that's a pure function with an offline test
matrix. This guide is the fastest path from a clean clone to a productive,
gate-passing contributor.

## Start here

1. **[Clean clone to green gate](getting-started.md)** — the real commands, in order.
2. **[Contract-first workflow](contract-workflow.md)** — how an endpoint actually gets added.
3. **[Glossary](glossary.md)** — every piece of internal shorthand, defined once.

## Architecture tour

One page per pillar, each with its own diagram:

- **[Contract + generated SDK](architecture/contract-and-sdk.md)**
- **[Catalog, query guard & restricted content](architecture/catalog-query-guard.md)**
- **[Playback engine & matrix law](architecture/playback-engine.md)**
- **[Jobs, worker & outbox](architecture/jobs-worker.md)**
- **[Packaging & release](architecture/packaging-release.md)**
- **[Performance budgets](architecture/performance-budgets.md)**

## Deep dives

- **[Adding a metadata provider](add-a-provider.md)**
- **[Authoring a matrix case](matrix-authoring.md)**

## Plugin developer kit

Loombre supports out-of-process plugins over a small, frozen HTTP protocol
(the Loombre Plugin Protocol, or LPP) — separate services Loombre never
loads code from, only talks to. Start at the
**[plugin developer kit overview](plugins/index.md)** for the protocol
posture, the frozen spec (surfaced from its single source, never
hand-copied), a walkthrough building a plugin from the two reference
implementations in this repository, conformance testing, event-subscriber
mechanics, and the roadmap of capability types that are designed but not
yet built.

## The authoritative specs

This guide is a tour, not a replacement for the specs that actually govern
design decisions and win disagreements:

- **`docs/PLAN.md`** (in the repository, not published to this site — it's
  an internal spec) — the full technical development plan.
- **`docs/PLAYBACK.md`** (same — internal spec, not published) — the
  playback engine specification in full: the decision algorithm, the
  complete reason taxonomy, and the test matrix requirements.
- **`CLAUDE.md`** (repository root) — the short list of architecture
  invariants that fail review if violated.

If this guide and one of those specs ever disagree, the spec wins — please
file an issue so the guide can be corrected.
