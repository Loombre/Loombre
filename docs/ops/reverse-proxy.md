# Reverse proxy (recommended path)

Running Loombre behind a reverse proxy you already operate (Caddy, nginx,
Traefik, or anything else) is the first-class, recommended remote-access
path (docs/PLAN.md §10) — Loombre speaks plain HTTP, your proxy terminates
TLS, and you get to reuse whatever certificate/routing/logging setup you
already run for other services. The two alternatives — built-in ACME
(`docs/ops/acme.md`) and LAN-only/no-TLS (below) — exist for installs
that don't already have a proxy.

Every recipe below satisfies the SAME six real requirements Loombre's
HTTP surface has — skipping any one of them breaks something specific,
noted inline:

1. **WebSocket upgrade for `/v1/events`** — presence/live-update pushes.
   Without this, the web client falls back to fully static state (no
   live "someone started watching" pulses, no live job progress).
2. **No buffering on HLS segment paths** (`/playback/sessions/*/hls/**`)
   — segments are written to disk as transcoding produces them; a
   proxy that buffers the full response before forwarding it adds
   multi-second latency to every segment fetch, which reads as
   stuttering/rebuffering in the player. `proxy_buffering off` (nginx),
   Caddy's default (no buffering by default), Traefik's default
   (streaming by default) — the nginx recipe below is the one that
   needs an explicit opt-out.
3. **`?token=` query-string auth is real auth, not a decoration** —
   `GET /images/**` and `GET /playback/sessions/{id}/file` accept the
   access JWT via a `?token=` query param (P2.18 — `<img>`/`<video>`/
   `<audio>` elements cannot set an `Authorization` header). Two
   consequences for your proxy config: (a) never strip query strings on
   these paths, and (b) your proxy's OWN access log almost certainly
   records the full request line including that token by default —
   redact it (see the nginx `map` example below; apply the same idea to
   whatever proxy you run).
4. **`client_max_body_size` (or equivalent) large enough for `POST
   /import`** — the export/import round-trip (docs/PLAN.md §8.4) uploads
   a full archive in one request; most proxies default to a body-size
   cap (nginx: 1MB) that's nowhere near big enough for a real library
   export. Size this to your actual library, not a guess — err large.
5. **`X-Forwarded-For` + `LOOMBRE_TRUST_PROXY` are a PAIR** — set both or
   neither. Setting `LOOMBRE_TRUST_PROXY` without a proxy in front that
   actually strips/overwrites incoming `X-Forwarded-For` lets any client
   spoof its own rate-limit/anomaly-log identity; setting a proxy without
   `LOOMBRE_TRUST_PROXY` makes Loombre's rate limiter/anomaly log key on
   your proxy's own address for every request (still safe, just useless
   for per-client limiting). See "Trust-proxy configuration" below.
6. **The invite-claim and password-reset API routes are public, and
   already rate-limited inside Loombre itself** —
   `GET /invites/claim/{token}`, `POST /invites/claim/{token}`,
   `POST /auth/forgot-password`, and `POST /auth/reset-password` have to
   work with no session at all (a brand-new person has no account yet;
   someone locked out has no way to sign in). If your setup adds its own
   gate in front of everything — basic auth, an IP allowlist, a separate
   rate limiter — exclude these four the same way `/setup/*` already is;
   anything that blocks or challenges them blocks exactly the people they
   exist for. Separately: whichever address you set as the public web
   address setting (`LOOMBRE_PUBLIC_URL` — see the Admin Guide's
   [Mail](../admin-guide/mail.md) page) has to be the address people
   reach from *outside*, i.e. this proxy's own hostname, never Loombre's
   internal origin (`http://127.0.0.1:3001`) or an upstream target —
   every invitation and password-reset link is built from that one
   setting alone, so an internal address here means correctly-sent mail
   with links nobody outside your network can open. Note the DISTINCT
   paths: the invite link itself (`{publicUrl}/claim/{token}`) is a
   **web page** — route it like every other browser page, to the web UI,
   not the API — while the JSON calls that page makes live under
   `/invites/claim/{token}` (API-side, listed above). `/reset/{token}`
   and `/forgot` are web pages too, same rule: page routes go to the web
   UI, and only `/auth/forgot-password`/`/auth/reset-password` (the API
   calls those pages make) go to the API.

## Caddy (recommended)

```caddyfile
media.example.com {
    # API paths -> the server (:3001); everything else -> the web UI (:3000).
    # /invites/claim/* and the two /auth/*-password routes (requirement 6)
    # are the public invite-claim and password-reset API calls — bare
    # paths, not under /v1, so they need listing explicitly like /healthz
    # and /setup/*. NOTE: bare /claim/* (no /invites prefix) is the human
    # invite-link PAGE — it deliberately falls through to the web UI catch-
    # all below, not this @api matcher (F1: the two used to collide on the
    # same path before the API's own claim routes moved under /invites).
    @api path /v1/* /playback/* /healthz /setup/* /invites/claim/* /auth/forgot-password /auth/reset-password
    reverse_proxy @api 127.0.0.1:3001
    reverse_proxy 127.0.0.1:3000
}
```

