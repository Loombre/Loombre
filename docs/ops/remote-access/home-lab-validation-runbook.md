# Owner home-lab validation runbook — Loombre Remote

**Status: OPEN — owner-run only. This is the real-network validation CI
cannot perform.** CI proves the machinery (in-process WireGuard loopback
handshake, probe-token lifecycle, connector process lifecycle against a
stub binary, posture grading, CGNAT decision logic). It does **not** prove
that a real phone on real cellular reaches a real router forwarding to this
server, or that a real Cloudflare account provisions a real tunnel. That is
this runbook, and no agent may mark it passed — only the owner, after
running it on real hardware, can.

<!-- Sourcing: settings-registry.ts (env var names + defaults), the three
     per-path pages in this directory, apps/server/src/remote/** for the
     endpoints exercised. R11: "REAL-NETWORK validation ... is an owner
     home-lab item with an agent-prepared runbook — logged Open, never
     simulated as passed." -->

## What you need

- A Loombre server on your LAN, reachable at a known LAN address.
- A phone with cellular data (to act as the external vantage — the phone
  IS the reachability check; there is no third-party probe service).
- Admin access to your home router (for the Direct and Remote paths).
- For the Tunnel path only: a Cloudflare account with a domain on it, and a
  scoped API token (the tunnel page walks you through creating it).
- The official WireGuard app on the phone (for the Remote path).

Record the result of each checklist item as PASS / FAIL / SKIPPED with a
note. Nothing here is "assumed" — if you did not run it, it is SKIPPED.

---

## Path 1 — Loombre Remote (embedded WireGuard)

1. **Enable.** Admin → Remote Access → set up → Remote. Confirm the server
   generated a key and the listener came up on the WireGuard port
   (default 51820, `LOOMBRE_WG_PORT`). Set the endpoint host
   (`LOOMBRE_WG_ENDPOINT_HOST`) to a hostname/IP the phone can reach from
   outside — for split-tunnel WireGuard you still need ONE UDP port
   forwarded on your router to this server.
2. **Forward the UDP port** on your router (the wizard's card names the
   exact port). This is the only network change; the wizard never touches
   the router itself.
3. **Enroll the phone.** Pick your user, name the device, scan the QR into
   the WireGuard app. Confirm the config appears exactly once — leave the
   screen and return, and it must be gone (re-enrollment required).
4. **Silence check (do this from the phone, ON CELLULAR, WITH THE TUNNEL
   OFF).** Nothing you can do from a phone proves cryptographic silence to
   a scanner — that is CI's property test — but confirm that with the
   WireGuard tunnel toggled OFF the Loombre app is NOT reachable at the
   endpoint (the server is invisible without the tunnel). PASS = not
   reachable.
5. **Connect.** Toggle the WireGuard tunnel ON on the phone (cellular,
   Wi-Fi off). Open Loombre. PASS = you reach your library and can play
   something. Note the iOS VPN badge in the status bar — that is expected,
   not a leak (the user page explains this).
6. **Reachability proof.** Run the wizard's proof step; scan the probe QR
   with the phone on cellular; confirm the wizard lights green.
7. **Revoke.** Remove the device from the devices list. Confirm the phone's
   tunnel can no longer reach Loombre (handshake fails live) AND that the
   device's session is gone. PASS = both.

## Path 2 — Tunnel (Cloudflare)

1. **Create the scoped token** following tunnel.md's walkthrough. The
   scopes the wizard needs: token verify, Account Settings Read, Cloudflare
   Tunnel Edit, Zone DNS Edit. Paste it into the token step (it is stored
   write-only; you will never see it again).
2. **Enable** with your chosen hostname (`LOOMBRE_TUNNEL_HOSTNAME`).
   Confirm the wizard provisioned the tunnel + DNS route and that the
   connector (`cloudflared`, resolved from PATH or
   `LOOMBRE_CLOUDFLARED_PATH`) came up healthy in the admin health panel.
3. **Reach it externally.** From the phone on cellular, open
   `https://<your hostname>`. PASS = Loombre loads over the public URL with
   no port forwarding of your own.
4. **Connector resilience.** Kill the cloudflared process (or pull its
   network briefly); confirm the health panel shows unhealthy → backoff →
   recovered, and the public URL comes back.
5. **Reachability proof + disable.** Run the proof step. Then disable the
   path; confirm the connector stops, the DNS route and tunnel are torn
   down on the Cloudflare side, and the public URL no longer resolves to
   Loombre. PASS = full teardown.

## Path 3 — Direct (port forward + TLS)

1. **Pick a mode.** Built-in certificate (ACME) or an existing reverse
   proxy. For ACME you need a domain pointing at your public IP.
2. **Staged certificate test** (ACME): run the wizard's test-issuance step
   BEFORE committing. PASS = a certificate is issued without flipping the
   server into TLS mode yet (no lockout risk).
3. **Forward the port(s)** per the router card (443, plus 80 briefly for
   ACME http-01). Apply the mode; restart when prompted.
4. **Reach it externally.** From the phone on cellular, open
   `https://<your domain>`. PASS = valid TLS, Loombre loads.
5. **CGNAT case.** If step 4 fails, run the diagnosis step and enter your
   router's WAN address (the card shows where to read it). If the wizard
   says CGNAT and routes you to Tunnel, confirm that guidance matches
   reality (your WAN address is in the 100.64.0.0/10 range, or differs from
   your seen-public address). This is the one place the wizard makes a
   judgment call on real data — confirm it judged correctly.
6. **Reachability proof + disable**, as above.

## Posture card

After enabling any path, open the posture card and confirm each grade
reflects reality on YOUR setup (valid TLS shows valid; the WireGuard-port
grade explains scanners see nothing; connector health matches the real
connector). Trip one deliberately (e.g. let a cert approach expiry in a
test, or stop the connector) and confirm the regression raises an admin
notice. PASS = grades honest, regression noticed.

## Sign-off

| Path | Enable | External reach | Proof green | Teardown | Notes |
| --- | --- | --- | --- | --- | --- |
| Remote | | | | | |
| Tunnel | | | | | |
| Direct | | | | | |

Owner: __________  Date: __________  Overall: PASS / FAIL / PARTIAL
