# Tunnel

<!-- Sourcing: BYO-token automation model, provider abstraction, keyring
     storage, third-party framing — STATE.md R4/R9/RG7. Exact permission
     groups a token needs and the order they're checked — apps/server/src/
     remote/tunnel/cloudflare-tunnel-provider.ts's validateToken method and
     its own doc comment (four sequential probes: GET /user/tokens/verify
     for the token's own validity; GET /accounts for "Account Settings:
     Read"; GET /accounts/{id}/cfd_tunnel for "Cloudflare Tunnel: Edit";
     GET /zones for "Zone: DNS Edit") — this file is REAL, landed code
     (lane T1), not a shell; the scopes below are verified directly against
     it, not against Cloudflare's own docs. Tunnel/DNS provisioning calls
     (POST .../cfd_tunnel, GET .../token, PUT .../configurations, POST
     .../dns_records) — the same file's provisionTunnel/createDnsRoute.
     Connector process model (supervised child, health, auto-restart with
     backoff, logs, no automatic binary download) — STATE.md RG7 and
     packages/shared/src/settings-registry.ts's remote.cloudflaredPath
     entry. Status/logs surface — apps/server/src/remote/
     remote-tunnel.controller.ts's six real operations (set/clear token,
     enable/disable, status, logs) and the RemoteTunnelStatus contract
     schema (connectorState enum: stopped/starting/running/degraded/error;
     tokenConfigured/tokenSetAtMs/tokenScopesOk fields, all read-only and
     never echoing the token itself). Reachability proof — same sourcing as
     loombre-remote.md's own proof section (STATE.md R6, apps/server/src/
     remote/remote-probes.controller.ts + probe-page.controller.ts,
     ProofStage.tsx's cellular-data copy) plus diagnosis-guidance.ts's
     "tunnel" branch for what a failed proof means on this path
     specifically (connector-health-first, not WAN/CGNAT classification —
     the Tunnel path never depends on an inbound port at all). -->

Tunnel connects Loombre to the internet through Cloudflare, using an API
token you create and paste in yourself. No port on your router ever needs
to be opened — the connection to Cloudflare is entirely outbound — but
Cloudflare is a real third party in the path for every single connection,
stated plainly rather than glossed over: your traffic reaches Cloudflare's
network before it reaches your server.

## Creating a scoped Cloudflare API token

Loombre never asks for your Cloudflare account password or your Global API
Key — only a **scoped API token**, created from your own Cloudflare
dashboard, that can do exactly the three things Tunnel setup needs and
nothing else. Create one with these permission groups (Loombre checks for
all three by name when you paste the token in, and tells you exactly which
one is missing if any aren't there):

| Permission group | What it lets Loombre do |
|---|---|
| **Account Settings: Read** | Confirm which Cloudflare account the token belongs to. |
| **Cloudflare Tunnel: Edit** | Create the tunnel itself and configure where it routes to. |
| **Zone: DNS Edit** | Create the DNS record that points your chosen hostname at the tunnel. |

Walkthrough, from your own Cloudflare dashboard:

1. Sign in to Cloudflare and open **My Profile → API Tokens**.

   [SCREENSHOT: Cloudflare dashboard, My Profile -> API Tokens]

2. Choose **Create Token**, then **Custom token** (not one of the
   built-in templates — this walkthrough's three permissions aren't a
   single template).

   [SCREENSHOT: Cloudflare "Create Custom Token" screen]

3. Add all three permission groups from the table above.

   [SCREENSHOT: Cloudflare token permissions editor with the three groups added]

4. Under **Zone Resources**, include the zone (domain) you'll route
   Loombre through — or "All zones" if you're not sure yet, which you can
   narrow down later.

   [SCREENSHOT: Cloudflare token Zone Resources scope picker]

5. Create the token and copy it — Cloudflare shows it exactly once.

   [SCREENSHOT: Cloudflare token creation success screen with the copy button]

6. Paste it into Loombre's setup wizard (Settings → Remote access →
   Tunnel). Loombre checks it immediately and tells you plainly if a
   permission is missing, rather than failing later at tunnel creation.

   [SCREENSHOT: Loombre wizard's tunnel-token step, token pasted and validated]

The token itself is stored **write-only** in Loombre's secure local
keyring — no endpoint or screen in Loombre ever displays it again once
you've pasted it in, the same posture the mail transport's own credentials
already have.

## What happens after the token is accepted

Loombre creates the tunnel and its DNS route in your Cloudflare account
for you, then runs `cloudflared` — Cloudflare's own small connector
program — as a supervised background process: Loombre watches its health,
restarts it automatically with increasing backoff if it fails, and shows
its recent logs on the admin Remote access screen. Loombre does not
download this program for you; install it once yourself (Cloudflare's own
installer for your platform) and Loombre finds it on your system
automatically, or you can point Loombre at its exact location if
auto-detection doesn't find it.

[SCREENSHOT: Remote access admin screen showing the connector's status and recent logs]

## Proving it actually reaches you

The same reachability proof every path ends with: the wizard mints a
one-time code, and you scan it with **a phone on cellular data, not your
home Wi-Fi** — the phone is the genuine outside test, not a third-party
checking service. A plain, minimal success page confirms arrival; the
wizard watches for it and turns green the moment it does.

Because Tunnel never depends on an inbound port on your router at all, a
failed proof on this path almost always means the connector itself, not
your network: check whether it's reporting healthy on the admin screen
above before anything else. A connector that's still starting, or that's
lost its connection to Cloudflare, is the most common reason nothing
arrives.

## See also

- [Remote access](./) — the decision tree and comparison table, if you
  haven't picked a path yet.
- [Loombre Remote](loombre-remote.md) and [Direct](direct.md) — the other
  two paths.
