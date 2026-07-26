# Event subscription mechanics

<!-- Sourcing: packages/plugin-protocol/spec/lpp-v1.md §4.2 (event-subscriber
     wire shapes, delivery mechanics, signing/verification pseudocode,
     replay window 300000ms default), apps/worker/src/plugin-delivery/
     constants.ts (LPP_DELIVERY_RETENTION_WINDOW_MS = 7 days,
     LPP_DELIVERY_BATCH_MAX = 100, LPP_DELIVERY_POLL_INTERVAL_MS = 5s,
     LPP_DELIVERY_BACKOFF_BASE_MS/LPP_DELIVERY_BACKOFF_MAX_MS = 2s..5min),
     delivery-loop.ts (GAP SEMANTICS comment, at-least-once/cursor-advance-
     only-on-2xx), actor-field-map.ts (pseudonymization applies per envelope
     type), examples/lpp-discord-notifier/server.mjs (a complete, minimal
     subscriber implementation). -->

This page is the operational detail an `event-subscriber` plugin author
needs beyond the wire shapes themselves (those are in
[the spec](spec.md)'s "Capabilities" → `event-subscriber` section) — what to
actually expect showing up at your delivery endpoint, and what your plugin
is responsible for handling correctly.

## Batches, not single events

Loombre never sends one event per request. Every delivery to your
`delivery.endpoint` is a **batch**:

```json
{
  "batchId": "<uuid>",
  "events": [
    { "id": "<uuid>", "type": "item.added", "occurredAtMs": 1234567890123, "payload": { "…": "…" } }
  ],
  "gapReport": null
}
```

`events` always has at least one entry — an empty batch is never sent.
`gapReport` is always present as a key, `null` when there's nothing to
report (see [Gap reports](#gap-reports) below).

## At-least-once, and idempotency is on you

Loombre keeps exactly one delivery cursor per plugin and advances it only
after a batch is acknowledged. If your plugin was unreachable, crashed
mid-processing, or the acknowledging response itself got lost in transit,
the *same* batch — same `batchId`, same event `id`s — may be delivered
again. Your plugin **must** be safe to process the same event `id` more
than once (the simplest approach: track the highest `occurredAtMs`/`id`
you've already handled and skip anything at or before it, or de-duplicate
on `id` directly if your downstream system supports it).

## Acknowledgement is implicit

Any `2xx` HTTP status in response to a delivery POST acknowledges the
*whole* batch — there's no separate ack message, no per-event
acknowledgement. Respond with anything outside the `2xx` range (or don't
respond before the delivery timeout) and Loombre treats the batch as
unacknowledged: the cursor doesn't advance, and it's retried later,
subject to backoff.

Operationally, on the host side: a plugin's delivery queue is polled every
few seconds, each tick reads up to a bounded number of pending outbox rows
per plugin, and a plugin currently failing is retried on an increasing
delay (capped, not unbounded) rather than hammered continuously — none of
that changes the wire contract above, but it's useful context for what
"eventually delivered" actually means in practice: a healthy plugin sees a
new event within single-digit seconds; a plugin that's been failing sees
its next attempt further and further out, up to a several-minute ceiling,
until it succeeds again.

## Cursor resume

The delivery cursor is durable, not in-memory — if Loombre itself restarts
(or the delivery process specifically does), delivery for your plugin
picks back up exactly where it left off rather than replaying everything
or skipping ahead. You don't need to do anything to get this; it's purely
host-side. What it means for you: don't assume a gap in wall-clock time
between deliveries means anything was lost — a quiet period is far more
likely to just mean nothing new happened, or the host was briefly down and
caught back up.

## Gap reports

Loombre keeps a bounded backlog of undelivered activity for a plugin that
isn't currently reachable — but that backlog isn't unlimited. If your
plugin is unreachable for longer than the backlog window covers, the
oldest events that fell outside it are given up on rather than kept
forever or silently skipped without a trace: the *next* batch you do
receive carries a non-null `gapReport` describing exactly what was lost:

```json
{
  "gapReport": {
    "detectedAtMs": 1234567890123,
    "gaps": [{ "fromMs": 1234500000000, "toMs": 1234560000000, "reason": "…" }]
  }
}
```

Treat this as authoritative bookkeeping, not just a log line — if your
plugin maintains any kind of derived state from the activity feed (a
running count, a "last seen" timestamp per item), a gap report is your
signal that state may now be incomplete for the reported window.

## Verifying every delivery

Every batch carries `X-LPP-Signature: t=<unix-ms>,v1=<hex hmac-sha256 of
"<t>.<raw body>">`, signed with the delivery secret minted for your plugin
at registration (a separate value from any `secret: true` config field —
see [Building your first plugin](building-a-plugin.md) for the full
verification walkthrough with real code). Two things specific to
subscribers are worth restating here:

- **Signature verification is a MUST.** A subscriber that doesn't check
  this is a subscriber that will act on anything anyone sends to its
  endpoint, not just genuine Loombre deliveries.
- **Replay-window enforcement is a SHOULD**, checked against the `t`
  timestamp in the header. The protocol's default window is 300000ms (5
  minutes) — a delivery signed further in the past (or the future — clock
  skew goes both ways) than that should be rejected even though its
  signature is otherwise valid, since a captured-and-replayed request
  would still carry a technically-valid signature.

## The pseudonymous-ids caveat

By default, any actor/user id that appears inside an event `payload` has
been pseudonymized by the host before delivery — a stable, per-plugin
anonymous id, not a real account identifier, and **not** stable across
different plugins (the same real account gets a different anonymous id
per subscriber). The same treatment applies to the `deviceId`/`sessionId`
fields on the `playback.*` event types: they're stable per device/session
so you can still tell "the same device again" apart from "a different
device", but they're pseudonymized the same way a user id is, and are
equally not stable across different plugins. An admin can turn this off
per-plugin from the admin Plugins screen, but the default is on, and your
plugin **must not assume** any id in a payload is a real,
cross-referenceable identifier unless you have specific reason to believe
that admin has disabled pseudonymization for your registration. If your
plugin's whole purpose depends on real identity (a scrobbling integration
tied to a specific external account, for example), document that
requirement clearly for the admin installing it — it's their explicit
choice to make, not something to assume.
