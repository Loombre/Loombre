# Remote access

<!-- Sourcing: three-path model + hard line — STATE.md "Loombre Remote —
     embedded WireGuard + three-path wizard + reachability proof + posture
     card" locked decisions R1 (Loombre Remote = embedded userspace
     WireGuard), R4 (Tunnel = BYO Cloudflare token), R5 (Direct = ACME or
     reverse proxy + router instructions), R8 (interview -> recommendation
     -> path flow -> proof -> posture), R9 (no UPnP anywhere, stated as a
     feature). Decision-tree questions and recommendation logic —
     packages/shared/src/remote/wizard-state.ts's InterviewAnswers and
     recommendPath (the exact, frozen heuristic; verified against source,
     not paraphrased from memory) and apps/web/src/components/settings/
     remote-wizard/InterviewStage.tsx's literal question text. Comparison
     table content — packages/shared/src/remote/comparison.ts's
     PATH_COMPARISON, the single source this page and the in-app wizard's
     ComparisonTable.tsx both read from (STATE.md "Orchestrator freeze
     ground-truth": "Comparison-card ... CONTENT live in packages/shared/
     src/remote/ as single-source data modules ... DOC consumes the same
     source per R10") — reproduced here near-verbatim rather than
     paraphrased, specifically to avoid the two copies drifting apart. -->

Loombre can be reached from outside your own network in three different
ways. They solve the same problem — watching your library away from home —
with different tradeoffs, and you only need one. This page helps you pick;
each path then has its own complete setup guide that never sends you back
here for anything you need.

## The hard line: Loombre never touches your router for you

Every path below either needs no router change at all, or tells you
exactly what to change and lets you do it yourself. Loombre never reaches
into your router automatically to open a port — no UPnP, ever, on any
path. A background feature that can silently reconfigure the boundary
between your home network and the public internet is exactly the kind of
capability a self-hosted, no-phone-home application shouldn't have, even
in service of convenience — so Loombre simply doesn't have it. When a
router change is genuinely needed (the Direct path, and the Remote path's
one port), Loombre tells you precisely what to do and lets you decide.

## Picking a path

Answer these from your own situation:

1. **Does everyone who needs access have to be comfortable installing a
   small app on each of their devices?** (For Loombre Remote, that app is
   WireGuard — free, widely used, and covered end to end on its own page.)
2. **Do you need a plain web link you can share, with no app required at
   all** — the kind of link you could hand to someone once and never think
   about again?
3. **Are you comfortable making a change in your router's settings** —
   the kind of screen your internet provider's router or your own router's
   admin page gives you?

Those three answers sort into one recommended path:

| Your answers | Recommended path |
|---|---|
| You don't need a plain shareable link, and everyone's willing to install a small app | **[Loombre Remote](loombre-remote.md)** |
| You need a shareable link (or would rather not ask people to install anything), and you're comfortable with router settings | **[Direct](direct.md)** |
| You need a shareable link (or would rather not ask people to install anything), and you'd rather not touch your router's settings | **[Tunnel](tunnel.md)** |

This is exactly the logic the in-app setup wizard uses (Settings → Remote
access, inside Loombre itself) — this page and the wizard will always agree,
because both read from the same place. The wizard's recommendation is a
default, never a lock: you can pick a different path there, or read the
comparison below and pick one here first.

## Comparing the three paths

<!-- Table content is packages/shared/src/remote/comparison.ts's
     PATH_COMPARISON, reproduced verbatim per this file's own header
     comment. -->

| | [Loombre Remote](loombre-remote.md) | [Tunnel](tunnel.md) | [Direct](direct.md) |
|---|---|---|---|
| **Attack surface** | Silent to internet scanners. The WireGuard listener answers only a recognized device's own key — an unauthenticated probe gets no response at all, not even a rejection (verified by test). | No inbound ports opened on your router at all — the connection to Cloudflare is outbound-only. | The most exposed of the three: your server's HTTPS port is reachable by anyone on the public internet who finds the address (rate-limited, but reachable). |
| **Third parties** | None. The tunnel terminates entirely inside Loombre — no outside service ever sees your traffic. | Cloudflare sits in the path for every connection — a real third-party dependency, not something this path can avoid (stated plainly, not glossed over). | None beyond the certificate authority issuing your TLS certificate — no traffic passes through anyone else's servers. |
| **Setup difficulty** | Install the WireGuard app on every device that needs access and scan a QR code once per device. Requires forwarding one UDP port on your router. | Paste a scoped Cloudflare API token once. Loombre creates the tunnel and DNS route for you and runs a small connector process it supervises and restarts automatically. | Needs a real TLS certificate (Loombre can obtain one for you automatically) and manually forwarding a port on your router — the most router work of the three paths. |
| **What breaks, and when** | Devices already enrolled keep working through most router or ISP address changes (WireGuard reconnects on its own). Replacing your router can require re-forwarding the port. | If the connector process or Cloudflare itself has an outage, remote access pauses until it recovers — your library keeps working normally on your own network the whole time. | An ISP address change or a missed certificate renewal breaks access until you update DNS/port-forwarding or renew — but once set up, it is the option most likely to 'just work' as an ordinary shareable URL. |

Whichever path you pick, setup ends the same way: a reachability proof
(you scan a code with your own phone, on cellular data, so the check comes
from genuinely outside your network) and a persistent security posture
card that keeps watching the path you chose after setup finishes.

## The three guides

- **[Loombre Remote](loombre-remote.md)** — a private network built into
  Loombre itself. No third party, silent to scanners, needs a small app
  per device.
- **[Tunnel](tunnel.md)** — Cloudflare Tunnel, connected with your own
  API token. No open ports, but Cloudflare is in the path.
- **[Direct](direct.md)** — your server, directly on the public internet,
  with its own certificate. The most router work, but the most
  "ordinary" experience once it's running.

Two of the Direct path's building blocks — built-in certificate issuance
and running behind a reverse proxy — are also useful on their own (for
example, a reverse proxy you already run for other services on your own
network, with no remote-access path enabled at all): see the
[Built-in ACME](acme.md) and [Reverse proxy](reverse-proxy.md) reference
appendices.