That's genuinely it. Caddy: obtains and renews its own TLS certificate
automatically, upgrades WebSocket connections transparently for any
`reverse_proxy` block (no separate config), streams responses without
buffering by default, and sets `X-Forwarded-For`/`X-Forwarded-Proto`
automatically. Only `LOOMBRE_TRUST_PROXY=1` needs adding on the Loombre
side (Caddy runs as a single trusted hop). Large uploads need no
Caddy-side change (no default cap) — only the Loombre-side `POST /import`
implementation's own limits, if any, apply.

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name media.example.com;

    ssl_certificate     /etc/letsencrypt/live/media.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/media.example.com/privkey.pem;

    client_max_body_size 20g;  # size to your actual library — POST /import (requirement 4)

    # Redact ?token= from THIS proxy's own access log (requirement 3b) —
    # Loombre's own server-side logs already never echo it.
    map $request $request_no_token {
        "~^(?<verb>\S+)\s(?<path>[^?\s]+)(\?\S*)?\s(?<proto>\S+)$" "$verb $path $proto";
    }
    log_format redacted '$remote_addr - [$time_local] "$request_no_token" $status $body_bytes_sent';
    access_log /var/log/nginx/loombre-access.log redacted;

    # WebSocket upgrade for /v1/events (requirement 1) — the Upgrade/
    # Connection headers are NOT inherited from a parent `location /`
    # block in nginx, so this location needs its own copy even though
    # proxy_pass target is identical.
    location /v1/events {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # No buffering on HLS segment/manifest paths (requirement 2) — nginx
    # buffers proxied responses by default, which is the opposite of what
    # a segment being written mid-transcode needs.
    location ~ ^/playback/sessions/[^/]+/hls/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Remaining API paths (requirements 3-5) — everything the browser
    # calls on the server origin rather than the web UI.
    location ~ ^/(v1|playback|setup)/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Invite-claim and password-reset API routes (requirement 6) — public,
    # rate-limited inside Loombre itself, bare paths (not under /v1) so
    # they need their own location the same way /healthz does above.
    # Bare /claim/[^/]+ (no /invites prefix) is deliberately NOT matched
    # here — that's the human invite-link PAGE, and falls through to the
    # web UI location below (F1: the API's own claim routes moved under
    # /invites/claim/* specifically so the two stop colliding).
    location ~ ^/(invites/claim/[^/]+|auth/(forgot|reset)-password)$ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:3001;
    }

    # Everything else is the browser-facing web UI (the Next.js standalone
    # server every install channel runs as its own service on :3000).
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
}
```

`LOOMBRE_TRUST_PROXY=1` on the Loombre side (nginx is one hop, forwarding
its own `$proxy_add_x_forwarded_for`, which correctly appends to — rather
than blindly trusts — any inbound value).

## Traefik

```yaml
# docker-compose labels (or the equivalent static/dynamic file config)
labels:
  - "traefik.enable=true"
  # API router (server, :3001) — higher priority than the catch-all.
  # PathPrefix(`/invites/claim`) + the two exact /auth/*-password paths
  # (requirement 6) are the public invite-claim and password-reset API
  # calls — bare paths, not under /v1, so they're listed explicitly here
  # the same way /healthz and /setup are. Bare `/claim` (no `/invites`
  # prefix) is deliberately NOT in this rule — that's the human
  # invite-link PAGE, and falls through to the web UI router below (F1:
  # the API's own claim routes moved under /invites/claim/* specifically
  # so the two stop colliding).
  - "traefik.http.routers.loombre-api.rule=Host(`media.example.com`) && (PathPrefix(`/v1`) || PathPrefix(`/playback`) || PathPrefix(`/setup`) || Path(`/healthz`) || PathPrefix(`/invites/claim`) || Path(`/auth/forgot-password`) || Path(`/auth/reset-password`))"
  - "traefik.http.routers.loombre-api.tls.certresolver=letsencrypt"
  - "traefik.http.routers.loombre-api.service=loombre-api"
  - "traefik.http.services.loombre-api.loadbalancer.server.port=3001"
  # Web UI router (everything else, :3000)
  - "traefik.http.routers.loombre-web.rule=Host(`media.example.com`)"
  - "traefik.http.routers.loombre-web.tls.certresolver=letsencrypt"
  - "traefik.http.routers.loombre-web.service=loombre-web"
  - "traefik.http.services.loombre-web.loadbalancer.server.port=3000"
  # Uploads (requirement 4) — Traefik has no default body-size cap of its
  # own; a cap here only matters if you've added one elsewhere in your
  # chain (e.g. a WAF/CDN in front of Traefik itself).
