# Direct

<!-- Sourcing: two-mode model (Loombre-issued certificate vs. an existing
     reverse proxy), staged test-before-commit issuance, router instruction
     cards, CGNAT routing to Tunnel — STATE.md R5/RG12. Frozen step
     sequence (direct-mode -> direct-acme-test [acme only, skipped for
     reverse-proxy] -> direct-enable -> direct-router-instructions) —
     packages/shared/src/remote/wizard-state.ts's PATH_FLOW_STEPS.direct
     and nextPathFlowStep's documented reverse-proxy skip. The mode
     chooser's own literal copy ("Does Loombre issue the certificate
     itself, or does something else already handle TLS for you?", "Loombre
     issues it automatically" / "I already have a reverse proxy") —
     apps/web/src/components/settings/remote-wizard/PathFlowStepSlot.tsx's
     DirectModeChoiceBody, real landed UI. Contract operations
     (testRemoteDirectAcme/enableRemoteDirect/disableRemoteDirect) and
     their request/response shapes (TestRemoteDirectAcmeRequest,
     RemoteDirectAcmeTestResult, RemoteDirectStatus) —
     packages/contract/openapi.yaml; apps/server/src/remote/
     remote-direct.controller.ts is REAL, landed code (lane D1's RG12
     promotion: staged ACME test-before-commit via buildAdHocAcmeConfig,
     real enable/disable with cross-path enables serialized under an
     advisory lock, LD-9) — this page's shapes verified against it
     directly; the earlier flagged-for-V-DOC caveat (the controller was
     still the Wave-0 conforming shell when first drafted) is resolved.
     CGNAT classification (100.64.0.0/10 = definite carrier-grade NAT;
     RFC1918 WAN = double-NAT; WAN-vs-resolved-address mismatch = stale
     DNS) — packages/shared/src/remote/diagnosis.ts's classifyReachability
     and diagnosis-guidance.ts's "direct" branch, both real and landed.
     Per-brand router instruction cards: RECONCILED post-merge by the
     orchestrator against the landed packages/shared/src/remote/
     router-cards.ts (D1) — the generic steps below match its generic
     card's step sequence; per-brand specifics (TP-Link/Netgear/ASUS/
     Linksys/FRITZ!Box/UniFi) deliberately live only in the wizard's
     cards, which parameterize protocol/ports per path — the doc stays
     brand-agnostic and points at the wizard, so the two sources can't
     drift per-brand. Reachability proof — same
     sourcing as loombre-remote.md's own proof section. Appendices —
     acme.md and reverse-proxy.md, both moved into this directory,
     linked below. -->

Direct puts your server on the public internet with its own address and
its own certificate — the most exposed of the three paths, the most
router work, but once it's running, the option most likely to behave like
an ordinary website: a plain `https://` address with nothing else to
think about.

## Two ways to handle the certificate

The setup wizard asks one question up front: does Loombre issue the
certificate itself, or does something else already handle TLS for you?

- **"Loombre issues it automatically"** — Loombre requests a free
  certificate from Let's Encrypt (or another ACME-compatible authority)
  and renews it on its own from then on. Before committing to this mode,
  Loombre runs a real, staged test issuance first and shows you the
  result — so a mistake in your domain or DNS setup surfaces as a clear
  failure message during setup, never as a lockout after the fact. Full
  detail: [Appendix: Built-in ACME](acme.md).
- **"I already have a reverse proxy"** — if you already run Caddy, nginx,
  Traefik, or anything similar in front of other services, Direct can
  route through it instead of issuing its own certificate; there's no
  test-issuance step in this mode, since there's nothing for Loombre
  itself to issue. Full detail:
  [Appendix: Reverse proxy](reverse-proxy.md).

[SCREENSHOT: Direct path wizard step, choosing between the two certificate modes]

## Forwarding a port on your router

Whichever certificate mode you choose, Direct needs your router
forwarding its public HTTPS port (and, in ACME mode, briefly port 80 too,
for the certificate authority to validate your domain — see the appendix
for exactly when) to the machine running Loombre. Every router's own
admin page calls this something slightly different — "port forwarding,"
"virtual server," or "NAT forwarding" are the most common names — reachable
by signing in to your router's own admin address, usually printed on a
label on the router itself or in its manual. The wizard's own instruction
step names the exact port(s) to forward for your setup; general
port-forwarding is exactly the same three-field form on every router
regardless of brand: the port people reach from outside, the port Loombre
actually listens on (usually the same number), and the LAN address of the
machine running Loombre. For the most common router brands (TP-Link,
Netgear, ASUS, Linksys, AVM FRITZ!Box, Ubiquiti UniFi) the wizard shows a
brand-specific walkthrough with that brand's own menu names, so you don't
have to translate the generic steps yourself.

[SCREENSHOT: Direct path wizard's router-instructions step]

## When port-forwarding can never work: CGNAT

Some internet providers don't give every customer a real, unique public
address at all — instead, many households share a small number of public
addresses behind the provider's own layer of address translation, called
carrier-grade NAT (CGNAT). If your router's own "WAN address" status page
shows an address between `100.64.0.0` and `100.127.255.255`, that's a
certain sign of it: no port-forwarding rule you create will ever make
Direct reachable, because your router was never actually given a public
address to forward from in the first place.

The setup wizard checks for this automatically: if the reachability proof
below never arrives, and the WAN address you enter from your router's
status page doesn't match the public address Loombre's own probe page
sees, the wizard explains this in plain terms and points you to
[Tunnel](tunnel.md) instead — which needs no inbound port at all, and
therefore isn't affected by CGNAT.

## Proving it actually reaches you

The same reachability proof every path ends with: the wizard mints a
one-time code, and you scan it with **a phone on cellular data, not your
home Wi-Fi** — the phone is the genuine outside test, not a third-party
checking service. A plain, minimal success page confirms arrival; the
wizard watches for it and turns green the moment it does. If it doesn't
arrive, the wizard's diagnosis walks the CGNAT check above first, then
falls back to "the address is right, but nothing answered" — meaning the
port-forwarding rule itself, or a firewall on the server, is the likely
place to look next.

## Reference appendices

- **[Appendix: Built-in ACME](acme.md)** — every setting, the HTTP-01 vs.
  DNS-01 challenge tradeoff, the privileged-port story on each OS, and
  renewal mechanics.
- **[Appendix: Reverse proxy](reverse-proxy.md)** — Caddy/nginx/Traefik
  recipes, the real requirements a proxy in front of Loombre has to meet,
  and the LAN-only/no-TLS option.

## See also

- [Remote access](./) — the decision tree and comparison table, if you
  haven't picked a path yet.
- [Loombre Remote](loombre-remote.md) and [Tunnel](tunnel.md) — the other
  two paths.
