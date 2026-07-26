# Built-in ACME (Let's Encrypt) — direct-exposure installs

Loombre can obtain and renew its own TLS certificate from Let's Encrypt (or
any RFC 8555 ACME server) with no reverse proxy in front of it — the right
choice when you're exposing Loombre directly to the internet (a home
server on its own public IP/port-forward, a small VPS) and don't already
run a proxy for other services. If you DO already run a reverse proxy,
use `docs/ops/reverse-proxy.md` instead — don't run both.

Third option, no TLS at all: `docs/ops/reverse-proxy.md`'s "LAN-only, no
TLS" section — appropriate when Loombre never leaves a network you trust.

## Turning it on

```bash
LOOMBRE_TLS_MODE=acme
LOOMBRE_ACME_DOMAINS=media.example.com        # comma-separated; first is the certificate's commonName
LOOMBRE_ACME_CHALLENGE_TYPE=http-01           # or dns-01 — see "Choosing a challenge type" below
LOOMBRE_ACME_TOS_AGREED=1                     # required: acknowledges you accept the CA's Terms of Service
LOOMBRE_ACME_EMAIL=you@example.com            # optional but recommended (expiry/problem notices from the CA)
```

Everything else has a sane default (production Let's Encrypt directory,
30-day renewal window, standard ports) — see "All settings" below.

## Choosing a challenge type

| | `http-01` | `dns-01` |
|---|---|---|
| Needs port 80 reachable from the internet | **Yes** | No |
| Needs any inbound port at all | Yes (80) | No |
| Works behind CGNAT / no port-forwarding | No | **Yes** |
| Setup | Nothing beyond DNS pointing at you | A hook script or manual DNS record per renewal |
| Wildcard certs | Not supported (ACME rule, not a Loombre limit) | Supported (single-domain use is still fine) |

If you can open port 80, `http-01` is simpler and needs no extra
configuration. If you can't (CGNAT, restrictive ISP, a server with no
public inbound access at all beyond what a tunnel provides) or you want a
wildcard, use `dns-01`.

## `http-01`: the port story, honestly

`http-01` validation works like this: the CA connects to
`http://<your-domain>:80/.well-known/acme-challenge/<token>` and expects
Loombre to answer. Loombre's HTTP-01 listener binds exactly
`LOOMBRE_HTTP_PORT` (default **80**) — it never assumes it can get a
privileged port for free, and it never silently falls back to a different
port (the CA would just fail to reach it).

**Binding port 80 (or 443, for `LOOMBRE_HTTPS_PORT`) needs a privilege
Node does not have by default** on any OS. Four ways to get it, in order
of preference:

### 1. systemd `AmbientCapabilities` (recommended — Linux tarball/systemd installs)

`installers/linux/systemd/loombre-server.service.template` ships
with an EMPTY `CapabilityBoundingSet=` / `AmbientCapabilities=` by design
— the unit runs with zero Linux capabilities unless you opt in, per the
principle of least privilege the rest of that unit file's hardening
follows (`ProtectSystem=strict`, `NoNewPrivileges=true`, etc.). To allow
binding 80/443, add exactly one capability to both lines:

