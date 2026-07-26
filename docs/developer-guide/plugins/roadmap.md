# Roadmap: future capabilities

<!-- Sourcing: STATE.md's "LPP v1 — Loombre Plugin Protocol" section, "§4
     roadmap (dev kit, 'designed not yet implemented')" line and the LPP
     mission brief it records verbatim: "subtitle-provider · scrobble-sink
     · intro-detection (job-shaped, sketched) · auth-provider (EXPLICITLY
     deferred — security boundary, needs its own adversarial design cycle,
     roadmap says so in those words) · UI/theme extensions (out of LPP
     scope entirely)." packages/plugin-protocol/spec/lpp-v1.md §6
     (versioning policy — new capability types are the additive extension
     point; adding one never changes the manifest envelope). Nothing on
     this page describes a schema, endpoint, or type that exists in
     packages/plugin-protocol today — every entry below is explicitly
     unimplemented design intent, not a preview of shipped code. -->

Everything else in this developer kit documents LPP v1 as it actually
ships today: the frozen envelope, and two complete capability types
(`metadata-provider`, `event-subscriber`). This page is different — it's
the roadmap of capability types that are **designed, not yet
implemented**. None of what follows exists in `packages/plugin-protocol`
today; nothing here is a schema you can target, a header you can send, or
an endpoint you can call. Treat it as a statement of direction, not a
preview of shipped behavior.

The reason this roadmap can exist at all without touching anything already
frozen is LPP's own versioning policy (see [the spec](spec.md)'s "Versioning
policy" section): a new **capability type** is an additive entry in the
manifest's capability discriminated union. Adding one is, by design,
supposed to require **zero changes** to the core protocol envelope, the
registration flow, the health/breaker model, the SSRF/LAN-allowlist rules,
or the content-class scoping rules — every capability type that exists or
will ever exist rides on that same shared substrate. Each entry below is
framed with that constraint in mind.

## `subtitle-provider`

**Shape:** fetch-shaped, the same request/response pattern as
`metadata-provider` — Loombre calls out with a lookup request (item
identity, language) and the plugin returns candidate subtitle results
Loombre can then fetch and attach. Would reuse the same content-class
scoping (a restricted-scoped subtitle source only ever serving restricted
libraries) and the same per-call timeout/breaker substrate every other
fetch-shaped capability already uses.

## `scrobble-sink`

**Shape:** a *profiled* `event-subscriber` — rather than a new wire
mechanism, this would be a narrower, purpose-built manifest declaration on
top of the existing event-subscriber capability (a fixed, smaller
`eventTypes` shape and delivery contract tuned specifically for
"something started/finished playing" style scrobbling integrations, with
its own conformance suite checking the profile's specific expectations).
Delivery batching, at-least-once semantics, cursor resume, gap reporting,
and the pseudonymous-ids default would all carry over unchanged from
`event-subscriber` as it exists today.

## `intro-detection`

**Shape:** job-shaped — a genuinely new pattern, distinct from both
existing capability types. Where `metadata-provider` is Loombre asking a
quick question and `event-subscriber` is Loombre pushing a feed, this
would be Loombre *offering work*: here's a piece of media, analyze it, and
return segment markers (intro/credits boundaries) once you're done. That
implies a **job-capability pattern** LPP doesn't have yet — something like
a plugin polling or being notified of available work, claiming a job,
and returning a typed result asynchronously, rather than the
request-immediately-get-a-response shape `metadata-provider` uses today.
Sketched here as design intent, not specified: the actual claim/poll/
result wire shapes, timeout budget for a long-running analysis job (very
different from a 10-20 second fetch-shaped call), and how a job-shaped
capability interacts with Loombre's existing job queue are all open
questions a real design pass would need to answer before this becomes
buildable.

## `auth-provider` — explicitly deferred

**`auth-provider` is explicitly deferred.** Unlike every other entry on
this page, it isn't simply "not yet built" — it's being deliberately held
back because it **touches the security boundary and requires its own
adversarial design cycle**, separate from and more demanding than the
design work behind any other capability type. Delegating authentication
decisions to an out-of-process, third-party plugin is a fundamentally
different risk profile than a plugin answering "what's this movie called"
or "tell me when someone starts watching something" — a flawed
`auth-provider` design doesn't just leak or misroute data, it can
compromise who's allowed into the system at all. That warrants a dedicated
threat model, its own adversarial review pass, and its own explicit
sign-off before any wire shape is drafted, let alone frozen. Nothing about
LPP v1's additive extension mechanism blocks `auth-provider` from
eventually existing — but it does not get a sketch on this page the way
`intro-detection` does, precisely because sketching it prematurely is the
kind of shortcut this deferral exists to prevent.

## UI/theme extensions — out of LPP scope entirely

Visual customization — themes, custom UI panels, client-side extensions —
is **not** a capability type candidate at all, now or later. LPP is a
protocol for an out-of-process *service* Loombre calls over HTTP; nothing
about that model fits injecting code, markup, or styling into Loombre's
own UI, which would mean exactly the kind of in-process code loading C1
rules out for every other kind of plugin. If Loombre ever supports this
kind of customization, it would need an entirely different mechanism —
not an LPP capability type, and not something this roadmap makes any
claim about.
