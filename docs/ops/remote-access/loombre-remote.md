# Loombre Remote

<!-- Sourcing: architecture (in-process userspace WireGuard, no kernel
     module, no root, exposes only Loombre's own listener never the LAN) —
     STATE.md R1/RG1/RG2. Enrollment/key handling (server keypair at
     enable in the keyring; per-device peer keypair generated server-side,
     delivered once, private key not retained) — STATE.md R2, and the
     one-time payload shape — packages/contract/openapi.yaml's
     RemoteWireguardEnrollment/EnrollRemoteWireguardDeviceRequest/
     RemoteWireguardDevice schemas + apps/server/src/remote/
     remote-wireguard.controller.ts's six operations (enable/disable/
     status/list devices/enroll device/revoke device — route paths and
     admin-gate ordering frozen there). Config format — packages/shared/
     src/remote/provisioning.ts (buildProvisioningConfig,
     PROVISIONING_FORMAT_VERSION, the fixed 25s PersistentKeepalive) — this
     module is FROZEN and landed; verified directly against its source, not
     inferred. Split-tunnel-only law (R3) — the same file's AllowedIPs
     construction (always exactly the server tunnel IP/32, never wider).
     Port/subnet defaults — packages/shared/src/settings-registry.ts's
     remote.wireguardPort (default 51820, LOOMBRE_WG_PORT,
     requiresRestart:true) and remote.subnet (default 10.82.146.0/24,
     LOOMBRE_WG_SUBNET, requiresRestart:true) entries — also FROZEN and
     landed (the WireGuard listener itself has not landed yet as of this
     page's writing; these two facts are sourced from the settings
     registry and the provisioning module specifically because those two
     pieces are real today, not from the not-yet-built listener). Silence/
     invisibility claim — STATE.md R9 ("WG handshake silence verified by
     test: unauthenticated probe packets receive no response") and
     packages/shared/src/remote/comparison.ts's attackSurface cell for the
     "remote" path. Revocation UI + verification checklist —
     apps/web/src/components/settings/remote-wizard/PathManagementCard.tsx
     (DISABLE_VERIFICATION_STEPS.remote: "revoke-peers", "drop-listeners")
     and packages/shared/src/remote/wizard-state.ts's own
     DISABLE_VERIFICATION_STEPS export. Reachability proof mechanics —
     STATE.md R6 and apps/server/src/remote/remote-probes.controller.ts +
     probe-page.controller.ts (real, landed: mint/poll/arrive), and the
     wizard's own proof-stage copy, apps/web/src/components/settings/
     remote-wizard/ProofStage.tsx ("Scan this code with a phone on cellular
     data, not your home Wi-Fi — the phone is the real outside test, not a
     third-party checking service."). CGNAT/diagnosis wording —
     packages/shared/src/remote/diagnosis.ts (classifyReachability) and
     diagnosis-guidance.ts's "remote" branch. -->

Loombre Remote is a private network built into Loombre itself — the path
with the smallest attack surface and no third party in the middle,
in exchange for installing one small app per device.

## What WireGuard is

WireGuard is a modern, widely-used, open-source technology for building a
private, encrypted connection between two devices over the internet —
Loombre Remote runs its own copy of it directly inside the Loombre
process (no separate service, no operating-system networking changes, no
root privileges), and uses it for exactly one thing: letting an enrolled
device reach Loombre's own listener as if it were on your home network,
without exposing anything else on that network to it.

## Enrolling a device: the QR flow

From the admin Remote access screen, you enroll a device for a specific
person by name (e.g. "Alex's iPhone"). Loombre generates that device's
own WireGuard key pair server-side and shows you a QR code exactly once —
scan it with the [WireGuard app](https://www.wireguard.com/install/) on
that device (iOS, Android, Windows, macOS, and Linux all have one) and
the device is enrolled and connected. A downloadable `.conf` file is
offered alongside the QR code for desktop WireGuard clients that would
rather import a file than scan a code.

That one-time display is deliberate, not a limitation: Loombre does not
retain the device's private key after showing it to you, the same posture
an invite link already has elsewhere in Loombre. If you need it again,
revoke the device and enroll it fresh — there's no "view again" screen,
because there is nothing left server-side to show.

[SCREENSHOT: Remote access admin screen, enrolling a new device with its QR code]

## The one router step: forwarding a UDP port

Loombre Remote's WireGuard listener binds one UDP port — **51820 by
default** (the `remote.wireguardPort` setting, changeable from the admin
settings screen or pinned with `LOOMBRE_WG_PORT`; changing it needs a
server restart, since the listener can't rebind to a different port while
it's running). Forward that UDP port on your router to the LAN address of
the machine running Loombre — exactly the same "port forwarding" or
"virtual server" screen your router uses for any other service, just for
a UDP port rather than the more commonly-forwarded TCP. This is the only
router change Loombre Remote ever needs, and Loombre never makes it for
you (see the [Remote access](./) landing page's "hard line" section).

## Split tunnel, not full-device VPN

Every device's generated configuration routes only Loombre's own address
through the tunnel — nothing else about that device's internet traffic
ever passes through it, unlike a full-device VPN that would route
everything.

## Revoking a device

Revoking a device — from the same devices list, at any time — removes its
key from the running listener immediately: a revoked device's next
connection attempt fails exactly like an unrecognized device's does (see
"cryptographically invisible" below), with nothing left server-side to
clean up. Disabling Loombre Remote entirely does the same thing to every
enrolled device at once, plus stops the listener; the admin screen shows
each step (revoke every enrolled key, stop listening) as it completes,
never as a single unverified "disabled" flag flip.

## "Cryptographically invisible" — what that actually means

Loombre Remote's attack surface claim, stated honestly: an unrecognized
packet sent at the WireGuard port gets **no response of any kind** — not a
rejection, not a "connection refused," nothing. WireGuard only replies to
a packet that's cryptographically signed by an already-enrolled device's
own key; anything else is silently dropped.

What that means in practice for someone scanning the internet for open
ports: your Loombre Remote port looks identical to a port with nothing
listening on it at all, or one blocked by a firewall — not like a port
with an identifiable service behind it. That's a genuinely strong
property against casual and automated internet-wide scanning, which is
the realistic threat model here. It is not literal invisibility: the port
still exists, still accepts inbound packets, and someone who already
suspects Loombre Remote is running at your address and specifically wants
to confirm it could look for other evidence (for example, whether the
address answers on your Direct-path port instead, if you'd ever used
that). "Cryptographically invisible" describes what a scanner sees, not a
claim that the service cannot be proven to exist by any means.

## Proving it actually reaches you

Once enrolled, the setup wizard walks you through the same reachability
proof every path ends with: it mints a one-time code bound to your
Loombre Remote endpoint, and you scan it with **a phone on cellular data,
not your home Wi-Fi** — the phone is the genuine outside test, not a
third-party checking service. A plain, minimal success page confirms
arrival with nothing more than that; the wizard watches for it and turns
green the moment it does. If it doesn't arrive within the code's 15-minute
window, the wizard walks you through the likely cause instead of leaving
you guessing:

- **Nothing arrived, and your router's WAN address matches what Loombre
  expects** — the port likely isn't actually forwarded, or a firewall on
  the server itself is blocking it. Re-check the port-forwarding step
  above.
- **Your router's WAN address is inside carrier-grade NAT** (a range your
  internet provider uses internally, `100.64.0.0`–`100.127.255.255`) —
  your provider isn't giving you a real public address at all, so no
  amount of port-forwarding will ever work here. [Tunnel](tunnel.md)
  is the path that works around this.
- **Your router's own WAN address is itself a private address** — your
  router is behind another router or your provider's own gateway, which
  needs its own port-forwarding rule too (or, again, switch to
  [Tunnel](tunnel.md)).

## See also

- [Remote access](./) — the decision tree and comparison table, if you
  haven't picked a path yet.
- [Tunnel](tunnel.md) and [Direct](direct.md) — the other two paths.
