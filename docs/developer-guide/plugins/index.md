# Plugin developer kit

<!-- Sourcing: packages/plugin-protocol/spec/lpp-v1.md §0 (status/scope,
     process model, host-side guarantees, no-telemetry statement), §6
     (versioning policy), packages/plugin-protocol/src/version.ts +
     envelope.ts (LPP_PROTOCOL_VERSION = 1) + capabilities/*.ts (the two
     shipped capability types), examples/lpp-reference-provider/server.mjs + examples/
     lpp-discord-notifier/server.mjs (both zero-dependency, stdlib-only —
     proof this is implementable in any language/host). STATE.md's "LPP v1
     — Loombre Plugin Protocol" section (C1-C9, mission summary). -->

Loombre supports plugins — separate, out-of-process programs that extend
what Loombre can do, communicating entirely over HTTP. This is the **Loombre
Plugin Protocol (LPP)**, and this section is the developer-facing kit for
it: the frozen wire contract, how to write a plugin against it, how to
check your work, and what's coming next.

If you're looking for the end-user/admin side of this (registering a
plugin, what each capability means for privacy, provider chains, health
and auto-disable), that's the [Admin Guide's Plugins chapter](/admin-guide/plugins)
instead — this section is for people writing plugin code.

## Protocol posture

A few things are true about LPP by design, and worth internalizing before
writing a line of code:

- **Out-of-process, over HTTP, in any language.** A plugin is any HTTP(S)
  service, written in whatever language or runtime you like, that
  implements the endpoints the spec describes. Loombre never downloads,
  compiles, imports, or otherwise executes plugin code — it only ever
  sends LPP requests and reads LPP responses/deliveries. Both reference
  plugins in this repository (`examples/lpp-reference-provider`,
  `examples/lpp-discord-notifier`) are proof of this: they're plain Node
  `http`/`https`/`crypto` servers with **zero npm dependencies**, and
  neither imports `@loombre/plugin-protocol` — everything they do is
  implementable by a real third party working from the spec document
  alone.
- **A plugin has no access to Loombre's internals.** No database
  connection, no filesystem access into the Loombre install, no
  visibility into anything beyond the request it's currently handling.
  The wire surface described in the spec is the entire interface.
- **Additive-only versioning.** LPP v1 may grow new *optional* fields on
  any schema without a version bump — that's what "v1" being frozen
  means: existing required fields and shapes don't change out from under
  you. A genuinely breaking change would be a new protocol version (a
  hypothetical LPP v2) running *beside* v1, not replacing it. New
  **capability types** are the intended extension point for whole new
  kinds of plugin behavior — see the [roadmap](roadmap.md) for what's
  designed but not yet built.
- **`protocolVersion` negotiation.** Every manifest declares
  `protocolVersion: 1`. A host that only speaks LPP v1 rejects anything
  else at registration with a clear error rather than guessing. If a v2
  ever exists, a host speaking both would read this field at registration
  time and route the plugin to the matching version's handling.
- **No telemetry, anywhere in this.** Neither the host nor the protocol
  itself carries any telemetry, analytics, or phone-home mechanism. The
  *only* data Loombre ever sends a plugin proactively is an event-
  subscriber's delivery batch — and only for event types an admin has
  explicitly granted.

## The two shipped capability types

- **`metadata-provider`** — fetch-shaped: Loombre calls out to search for,
  fetch details about, and fetch images for an item. Built for looking up
  movies, TV, and music metadata; the same interface Loombre's own
  built-in TMDB/TVDB/MusicBrainz providers are internally adapted onto.
- **`event-subscriber`** — push-shaped: Loombre delivers batches of
  activity-feed events to the plugin's own endpoint, signed and
  at-least-once.

A manifest can declare either, both, or (per the roadmap) future
capability types this Loombre version doesn't yet recognize — which is
rejected cleanly at registration, per capability entry, rather than
silently ignored or failing the whole manifest.

## Where to go next

1. **[The frozen LPP v1 spec](spec.md)** — the actual contract: every request/
   response shape, the header format, the error model. Generated straight
   from the package that defines it — never hand-copied, so it can't drift.
2. **[Building your first plugin](building-a-plugin.md)** — a walkthrough
   grounded in both reference plugins, with real file references.
3. **[Conformance testing](conformance.md)** — checking a running plugin
   against the spec automatically.
4. **[Event subscription mechanics](events.md)** — the details an
   event-subscriber author needs: batching, delivery guarantees, cursors,
   gaps, and the pseudonymization caveat.
5. **[Roadmap: future capabilities](roadmap.md)** — what's designed but not
   yet implemented, and why `auth-provider` specifically isn't on this
   list yet.