```ini
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

This is the ONLY capability that needs adding — `CAP_NET_BIND_SERVICE`
grants binding ports <1024 and nothing else; it does not grant root, does
not defeat any of the unit's other hardening lines (`ProtectSystem`,
`ProtectHome`, the `Restrict*`/`Protect*` sandboxing all stay in force),
and is the standard, documented way systemd-managed services get this one
privilege without running as root. `systemctl daemon-reload && systemctl
restart loombre-server` after editing.

*(The shipped template does not include this —
correct as the SECURE-BY-DEFAULT posture for the common case
(LOOMBRE_TLS_MODE=off/manual-behind-proxy), but an operator turning on
`LOOMBRE_TLS_MODE=acme` with `http-01`/`dns-01`-needs-none or manual mode
on 443 needs this doc followed manually today. A future installer
enhancement could offer to add these two lines automatically when the
onboarding wizard detects `LOOMBRE_TLS_MODE != off`.)*

### 2. `setcap` (Linux, no systemd, or testing outside a unit)

```bash
sudo setcap 'cap_net_bind_service=+ep' /opt/loombre/bin/node
```

Grants the SAME single capability directly to the Node binary Loombre
runs. Caveat: this must be re-applied after every Node binary
replacement (an upgrade that ships a new bundled Node runtime) — the
systemd `AmbientCapabilities` route above survives upgrades without any
re-application because it's a unit-file property, not a file property.

### 3. `authbind` (Linux, alternative to setcap)

```bash
sudo apt install authbind
sudo touch /etc/authbind/byport/80 /etc/authbind/byport/443
sudo chown loombre /etc/authbind/byport/80 /etc/authbind/byport/443
sudo chmod 500 /etc/authbind/byport/80 /etc/authbind/byport/443
# ExecStart= (or your launch command) becomes:
authbind --deep /opt/loombre/bin/loombre-server
```

Grants the privilege per-port rather than per-capability — useful if you
want 80/443 specifically and nothing else, or don't want to touch
capabilities at all.

### 4. Reverse-port instead of a privileged bind (any OS, incl. macOS/Windows)

Skip the privilege question entirely: point 80/443 at a HIGH,
unprivileged port Loombre actually binds via `LOOMBRE_HTTP_PORT`/
`LOOMBRE_HTTPS_PORT` (e.g. 8080/8443), and forward with something that
already has the privilege:

- **Linux:** `iptables`/`nftables` DNAT (`iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080`), or run the whole Loombre process under `authbind`/`setcap` instead (options 2–3).
- **macOS:** `pf` redirect rules (`rdr pass on en0 inet proto tcp from any to any port 80 -> 127.0.0.1 port 8080`), or run Loombre via `launchd` as root (macOS has no capabilities system — root or a redirect are the only two options; there is no macOS equivalent of `setcap`).
- **Windows:** binding <1024 does **not** require Administrator on Windows since Vista, UNLESS the port has been explicitly reserved via `netsh http add urlacl`/`netsh int ipv4 add excludedportrange` (uncommon on a fresh box) — in practice `LOOMBRE_HTTP_PORT=80`/`LOOMBRE_HTTPS_PORT=443` usually just work unprivileged on Windows. If a port turns out reserved, either pick a free one or `netsh int ipv4 delete excludedportrange protocol=tcp startport=80 numberofports=1` (run as Administrator, one-time).

*(Neither the Windows MSI nor the macOS pkg's
service/launchd configs need any privilege grant added for this — Windows
generally doesn't restrict the ports at all, and macOS's launchd services
should document root-vs-redirect as a choice at onboarding time if
`LOOMBRE_TLS_MODE=acme` is selected in the wizard.)*

### Tests always use unprivileged ports

Every test in `apps/server/test/tls/` sets `LOOMBRE_HTTP_PORT`/
`LOOMBRE_HTTPS_PORT` into the 3680–3699 range specifically so `pnpm test`
never needs any of the above — the module itself has no privileged-port
assumption baked in anywhere; the privilege question is purely an
operator-deployment concern, documented here.

## `dns-01`: the hook-script seam

Loombre ships **zero per-provider DNS SDKs** (a deliberate v1 scope
decision — N provider integrations is a real maintenance/dependency-
weight/AGPL-relicense-readiness cost for a feature most installs won't
use). Instead, `LOOMBRE_ACME_DNS_HOOK` points at an executable YOU own that
Loombre invokes exactly like this:

```
<your-script> set   _acme-challenge.media.example.com  <txt-value>
<your-script> clear _acme-challenge.media.example.com  <txt-value>
```

(the same three values also arrive as `LOOMBRE_ACME_DNS_ACTION`/
`LOOMBRE_ACME_DNS_RECORD`/`LOOMBRE_ACME_DNS_VALUE` env vars, for scripts
that prefer reading env over argv). Exit 0 on success; nonzero + a
message on stderr on failure. This is the exact same shape certbot's
`--manual-auth-hook`/`--manual-cleanup-hook`, acme.sh's `dns_` functions,
and lego's `exec` provider all converge on — if you already have a hook
script for one of those, it needs only trivial argv-shape changes to work
here.

Minimal Cloudflare example (adapt the API calls for your own provider):

```bash
#!/usr/bin/env bash
set -euo pipefail
action="$1"; record="$2"; value="$3"
zone_id="YOUR_ZONE_ID"
api_token="YOUR_API_TOKEN"