```

Traefik upgrades WebSocket connections and streams responses without
buffering automatically for any HTTP router — no extra config needed for
requirements 1/2, same as Caddy. It also sets `X-Forwarded-*` headers by
default; `LOOMBRE_TRUST_PROXY=1` on the Loombre side.

## Trust-proxy configuration

`LOOMBRE_TRUST_PROXY` accepts exactly what Express's own `trust proxy`
setting understands (`apps/server/src/main.ts`'s `resolveTrustProxySetting`
— unit-tested, and end-to-end tested both ON and OFF in
`apps/server/test/auth-security.e2e.spec.ts` /
`apps/server/test/trust-proxy-hardening.e2e.spec.ts`):

```bash
LOOMBRE_TRUST_PROXY=1              # exactly one proxy hop you control
LOOMBRE_TRUST_PROXY=2              # a hop count, if you chain two proxies
LOOMBRE_TRUST_PROXY=loopback       # Express preset: 127.0.0.1/8, ::1
LOOMBRE_TRUST_PROXY=10.0.0.0/8     # a CIDR (or comma-separated list)
```

Default (unset): `X-Forwarded-For` is completely ignored — `req.ip` is
always the raw socket address, so nothing a client sends can move the
auth rate limiter's or anomaly log's IP key. This is a strict allowlist
handed straight to Express's own well-tested `trust proxy` implementation
— Loombre never parses `X-Forwarded-For` itself anywhere in the codebase
(every consumer reads Express's already-gated `req.ip`).

## `LOOMBRE_CORS_ORIGINS`

If the web client is served from a DIFFERENT origin than the API (e.g.
`app.example.com` talking to `api.example.com`, or any non-same-origin
proxy topology), set the allowlist explicitly:

```bash
LOOMBRE_CORS_ORIGINS=https://app.example.com,https://media.example.com
```

Default covers only the local dev pairing
(`http://localhost:3000`/`http://127.0.0.1:3000`). An explicit empty
value (`LOOMBRE_CORS_ORIGINS=`) disables CORS entirely — correct for a
same-origin deployment where one proxy serves both the web client and the
API under one hostname (no cross-origin requests ever happen, so no CORS
headers are needed). Only EXACT listed origins are ever reflected — no
wildcard, no credentialed requests (auth is Bearer/`?token=`, never
cookies, so `credentials: false` is fixed).

## `LOOMBRE_SERVER_ORIGIN` (the web app's side of the same pairing)

`LOOMBRE_CORS_ORIGINS` above is set on the server service and lists which
WEB origins may call the API. `LOOMBRE_SERVER_ORIGIN` is set on the web
service and is the inverse: which API/server origin(s) THIS web build's
Content-Security-Policy is allowed to fetch/stream from (`connect-src`/
`img-src`/`media-src`). Set by the SAME operator, pointing at each other:

```bash
# server
LOOMBRE_CORS_ORIGINS=https://loombre.example.com

# web
LOOMBRE_SERVER_ORIGIN=https://api.loombre.example.com
```

Comma-separated, same parsing rule as `LOOMBRE_CORS_ORIGINS` above. This is
**optional**: Loombre's web client takes an arbitrary server URL on the
login screen (persisted client-side) — a single public web build can
legitimately talk to many different self-hosted servers with no one
origin known in advance, which is exactly why leaving this unset falls
back to a scheme-wildcarded CSP (`https:`/`wss:` etc.) rather than
breaking. Set it when you run web+server together as a fixed pairing (the
increasingly common single-tenant case) to get a materially tighter CSP —
`connect-src`/`img-src`/`media-src` collapse to `'self'` plus exactly your
server's origin instead of any HTTPS host.

**Docker/Compose deployments** (documented in `docs/install/docker.md`)
run three services from two images: `server` and `worker` share one image,
and the web UI runs as its own `web` service from a second image
(`ghcr.io/loombre/loombre-web`). The compose file already sets
`LOOMBRE_SERVER_ORIGIN` on the `web` service the same way a native
install's web service does, so the tighter CSP described above applies
there too.

## HSTS is yours, not Loombre's

On this path the proxy is the browser's actual TLS endpoint, so the proxy —
not Loombre — owns `Strict-Transport-Security`. Loombre only sends the
header itself when it is terminating TLS AND `LOOMBRE_TRUST_PROXY` is unset;
setting `LOOMBRE_TRUST_PROXY` (which you do here) turns it off on Loombre's
side even if `LOOMBRE_TLS_MODE` is also non-`off`. The full rule, by
combination, is the HSTS table in `docs/ops/acme.md`.

Add it at the proxy layer instead. The nginx recipe above already carries the
line:

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
```

The Caddy equivalent inside the site block is
`header Strict-Transport-Security "max-age=63072000; includeSubDomains"`; on
Traefik it's a `headers` middleware (`stsSeconds`, `stsIncludeSubdomains`).
None of the three set it for you — HSTS is a commitment about a domain you
own, so it stays an explicit operator decision.

## LAN-only, no TLS

If Loombre never leaves a network you trust (no port-forward, no public
DNS record, VPN-only access), plain HTTP with no proxy and no
`LOOMBRE_TLS_MODE` is a legitimate, supported third path — nothing extra
to configure beyond the defaults. `LOOMBRE_TRUST_PROXY` stays unset (no
proxy exists to trust) and `LOOMBRE_CORS_ORIGINS` only needs setting if
your web client's LAN origin differs from the default dev pairing.
