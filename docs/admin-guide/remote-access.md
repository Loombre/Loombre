# Remote access

<!-- Sourcing: wizard stage order (interview -> recommendation -> chosen
     path's guided flow -> proof -> posture handoff) — packages/shared/src/
     remote/wizard-state.ts's STAGE_ORDER, real and landed (lane U1).
     Interview question wording — apps/web/src/components/settings/
     remote-wizard/InterviewStage.tsx, real landed UI, including that file's
     own honest note that the first question ("who needs access?") only
     changes wording below it, never the recommendation itself.
     Recommendation logic — the same package's recommendPath function.
     Comparison table content — packages/shared/src/remote/comparison.ts's
     PATH_COMPARISON (same single source the Operator Guide's landing page
     cites). Per-path setup step labels — apps/web/src/components/settings/
     remote-wizard/PathFlowStepSlot.tsx's PATH_FLOW_STEP_LABELS. Proof-stage
     copy ("Scan this code with a phone on cellular data, not your home
     Wi-Fi...") — ProofStage.tsx, real landed UI text. Posture card checks,
     grades, and their meaning — packages/shared/src/remote/
     posture-model.ts's POSTURE_CHECK_KEYS/PostureGrade/
     POSTURE_CHECK_FIX_ACTIONS/applicableChecks, and the real
     GET /admin/remote/posture endpoint, apps/server/src/remote/
     remote-posture.controller.ts (landed, lane S1 — not a placeholder).
     Switch/disable behavior and the verified-teardown checklist —
     apps/web/src/components/settings/remote-wizard/PathManagementCard.tsx
     (DISABLE_VERIFICATION_STEPS, DISABLE_SUMMARY) and STATE.md R8 ("switch
     = verified teardown then enable"). Entry point (Settings -> Remote
     access) — apps/web/src/components/settings/sections/
     RemoteAccessSection.tsx. -->

Remote access lets people reach your Loombre from outside your own home
network. It's entirely optional — everything about Loombre works fine on
your own network with nothing here turned on — and when you do turn it
on, a short setup wizard walks you through the whole thing from Settings →
Remote access.

## A few questions

The wizard starts with a short interview — nothing is sent anywhere until
you finish it:

1. **Who needs access?** Just you, a few people you trust, or anyone you
   might share a link with. This one is about framing the rest of the
   questions in familiar terms; it doesn't change the recommendation by
   itself.
2. **Is everyone willing to install a small app (like WireGuard, a
   well-known and widely-used tool for private connections) on each of
   their devices?**
3. **Do you need a plain web link you can share, with no app required at
   all?**
4. **Are you comfortable making a change in your router's settings?**

[SCREENSHOT: Remote access wizard, interview step]

## Getting a recommendation

Based on your answers, the wizard recommends one of three paths and shows
an honest comparison of all three side by side — attack surface, whether a
third party is involved, how much setup work is needed, and what breaks
and when. The recommendation is a starting point, never a lock: pick a
different path from the same screen if you'd rather. The Operator Guide's
[Remote access](../ops/remote-access/) page carries the same comparison in
more technical depth, if you want it.

| Path | In short |
|---|---|
| **Loombre Remote** | A private network built into Loombre. Install a small app on each device that needs access. |
| **Tunnel** | Cloudflare Tunnel. No open ports on your router, but Cloudflare sits in the connection path. |
| **Direct** | Your server, directly on the public internet, with its own domain and certificate. |

[SCREENSHOT: Remote access wizard, recommendation step with the comparison table]

## Setting up your chosen path

Each path's own guided steps follow, tailored to what it needs:

- **Loombre Remote:** turning it on, then enrolling your first device (a
  code you scan with that device's WireGuard app).
- **Tunnel:** connecting your Cloudflare account with a scoped token, then
  turning the tunnel on.
- **Direct:** choosing how the certificate is handled, an automatic test
  of that setup before it goes live, turning it on, then a reminder of the
  one change to make in your router.

The Operator Guide has a complete, self-contained page for whichever path
you choose — [Loombre Remote](../ops/remote-access/loombre-remote.md),
[Tunnel](../ops/remote-access/tunnel.md), or
[Direct](../ops/remote-access/direct.md) — with everything this summary
leaves out.

[SCREENSHOT: Remote access wizard, mid-flow on a chosen path's setup steps]

## Proving it reaches you

However you set it up, the wizard finishes configuration with a real
test: it shows a code, and asks you to scan it with a phone on **cellular
data, not your home Wi-Fi** — the phone genuinely outside your network is
the real test, not a third-party checking service. A plain success screen
confirms it worked, and the wizard turns green the moment it does. If
nothing arrives, the wizard explains the likely reason for your specific
path rather than leaving you guessing.

[SCREENSHOT: Remote access wizard, proof step with the scannable code]

## The security posture card

Once a path is active, a posture card stays visible on the Remote access
screen for as long as it's on, checking:

- Whether rate limits are active on the surfaces this exposes.
- Whether any account is stale (never signed in, or has no password set)
  now that it's reachable from outside.
- Whether any pending invite link is now reachable from outside, as an
  informational note.
- Whether the public-address setting matches the path you actually have
  active.
- One check specific to your chosen path: the certificate's validity
  (Direct), that the WireGuard port stays silent to anything that isn't
  an enrolled device (Loombre Remote), or that the tunnel connector is
  healthy (Tunnel).

Each check shows a grade — a pass, a warning, a failure, or "not yet
checked" — and a failing or warning grade always links straight to the
screen that fixes it, rather than just naming the problem.

[SCREENSHOT: Security posture card with a mix of grades]

## Switching or turning off a path

From the same screen, once a path is active, **Switch path…** or
**Disable…** are always available. Both work the same way underneath:
Loombre tears the current path down and verifies each step as it
completes (for example, Loombre Remote's teardown revokes every enrolled
device's key and stops listening) before showing you it's done — never a
single "disabled" flag with nothing to back it up. Switching immediately
continues into the wizard so you can set up the new path right away;
disabling just leaves remote access off until you turn something back on.

[SCREENSHOT: Remote access screen, active path with Switch/Disable controls and the teardown checklist]

## See also

- [Operator Guide: Remote access](../ops/remote-access/) — the same
  decision tree and comparison, plus full technical detail for whichever
  path you choose.
- [Watching away from home](../user-guide/watching-away-from-home.md) —
  what the people you invite see and do once you've turned this on; worth
  pointing them to.