if [ "$action" = "set" ]; then
  curl -sf -X POST "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records" \
    -H "Authorization: Bearer ${api_token}" -H "Content-Type: application/json" \
    --data "{\"type\":\"TXT\",\"name\":\"${record}\",\"content\":\"${value}\",\"ttl\":60}"
elif [ "$action" = "clear" ]; then
  id=$(curl -sf "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?type=TXT&name=${record}" \
    -H "Authorization: Bearer ${api_token}" | jq -r '.result[0].id')
  [ -n "$id" ] && [ "$id" != "null" ] && curl -sf -X DELETE \
    "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records/${id}" \
    -H "Authorization: Bearer ${api_token}"
fi
```

`chmod +x` it, point `LOOMBRE_ACME_DNS_HOOK` at its absolute path. Loombre
polls DNS for up to `LOOMBRE_ACME_DNS_PROPAGATION_TIMEOUT_MS` (default
120s) after calling `set` before asking the CA to validate — a
propagation delay here is normal and not an error; the CA's own retries
are the real backstop if this poll times out.

### No hook script: manual mode

Leave `LOOMBRE_ACME_DNS_HOOK` unset with `LOOMBRE_ACME_CHALLENGE_TYPE=dns-01`
and Loombre logs the exact record to create and polls DNS until it sees
it, indefinitely up to the propagation timeout — paste the printed
name/value into your registrar's UI by hand. No automation, appropriate
for a one-off cert on a domain whose DNS you don't want to script against.

This module's real, end-to-end proof against both flows (a real ACME
server issuing a real certificate via a real HTTP-01 challenge listener,
and via a real hook-script-driven DNS-01 TXT record) lives in
`apps/server/test/tls/acme-http01-pebble.integration.spec.ts` and
`acme-dns01-pebble.integration.spec.ts`.

## Certificate storage

Under `LOOMBRE_DATA_DIR/tls/`:

| File | Contents | Mode |
|---|---|---|
| `acme-account-key.pem` | The ACME account's own private key (identifies this Loombre install to the CA — generated once, never rotates) | `0600` |
| `acme-account-url.txt` | The CA's account URL for that key (not a secret — cached to skip re-registering on every renewal) | `0600` |
| `acme-cert.pem` | The issued certificate, fullchain (leaf + intermediates) | `0600` |
| `acme-cert-key.pem` | The issued certificate's own private key (distinct from the account key) | `0600` |

The account key follows the same `SecretRef` shape (`{backend:
"file0600", key: <path>}`) as every other Loombre-managed secret (P4.7) —
its TYPE is imported read-only from `@loombre/provisioning`; nothing in
the TLS module writes to that package.

## Renewal

A daily in-process check (`LOOMBRE_ACME_RENEW_CHECK_INTERVAL_MS`, default
24h) renews once the certificate is within `LOOMBRE_ACME_RENEW_WINDOW_DAYS`
(default 30) of expiry. Renewal re-runs the SAME challenge flow (HTTP-01
listener stays up the whole time Loombre runs in `acme` mode; DNS-01 hook
runs again) and hot-swaps the live HTTPS server's TLS context via Node's
`https.Server#setSecureContext()` — **already-open connections are not
dropped**; only NEW TLS handshakes after the swap see the renewed
certificate. A renewal failure is logged and retried on the next daily
check; it never crashes the server or drops the currently-served
(still-valid) certificate.

## HSTS

`Strict-Transport-Security` is added automatically when, and only when,
Loombre itself is terminating TLS (`LOOMBRE_TLS_MODE=manual` or `acme`) AND
`LOOMBRE_TRUST_PROXY` is NOT set. If you're running a reverse proxy
(`LOOMBRE_TRUST_PROXY` set — see `docs/ops/reverse-proxy.md`), that proxy
owns HSTS instead, even if `LOOMBRE_TLS_MODE` also happens to be non-off —
the full rule, by combination:

