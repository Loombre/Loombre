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
//   - `stash.provider.connected` (Stash OPEN ledger item 7): emitted by the
//     same apps/worker/src/stash/connect.ts the first time a connection
//     succeeds after any non-'ok' status — the success-path counterpart
//     to stash.provider.disabled, same instance-configuration-diagnostic
//     posture (which library, which schema version), transition-gated so
//     it fires once per real "just started working" moment rather than on
//     every per-scene metadata-fetch connect.
//   - `stash.provider.disconnected` (Stash OPEN ledger item 6): emitted by
//     packages/db/src/query/stash-connections.ts's
//     deleteLibraryStashConnectionAndEmit when an admin uses DELETE
//     /admin/libraries/{id}/stash-connection to forget a connection
//     entirely — instance-configuration bookkeeping (which library, when),
//     same posture as stash.provider.disabled/connected. Unlike those two
//     (always actorUserId: null, system-originated), this one carries the
//     acting admin's real user id at the envelope level — an admin HTTP
//     DELETE always has a human actor.
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
//   - `user.invited` / `user.invite-revoked` / `user.claimed` (STATE.md
//     "Optional mail transport + invitation & reset flows", E2, Lane A):
//     admin invite-creation/revocation bookkeeping and the claim outcome
//     (packages/db/src/query/invites.ts) — instance-administration/audit
//     data, same posture as user.restricted-pin-reset; none of the three
//     payloads carry token or password material.
//   - `user.password-reset` (E3/M14/M15, STATE.md "Optional mail
//     transport + invitation & reset flows", Lane B): emitted by
//     packages/db/src/query/identity.ts's resetUserPasswordAndEmit (CLI/
//     admin tiers) and src/query/password-reset.ts's
//     resetPasswordViaTokenAndEmit (self-service tier) — instance-
//     administration/audit activity, same posture as
//     user.restricted-pin-reset, not content any viewer-scoped predicate
//     should gate.
//   - `session.revoked-by-password-change` (G5, STATE.md "Current-password
//     re-auth on self-changes"): emitted by packages/db/src/query/
//     admin.ts's updateUserSelf whenever a self-service password change
//     bulk-revokes the caller's OTHER refresh tokens (F3) — instance-
//     administration/audit activity, same posture as user.password-reset;
//     payload {userId, username, revokedCount} never carries a token or
//     password.
//   - `remote.enabled` / `remote.disabled` / `remote.device.enrolled` /
//     `remote.device.revoked` / `remote.path.changed` /
//     `tunnel.connector.state` / `posture.regressed` / `posture.recovered` /
//     `probe.arrived` (STATE.md "Loombre Remote — embedded WireGuard +
//     three-path wizard + reachability proof + posture card", R9, Wave-0
//     freeze adjudication — not itself an R/RG-numbered decision, flagged
//     for the orchestrator at freeze): every mutation on the new
//     apps/server/src/remote/ admin surface is instance-security-posture
//     data (WireGuard peers, tunnel connector health, ACME/reverse-proxy
//     state, exposure-grading regressions) — same class as plugin.*/
//     user.invited/session.revoked-by-password-change above, never content
//     any viewer-scoped predicate should gate, and R9's own "no secrets in
//     payloads" rule (no keys, no tokens, no config text) makes every one
//     of these payloads ids/names/timestamps only. `remote.device.enrolled`/
//     `remote.device.revoked` carry a `userId` (the device owner, not
//     necessarily the acting admin) but stay admin-only regardless — same
//     posture as `user.invited` carrying an eventual claimant's preset
//     username while remaining admin-only throughout.
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
  // Stash OPEN ledger item 7 (success-connect counterpart to disabled).
  "stash.provider.connected",
  // Stash OPEN ledger item 6 (admin DELETE — forget a connection entirely).
  "stash.provider.disconnected",
  // Stash SQLite metadata sync, S8/K12 (Lane C sync engine).
  "stash.sync.started",
  "stash.sync.completed",
  // Optional mail transport run, E6/M6.
  "mail.failed",
  // Optional mail transport + invitation & reset flows, E2 (Lane A).
  "user.invited",
  "user.invite-revoked",
  "user.claimed",
  // E3/M14/M15 (Optional mail transport + invitation & reset flows, Lane B).
  "user.password-reset",
  // G5 (Current-password re-auth on self-changes).
  "session.revoked-by-password-change",
  // Loombre Remote — embedded WireGuard + three-path wizard + reachability
  // proof + posture card (R9, Wave-0 freeze adjudication).
  "remote.enabled",
  "remote.disabled",
  "remote.device.enrolled",
  "remote.device.revoked",
  "remote.path.changed",
  "tunnel.connector.state",
  "posture.regressed",
  "posture.recovered",
  "probe.arrived",
];

// NOT added above, deliberately (STATE.md "Admin broadcast notifications —
// system notices", N2/NG1): `notice.published` / `notice.cancelled` are
// ALL-USER broadcast events by definition — every notice this pair
// announces is meant for every authenticated user, admin or not, so they
// fall through the ws-broadcaster's default path (the SAME fallthrough
// user.created already relies on) rather than being gated here. Recorded
// at this canonical list per N2's "recorded as such at the canonical list
// with a comment" — this file is the L3 canonical source of the
// admin-only classification, so its absence from ADMIN_ONLY_EVENT_TYPES
// above is itself the decision, and this comment is the record of it
// being deliberate rather than an oversight.
