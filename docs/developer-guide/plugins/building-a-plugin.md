# Building your first plugin

<!-- Sourcing: examples/lpp-reference-provider/server.mjs (metadata-provider
     reference plugin, complete), examples/lpp-discord-notifier/server.mjs
     (event-subscriber reference plugin, complete — signature verification
     in verifySignature()/parseSignatureHeader()), packages/plugin-protocol/
     spec/lpp-v1.md §3 (config/secret header format), §4.2 (delivery
     signing header format + verification pseudocode, replay window
     300000ms default). -->

Both of Loombre's reference plugins live in this repository under
`examples/` and pass the full conformance suite (see
[Conformance testing](conformance.md)). They're deliberately minimal, Node
standard-library-only, zero-npm-dependency programs — not because you have
to write your plugin that way, but so they can't hide a dependency on
anything Loombre-specific. Reading either one start to finish is a
complete, working example of everything on this page.

## Layout

A plugin is just an HTTP server. There's no required project layout, no
required framework, no required language — the two examples happen to be
single-file Node scripts because that's the smallest thing that
demonstrates the protocol, not because LPP asks for that shape. What *is*
required is that the server answers the routes its own manifest declares.

```
examples/lpp-reference-provider/
  package.json     -- "start": "node server.mjs", zero dependencies
  server.mjs        -- the entire plugin

examples/lpp-discord-notifier/
  package.json     -- same shape
  server.mjs        -- the entire plugin
```

Run either one directly: `node server.mjs` (reads a `PORT` environment
variable, defaulting to an OS-assigned ephemeral port; prints
`LISTENING <port>` once bound — that's the line
`packages/plugin-protocol/test/integration.spec.ts` parses when it spawns
these exact files as child processes for its own automated proof).

## Step 1 — serve the manifest

Every plugin, regardless of what capabilities it offers, answers
`GET /lpp/manifest` with its manifest — name, version, `protocolVersion:
1`, its `capabilities` array, a `configSchema` (even if empty), a
description, and a publisher. `examples/lpp-reference-provider/server.mjs`
declares one `metadata-provider` capability with a single optional
config field:

```js
const MANIFEST = {
  name: "lpp-reference-provider",
  version: "0.1.0",
  protocolVersion: 1,
  capabilities: [
    {
      type: "metadata-provider",
      mediaKinds: ["movie", "tv", "music"],
      contentClass: "general",
      endpoints: {
        search: "/lpp/provider/search",
        details: "/lpp/provider/details",
        images: "/lpp/provider/images",
      },
    },
  ],
  configSchema: {
    type: "object",
    properties: {
      fixturePrefix: {
        type: "string",
        description: "Prefix prepended to every fake title this provider returns.",
        default: "Loombre Fixture",
      },
    },
    additionalProperties: false,
  },
  description: "Deterministic fake metadata for LPP v1 conformance testing and as an integration example.",
  publisher: "Loombre",
};
```

`examples/lpp-discord-notifier/server.mjs` declares an `event-subscriber`
capability instead, with one **secret** config field (`webhookUrl`,
`secret: true`) — see [the spec](spec.md)'s "Config & secrets" section for
exactly what `secret: true` means on the wire.

## Step 2 — implement the capability endpoints

For `metadata-provider`, that's the three POST endpoints your manifest's
`endpoints` object names (`search`/`details`/`images` by convention, but a
manifest may use different paths). `handleSearch`/`handleDetails`/
`handleImages` in the reference provider validate the request shape by
hand and respond with the exact schemas the "Capabilities" →
`metadata-provider` section of [the spec](spec.md) documents — reject
malformed input with an RFC 9457 `application/problem+json` body (see
`problem()` in that file) rather than a bare error.

For `event-subscriber`, that's the one delivery endpoint your manifest's
`delivery.endpoint` names (`/lpp/events` by convention). The notifier's
`handleEvents()` does three things, in order: verify the signature (step 3
below), parse the batch body, then respond `2xx` to acknowledge it — any
`2xx` status acks the *whole* batch; there's no separate ack message.