| `LOOMBRE_TLS_MODE` | `LOOMBRE_TRUST_PROXY` | Loombre sends HSTS? |
|---|---|---|
| `off` | unset | No — no TLS to be sticky about |
| `off` | set | No — no TLS to be sticky about |
| `manual` | unset | **Yes** |
| `manual` | set | No — the proxy in front owns HSTS instead |
| `acme` | unset | **Yes** |
| `acme` | set | No — the proxy in front owns HSTS instead |

`LOOMBRE_TRUST_PROXY` wins even when TLS mode is also non-off: the reasoning
is that whichever hop is the browser's actual TLS endpoint is the one that
should decide HSTS policy, and setting `LOOMBRE_TRUST_PROXY` is exactly an
operator's declaration that a proxy — not Loombre itself — is that hop.
Override the max-age with `LOOMBRE_HSTS_MAX_AGE_SECONDS` (default 15552000 /
~180 days); Loombre never submits itself to the HSTS preload list (that
requires an irreversible submission against a domain Loombre doesn't own —
D14 no-phone-home applies here too, and it stays entirely the operator's
own decision).

## All settings

| Env var | Default | Notes |
|---|---|---|
| `LOOMBRE_TLS_MODE` | `off` | `off` \| `manual` \| `acme` |
| `LOOMBRE_HTTP_PORT` | `80` | HTTP-01 challenge listener + plain-HTTP→HTTPS redirect |
| `LOOMBRE_HTTPS_PORT` | `443` | The real app, over TLS |
| `LOOMBRE_ACME_DOMAINS` | *(required)* | Comma-separated; first entry is the certificate's commonName |
| `LOOMBRE_ACME_CHALLENGE_TYPE` | *(required)* | `http-01` \| `dns-01` |
| `LOOMBRE_ACME_TOS_AGREED` | *(required)* | Must be `1`/`true` — Loombre refuses to silently agree to the CA's ToS on your behalf |
| `LOOMBRE_ACME_EMAIL` | unset | Contact address the CA may use for expiry/problem notices |
| `LOOMBRE_ACME_DIRECTORY_URL` | Let's Encrypt production | Override for staging (`LOOMBRE_ACME_STAGING=1`) or a private ACME server |
| `LOOMBRE_ACME_STAGING` | unset | `1` → Let's Encrypt's staging directory (higher rate limits, untrusted test certs — for dry-running config changes) |
| `LOOMBRE_ACME_DNS_HOOK` | unset | Path to your DNS-01 hook script; unset → manual print-and-poll mode |
| `LOOMBRE_ACME_DNS_PROPAGATION_TIMEOUT_MS` | `120000` | How long to poll DNS before asking the CA to validate (hook mode: non-fatal on timeout; manual mode: fatal) |
| `LOOMBRE_ACME_RENEW_WINDOW_DAYS` | `30` | Renew once the cert is this close to expiry |
| `LOOMBRE_ACME_RENEW_CHECK_INTERVAL_MS` | `86400000` (24h) | How often the background check runs |
| `LOOMBRE_ACME_CA_BUNDLE` | unset | Extra trust anchor — private ACME servers only, never needed against Let's Encrypt |

`LOOMBRE_TLS_MODE=manual` (bring-your-own cert/key, e.g. from certbot's
standalone/webroot mode, or a purchased certificate) instead uses:

| Env var | Notes |
|---|---|
| `LOOMBRE_TLS_CERT_PATH` | Absolute path, must exist at boot |
| `LOOMBRE_TLS_KEY_PATH` | Absolute path, must exist at boot |
| `LOOMBRE_TLS_CA_PATH` | Optional extra CA/chain bundle |
| `LOOMBRE_TLS_RELOAD_DEBOUNCE_MS` | Default `500` — hot-reloads on file change (handles both plain overwrites and certbot's rename-over-the-path renewal style) |
