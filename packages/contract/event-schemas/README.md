# Event schemas

JSON Schema (draft 2020-12) for the domain event outbox and its websocket
broadcast at `/v1/events` (docs/PLAN.md §4.3). Every event delivered over the
socket, and every row written to the `events` outbox table, validates against
`envelope.schema.json`, whose `payload` is validated against the schema file
named `<type>.schema.json` (dots replaced 1:1, e.g. `item.added` ->
`item.added.schema.json`).

## Evolution policy — additive-only

These schemas follow the same additive-only policy as the REST contract
(docs/PLAN.md §4.1):

- New event `type` values may be added to `envelope.schema.json`'s `type`
  enum at any time; existing consumers that don't recognize a new type
  simply ignore it.
- New **optional** fields may be added to any payload schema.
- Existing fields may never be removed, renamed, or have their type
  narrowed/changed. A field that must go away is deprecated in the field's
  `description` (documented, not deleted) for at least two minor releases.
- `additionalProperties: false` is intentional on every payload — a schema
  change that needs a new field is always a schema PR, never a silent
  passthrough field.

Consumers today: the websocket broadcaster and the activity log. Designed
so that webhooks, recommendations, scrobble/export sync, and plugins
(docs/PLAN.md §4.4) can be built against this same event stream without
touching any code path that emits.

## Admin-only event types

`envelope.schema.json`'s top-level `x-loombre-admin-only-event-types` array
(a validation-inert custom keyword — JSON Schema does not execute it) is a
machine-readable MIRROR of the canonical admin-only event-type list at
`packages/shared/src/admin-only-event-types.ts` (L3, owner brief): the
subset of `type.enum` that is instance-administration/operational data,
never delivered to a non-admin websocket socket
(`apps/server/src/gateway/ws-broadcaster.service.ts`) and never grantable
to a plugin's event-subscriber capability
(`apps/server/src/plugins/plugin-registration.service.ts`'s
`validateGrantAgainstManifest`). A JSON Schema artifact cannot import
TypeScript, so this array exists purely so the classification is
machine-readable somewhere in the contract; the actual gate is TypeScript
code. `packages/contract/test/admin-only-event-types-parity.spec.ts` diffs
this array against the canonical list on every test run and fails on any
delta, naming both files and the differing entries. Edit the canonical TS
list first, then mirror the change here — the parity test is what proves
you did both.
