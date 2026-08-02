// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/admin-only-event-types.ts
//
// THE canonical list of outbox event `type`s (packages/contract/
// event-schemas/envelope.schema.json's `type.enum`) that are instance-
// administration/operational data, never content any viewer-scoped
// predicate should gate, and therefore never reach a non-admin socket and
// never something a plugin's event-subscriber capability may request a
// grant for (H-4 fix wave; H2). This module is the SINGLE SOURCE for that
// classification — L3 (owner brief) closed a five-copy drift (one of the
// five, apps/web/src/components/admin/EventLogPanel.tsx, had already gone
// stale, silently omitting `user.restricted-pin-reset`). Every other site
// now DERIVES from here rather than keeping its own list:
//
//   - apps/server/src/plugins/event-taxonomy.ts re-exports this constant
//     unchanged (both its own importers — ws-broadcaster.service.ts and
//     plugin-registration.service.ts's validateGrantAgainstManifest — keep
//     working); getOutboxEventTaxonomy() still computes envelope-enum
//     MINUS this set.
//   - apps/worker/src/plugin-delivery/constants.ts re-exports this
//     constant as `LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES` (apps/worker
//     already depends on @loombre/shared — the old "apps/worker cannot
//     import apps/server" duplication rationale no longer applies once the
//     canonical list lives in a package both apps can import).
//   - apps/server/src/gateway/ws-broadcaster.service.ts derives
//     transitively through event-taxonomy.ts's re-export (never imports
//     this module directly).
//   - packages/contract/event-schemas/envelope.schema.json cannot import
//     TypeScript (it's a JSON Schema artifact) — it instead carries a
//     machine-readable mirror at its top-level
//     `x-loombre-admin-only-event-types` key, and
//     packages/contract/test/admin-only-event-types-parity.spec.ts diffs
//     that array against this list on every test run, failing loudly (both
//     file paths + the differing entries named) on any drift.
//   - apps/web/src/components/admin/EventLogPanel.tsx does not import this
//     module (the admin UI performs no admin-only filtering by
//     construction — admin-only types only ever reach an admin socket in
//     the first place) — it carries a prose comment pointing here instead.
//   - packages/contract/event-schemas/metadata.match-candidates.schema.json's
//     `description` points here rather than re-explaining the
//     classification inline.
//
// LPP event-grant surface (pointer for W4 of the plugin-platform run, when
// it lands): the LPP event-grant surface — apps/server/src/plugins/
// plugin-registration.service.ts's validateGrantAgainstManifest (the
// registration-time taxonomy check) and apps/worker/src/plugin-delivery/
// delivery-loop.ts (the defense-in-depth fanout filter) — must consume
// this SAME canonical list, directly or via the two re-exports above.
// Start here.
//
// Provenance, by group:
//   - `job.updated`, `settings.updated`, and the six `plugin.*` types
//     (H-4 fix wave): before this fix, a plugin's manifest could REQUEST
//     any of these, an admin could GRANT it, and the delivery loop had no
//     admin-only gate at all — an out-of-process third party could receive
//     `plugin.updated` (another plugin's full baseUrl/config/grants),
//     `settings.updated` (every server-setting value), or `job.updated`
//     purely by grant, on a platform that otherwise refuses to show any of
//     this to a logged-in non-admin USER over the very same live-event
//     mechanism.
//   - `metadata.match-candidates` (Phosphor retheme Wave 2, Lane L2 — Fix
//     Match): admin-tool operational data (a bounded provider-search
//     result for one admin's Fix Match flow), not a catalog event any
//     content-scoped viewer predicate could sensibly gate.
//   - `user.restricted-pin-reset` (H2, owner brief): instance-
//     administration/audit activity emitted by the server-local
//     `loombre admin reset-pin <username>` CLI command
//     (packages/db/src/query/identity.ts's resetRestrictedPinAndEmit), not
//     content any viewer-scoped predicate should gate.
//   - `probe.failed` (owner ledger L1, adjudication A-2): a terminal probe
//     job failure (apps/worker/src/probe/terminal-failure-hook.ts, wired
//     through packages/jobs/src/queue.ts's onTerminalFailure seam) —
//     instance-administration/diagnostic data (which library-relative path
//     failed to probe and why), not content any viewer-scoped predicate
//     should gate, same posture as scan.completed's own skip-visibility
//     fields.
//   - `stash.provider.disabled` (STATE.md "Stash SQLite metadata sync",
//     S3/K12): emitted by apps/worker/src/stash/connect.ts when a
//     library's Stash SQLite database reports a schema_migrations version
//     outside the pinned supported range — instance-configuration
//     diagnostic data (which library, which schema version, the exact
//     admin notice), same posture as probe.failed.
//   - `stash.sync.started` / `stash.sync.completed` (STATE.md "Stash
//     SQLite metadata sync", S8/K12, Lane C sync engine): emitted by
//     apps/worker/src/stash/sync-consumer.ts around a `stash-sync` job
//     run — instance-operational bookkeeping (which library, which mode,
//     match/update/unmatched/stale/skipped counts), same posture as
//     stash.provider.disabled, not content any viewer-scoped predicate
//     should gate.
//   - `mail.failed` (optional mail transport run, E6/M6): emitted by
//     apps/worker/src/mail/terminal-failure-hook.ts around a terminal
//     'mail-send' job failure — instance-operational/diagnostic data (which
//     template, which destination, the real SMTP conversation error, which
//     job), same posture as probe.failed, not content any viewer-scoped
//     predicate should gate.
//
// Dependency-free data only (no zod, no I/O) — importable from
// apps/server, apps/worker, and (via the prose pointer above, not a real
// import) documented for apps/web without dragging in any of their
// runtimes, following the packages/shared/src/language-codes.ts precedent.
export const ADMIN_ONLY_EVENT_TYPES: readonly string[] = [
  // H-4 fix wave.
  "job.updated",
  "settings.updated",
  "plugin.registered",
  "plugin.updated",
  "plugin.enabled",
  "plugin.disabled",
  "plugin.removed",
  "plugin.health-changed",
  // Phosphor retheme Wave 2, Lane L2 (Fix Match).
  "metadata.match-candidates",
  // H2 (owner brief).
  "user.restricted-pin-reset",
  // Owner ledger L1 (adjudication A-2).
  "probe.failed",
  // Stash SQLite metadata sync, S3/K12.
  "stash.provider.disabled",
  // Stash SQLite metadata sync, S8/K12 (Lane C sync engine).
  "stash.sync.started",
  "stash.sync.completed",
  // Optional mail transport run, E6/M6.
  "mail.failed",
];