## Step 3 — read injected config and secrets

Loombre never asks a plugin to persist anything about its own
configuration — every call carries the plugin's *current* config values as
headers, so the plugin itself can stay stateless:

- `X-LPP-Config` — every non-secret field, as one JSON object, encoded
  `base64(utf8(JSON.stringify(configObject)))`.
- `X-LPP-Secret-<NAME>` — one header per `secret: true` field, encoded
  `base64(utf8(secretStringValue))`. `<NAME>` is the field's own
  `configSchema` property key, canonicalized to an HTTP header token
  (uppercased, non-token characters collapsed to `-`) — a field named
  `webhookUrl` arrives as `X-LPP-Secret-WEBHOOKURL`.

The notifier reads its one secret field this way:

```js
const webhookHeader = req.headers["x-lpp-secret-webhookurl"];
const webhookUrl = webhookHeader
  ? decodeSecretHeader(Array.isArray(webhookHeader) ? webhookHeader[0] : webhookHeader)
  : undefined;
```

where `decodeSecretHeader` is just `Buffer.from(value, "base64").toString("utf8")`.
Both are base64 specifically because raw header values aren't safe for
arbitrary text (RFC 9110 §5.5) — base64's alphabet is pure ASCII, so an
accented name or an emoji in a config value survives the trip intact.

## Step 4 — verify delivery signatures (event-subscriber only)

This is the part worth getting right, and the notifier's
`verifySignature()`/`parseSignatureHeader()` functions are a complete,
independent (no `@loombre/plugin-protocol` import) implementation of it.
Every delivery carries:

```
X-LPP-Signature: t=<unix-ms>,v1=<hex hmac-sha256 of "<t>.<raw body>">
```

The secret behind that HMAC is **not** one of the per-request config
secrets from step 3 — it's a separate value, minted once by Loombre at
registration and shown to the admin exactly one time (the same convention
Stripe/GitHub webhook signing secrets use). Your plugin needs to have
captured it out-of-band at setup time and hold onto it — the reference
notifier reads it once at startup from an environment variable
(`LOOMBRE_LPP_SIGNING_SECRET` in the example; a real plugin can obtain and
store it however suits its own deployment).

Verification, in order:

1. Parse the header into `t` (a millisecond timestamp) and `v1` (a hex
   HMAC-SHA256 digest). A missing or malformed header is an immediate
   reject.
2. Recompute the expected digest as `hmacSha256(secret, "${t}.${rawBody}")`
   over the **raw, unparsed** request body — compute it before you
   `JSON.parse` anything, since re-serializing would not reproduce the
   exact bytes that were signed.
3. Compare in constant time (`crypto.timingSafeEqual`, never `===` on the
   raw strings) — a non-constant-time comparison leaks timing information
   an attacker can use to forge a valid signature byte-by-byte.
4. Check `|now - t|` against your replay window (300000ms / 5 minutes is
   the spec's default) and reject a timestamp too far in the past *or* the
   future.

Step 3's signature-mismatch check is a **MUST** — a plugin that skips it
is a plugin trusting unauthenticated input. The replay-window check (step
4) is a **SHOULD**: the conformance suite reports a plugin that skips it as
a warning rather than a hard failure, but both reference plugins in this
repository enforce it, and you should too.

## Step 5 — try it against a real host

Once your plugin answers its manifest and endpoints, register it from
Loombre's admin Plugins screen the same way you'd register anyone else's
(see the [Admin Guide's Plugins chapter](/admin-guide/plugins)) — pointing
it at wherever your plugin is actually listening (including a LAN address,
if that's where you're running it during development; you'll need to add
that address to the registration's local-network allowlist). Before that,
though, run it through [conformance testing](conformance.md) — it catches
most shape and signature mistakes without needing a running Loombre server
at all.
