# Watching away from home

<!-- Sourcing: enrollment/config-delivery model (a one-time scannable code,
     shown once, imported by the standard WireGuard app) — STATE.md R2/R3
     and packages/shared/src/remote/provisioning.ts (the config the code
     encodes; app-agnostic by design, so today's official WireGuard app is
     the correct instruction to give here). "Cellular, not Wi-Fi" testing
     framing and what a successful check looks like — STATE.md R6 and
     apps/web/src/components/settings/remote-wizard/ProofStage.tsx's own
     copy (kept here in the admin/setup sense only; this page describes
     the person BEING enrolled, not running the wizard). Split-tunnel
     scope (only Loombre's own address routes through the connection,
     nothing else about the device's traffic) — STATE.md R3 and
     provisioning.ts's AllowedIPs construction, translated to plain
     language per the user-register rule (no ports, no technical terms).
     "Other ways in" (a plain shareable link needing no app) — the Tunnel/
     Direct paths existing as alternatives whoever administers a given
     Loombre may choose instead (STATE.md R4/R5), described here without
     naming them, since which path is active is an administration detail
     out of scope for this register. -->

If whoever runs your household's Loombre has set it up, you can reach
your library from outside your own home too — from a phone on the go, a
laptop at work, wherever you are. Nothing about this changes how Loombre
looks or works once you're connected; it only changes how you get to it.

## Getting connected

If they've chosen the app-based option, they'll set your device up for
you and hand you a code to scan — the same idea as scanning a code to join
a network at a coffee shop, just for your own household's library instead.

1. Install the free WireGuard app on the device you want to use — it's
   available from your device's usual app store, and it's the small app
   whoever runs your Loombre may have mentioned to you.
2. Open it and choose to add a connection by scanning a code.
3. Scan the code you were given.

That's it — the app does the technical setup for you the moment you scan.
From then on, open Loombre exactly the way you always have; watching away
from home works the same as watching at home in every way that matters to
you. The one thing this connection does is let your device reach your own
household's Loombre — nothing else about your device's connection changes.

[SCREENSHOT: Scanning the enrollment code with the WireGuard app]

## If it stops working

The most common fix: open the WireGuard app itself and make sure the
switch next to your Loombre connection is turned on. Closing the app, a
restart, or a routine update can sometimes turn it off without you
noticing — turning it back on usually solves it right away.

## A small icon that means it's working

While this kind of connection is active, many devices show a small icon
to let you know. On an iPhone or iPad, look for a small shape next to your
battery level near the top of the screen — seeing it is a good sign that
your connection is on, and it disappears again once it's off.

## Other ways in

Whoever runs your household's Loombre might have chosen a different setup
instead — a plain web address that just works, with no app to install at
all. If that's how yours is set up, there's nothing here for you to do;
open the address the same way you'd open any other website.

## See also

- [Watching](watching.md) — once you're connected, everything here works
  exactly the same as it does at home.
