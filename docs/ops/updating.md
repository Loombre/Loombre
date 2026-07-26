# Updating Loombre

Loombre's server can check whether a newer release exists and surface that
in the admin UI. It **never downloads, never installs, and never restarts
anything on its own** (docs/PLAN.md §10: "server checks and notifies,
never auto-applies — self-hosted trust posture"). Applying an update is
always a human, off-band action: download the new installer/image
yourself, verify it (see "Verifying releases" below), and run it.

This document is the complete, exact specification of what the update
checker does — not a summary. If you run Loombre behind a firewall, an
egress allowlist, or just want to know precisely what leaves your server,
this page is the answer.

## Configuration

| Env var | Values | Default |
|---|---|---|
| `LOOMBRE_UPDATE_CHECK` | `off` \| `manual` \| `daily` | `daily` |
| `LOOMBRE_UPDATE_MANIFEST_URL` | any HTTP(S) base URL | a placeholder GitHub Releases URL (see below) |

### Why the default is `daily`, not `off`

docs/PLAN.md §10 states the feature plainly: "the server checks and
notifies" — this is a shipped feature of the product, the same way every
comparable self-hosted media server checks for updates by default. What
CLAUDE.md invariant 7 ("no telemetry, analytics, or phone-home of any
kind") and D14 actually forbid is **identifying content in the request**,
not the existence of a periodic, generic, anonymous GET to a static file.
Those are different requirements, and this document exists specifically to
prove the second one is satisfied so the first one's spirit is too — see
"Exactly what the request contains" below.

If you want zero background network activity regardless, set
`LOOMBRE_UPDATE_CHECK=off` (nothing is ever fetched, and the admin API
endpoint below always reports `"disabled"`) or `=manual` (nothing is
fetched automatically; a check only happens when an admin opens the update
panel, or calls the API endpoint directly).

### `LOOMBRE_UPDATE_MANIFEST_URL` — mirrors, airgap, enterprise

The manifest URL is the **base directory** containing two files:
`manifest.json` and `manifest.json.minisig` (a detached signature). By
default this points at a GitHub Releases download URL for the project's
own `stable` channel — a placeholder value
(`https://github.com/Loombre/Loombre/releases/latest/download`)
until the repository is public; an unreachable/unset mirror simply
surfaces as `"unreachable"` in the admin UI, it is never a hard
dependency, never blocks server boot, and never appears on any user-facing
request's hot path (the check runs in the background — see "Behavior by
mode" below).

Enterprises and airgapped installs can point this at an internal mirror
(a plain static-file host serving the same two files, kept in sync with
upstream releases by whatever means the operator chooses) without any
other configuration change — the pinned public key (below) verifies the
SAME release-manager signature regardless of where the two files are
hosted, so a mirror does not weaken trust as long as it serves genuinely
unmodified files.

## Behavior by mode

- **`off`** — the checker never runs, ever. `GET /system/update` (admin
  only) always returns `{ verification: "disabled", latestVersion: null,
  notesUrl: null, checkedAtMs: null, updateAvailable: false }` without
  making any network call.
- **`daily`** — the first background check fires 10 seconds after server
  boot (a short grace period so a slow/offline network never competes with
  startup), then again every 24 hours. The result is cached in memory;
  `GET /system/update` always serves that cache instantly (no network call
  on the request path — Tier-0 hot-path rule) except when no check has
  landed yet (e.g. the admin opens the panel inside that first 10-second
  window), in which case it awaits the in-flight check rather than
  returning a placeholder.
- **`manual`** — no background timer at all. Every `GET /system/update`
  call performs a fresh check synchronously (admin-triggered, low
  frequency by nature).

## Exactly what the request contains

Every check makes **exactly two** outbound HTTP requests, both bare `GET`s
with no query string, to:

```
GET {LOOMBRE_UPDATE_MANIFEST_URL}/manifest.json
GET {LOOMBRE_UPDATE_MANIFEST_URL}/manifest.json.minisig
```

The full, exact header set sent — nothing more, ever:

| Header | Value | Notes |
|---|---|---|
| `User-Agent` | `loombre-update-check` | a **fixed literal string** — never the running Loombre version, OS, architecture, hostname, or any per-install identifier |
| `Accept` | `application/json, text/plain;q=0.9` | ordinary content negotiation |
| `Host`, `Connection`, `Accept-Encoding`, `Sec-Fetch-Mode` | (whatever Node's own `fetch` implementation sets) | transport/protocol-level plumbing, not application-chosen, carries no identifying content |

**Never sent, on principle, not just in practice:** the current Loombre
version, the OS/platform, a hostname or install ID, cookies, an
`Authorization` header, a `Referer`, or any custom `X-*` header. This is
enforced by a test, not just documented prose:
`apps/server/test/common/update-check/zero-identifying-payload.spec.ts`
runs a real local HTTP server, makes a real request through the real
checker, captures every header the server actually received, and asserts
the received set is exactly the table above — a future change that adds
so much as one identifying header fails that test.

The response is read (manifest body + detached signature), verified
against the pinned public key (below), and the decision (a newer version
exists or not) is cached. **No response data is ever sent anywhere** — the
whole exchange is one-directional trust verification, not telemetry.

## Verifying releases

Every Loombre release ships three independent layers of trust (P4.9), so a
release is verifiable even if you don't trust any single one of them in
isolation:

1. **GitHub artifact attestation** (no key handling required) — proves an
   artifact was built by this project's own CI from this exact repository
   at this exact commit:
   ```bash
   gh attestation verify <downloaded-file> --repo Loombre/Loombre
   ```
2. **minisign signature** (the release manager's personal blessing) —
   proves a human release manager, holding the project's private signing
   key, deliberately published this exact `SHA256SUMS`/`manifest.json`:
   ```bash
   minisign -Vm SHA256SUMS -P <public key below>
   ```
3. **SHA-256 checksums** (plain integrity, no key needed) — proves your
   download matches what was published, nothing about who published it:
   ```bash
   sha256sum -c SHA256SUMS
   ```

### The minisign public key

<!-- LOOMBRE_MINISIGN_PUBLIC_KEY_BEGIN -->
```
untrusted comment: minisign public key 9EA9BD1D8785E084
RWSE4IWHHb2pnrgvN8eVIFOOv1vK84f5Zkk8lMtw6t4VlggsYAOj2oA5
```
<!-- LOOMBRE_MINISIGN_PUBLIC_KEY_END -->

This is one of **three** independently-controlled locations this exact key
text must appear, byte-identical, in (P4.9): this file, `keys/minisign.pub`
(the repo file the server itself is built against), and every GitHub
Release's notes. `scripts/release/check-pubkey-consistency.mjs` is the
CI-runnable proof that all three agree — see `keys/README.md` for the full
key-rotation and key-generation story. A key-substitution attack requires
compromising all three simultaneously.

## The admin API

`GET /system/update` (admin-only; see `packages/contract/openapi.yaml`'s
`SystemUpdateInfo` schema):

```jsonc
{
  "currentVersion": "0.9.0-dev+34979cb6",
  "channel": "stable",
  "latestVersion": "0.9.0",       // null unless verification is "verified"
  "updateAvailable": false,
  "notesUrl": null,               // null unless verification is "verified"
  "checkedAtMs": 1753315200000,   // null only when verification is "disabled"
  "verification": "verified"      // "verified" | "signature-invalid" | "unreachable" | "disabled"
}
```

`verification` tells you exactly how much to trust the rest of the
payload:

- `"verified"` — the manifest's minisign signature checked out against the
  pinned public key; `latestVersion`/`notesUrl` are real.
- `"signature-invalid"` — a manifest was fetched, but its signature failed
  to verify (tampered, wrong key, or the recognized-but-rejected
  prehashed `ED` minisig variant — P4.18). `latestVersion`/`notesUrl` are
  always `null` here; an unverified claim about "the latest version" is
  never surfaced, ever.
- `"unreachable"` — the manifest mirror could not be reached, returned a
  non-2xx status, or returned something that wasn't a well-formed,
  correctly-channeled manifest.
- `"disabled"` — `LOOMBRE_UPDATE_CHECK=off`.
