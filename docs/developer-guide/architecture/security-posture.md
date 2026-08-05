# Architecture: Security posture (implemented measures)

<!-- Sourcing: F1 currentPassword re-auth — apps/server/src/common/
     require-current-password.ts, apps/server/src/common/
     current-password-rate-limiter.service.ts, apps/server/src/common/
     anomaly-log.service.ts (CURRENT_PASSWORD_FAILURE kind),
     apps/server/src/gateway/current-password-invalid.exception.ts,
     packages/shared/src/settings-registry.ts's rateLimit.currentPassword.
     F3 revoke-on-password-change — packages/db/src/query/identity.ts's
     revokeOtherRefreshTokensForUser / revokeAllRefreshTokensForUser,
     packages/db/src/query/admin.ts's updateUserSelf, event schema
     session.revoked-by-password-change (ADMIN_ONLY). F5 email-collision
     signal — packages/db/src/query/admin.ts's updateUserSelf collision
     no-op, packages/db/src/query/invites.ts's claimInviteAndEmit,
     packages/db/src/query/email-collision-notice.ts (the 24h ledger
     claim, migrations/0025_email_collision_notice_ledger.sql), template
     email-in-use-notice; both dispatch sites in apps/server/src/catalog/
     users.controller.ts's updateMe and apps/server/src/invites/
     invites.controller.ts's claimInvite. STATE.md "Current-password
     re-auth on self-changes + the email-collision signal" (F1-F6/G1-G12)
     for the run that landed all three; docs/PLAN.md §10 for the
     spec-level security commitments this ledger tracks against. -->

This page is a **living ledger** of security-relevant measures that are
actually implemented and tested, as they land — not a retrospective audit
of the whole codebase, and not a substitute for `docs/PLAN.md` §10 (the
spec-level commitments) or the repository's `STATE.md` (the run-by-run
record of what changed and why). Its scope grows one run at a time; a
measure appears here once it has shipped, been reviewed, and has matrix
or e2e coverage pinning its behavior. If you're looking for the
vulnerability-reporting process instead, see the repository's
`SECURITY.md`.

Everything below was landed together in one run (STATE.md
"Current-password re-auth on self-changes + the email-collision signal"),
so the three measures share one enforcement mechanism and one
enumeration-safety argument — read as a set.

## Current-password re-authentication (F1)

**Surface.** Two operations gate on re-proving the caller's password
before applying the change: `PATCH /users/me` (`UsersController.updateMe`,
`apps/server/src/catalog/users.controller.ts`) when the request body
carries a `password` and/or `email` member — including an explicit
`email: null` to clear it — and `PUT /users/me/restricted`
(`UsersMeController.putRestricted`,
`apps/server/src/session/users-me.controller.ts`) unconditionally, since
every call there is account-critical (PIN set/change and restricted
opt-in/out are one operation). A bare profile save (`displayName`,
`birthDate`, locale/theme prefs) never triggers it. Admin-on-other-user
mutations (`PATCH /users/{id}`, admin password reset) are explicitly
out of scope — those are already gated by a live-admin re-check
(`requireLiveAdmin`) and are a different actor's credential, not the
caller's own.

**Contract.** `UpdateMeRequest` gained `currentPassword` via JSON Schema
`dependentRequired: { password: [currentPassword], email: [currentPassword] }`
rather than a flat `required` array, since the schema is a mixed body
where most members (`displayName`, `birthDate`) are not re-auth-gated.
`RestrictedSettingsUpdate` added it to its existing `required` array
outright — every call there is gated, so no conditional is needed. Both
declare `currentPassword` as an unconstrained `{type: string, format:
password}` — deliberately unvalidated in shape, since it proves an
already-stored secret that may predate any format rule, the same
reasoning `currentPin` already used.

**Enforcement** (`apps/server/src/common/require-current-password.ts`,
shared by both call sites — it cannot live under `session/` or
`catalog/` alone, since both modules call it and dependency-cruiser's
module-boundary rule forbids one importing from the other):

1. Presence/shape check first — a missing or non-string
   `currentPassword` is a free `422`, spending no rate-limit budget.
2. A per-user rate-limit attempt, **before** the password compare — an
   attacker must pay the limiter's price for every guess, not only every
   well-formed one that reaches the hash comparison.
3. An `argon2id` compare against the caller's own stored hash (the same
   `HashService` the login path uses). A mismatch throws
   `CurrentPasswordInvalidException` — HTTP `403`, problem type
   `urn:loombre:problem:current-password-invalid`, code
   `current-password-invalid` — with **one fixed detail string**,
   regardless of which endpoint or which field (password vs. email vs. a
   colliding email) prompted the check. See "Enumeration safety" below
   for why that fixed shape is load-bearing, not incidental.

**Rate limiting.** A dedicated `KeyedRateLimiter` bucket
(`CurrentPasswordRateLimiterService`, `apps/server/src/common/
current-password-rate-limiter.service.ts`), registry-driven
(`rateLimit.currentPassword`, env `LOOMBRE_RATE_CURRENT_PASSWORD`,
default 10/min — the same default as login), keyed by **user id**, and
**shared** across both gated endpoints: draining the budget on
`PATCH /users/me` also trips `PUT /users/me/restricted` for the same
user, immediately, without spending any attempts on that endpoint
directly. A trip logs an anomaly-log `RATE_LIMITED` line
(`op: "current-password"`); a wrong-but-under-the-cap attempt logs
`CURRENT_PASSWORD_FAILURE` (`{user}` only — never the attempted value).

## Session revocation on password change (F3)

A successful self-service password change (the `password` member of
`PATCH /users/me`, applied via `updateUserSelf`,
`packages/db/src/query/admin.ts`) revokes every **other** device's
refresh token in the same transaction as the password-hash write —
`revokeOtherRefreshTokensForUser` (`packages/db/src/query/identity.ts`),
keyed off the caller's own device id from their access-token claim, so
the session that performed the change survives. An outbox event,
`session.revoked-by-password-change` (`ADMIN_ONLY` delivery), carries
`{userId, username, revokedCount}` — never a token or a hash — and is
written in the same transaction via `writeEvent(trx, ...)`.

This is deliberately narrower than the admin/CLI reset path
(`resetUserPasswordAndEmit`, same file), which still revokes **every**
device including the one that triggered it — that path already forces
`must_change_password` and hands over a one-time temporary password, so
there is no "current device" to exempt. The two paths share the same
underlying `refresh_tokens` revoke primitive but call different
functions (`revokeOtherRefreshTokensForUser` vs.
`revokeAllRefreshTokensForUser`) with deliberately different scopes —
this distinction is pinned by e2e coverage on both paths, not left to
convention.

## Email-collision signal (F5)

**The actor-visible behavior never changes across DIFFERENT actors/
targets, and the STATUS never changes for any single actor.** Whether an
email address submitted to `PATCH /users/me` or claimed via
`POST /invites/claim/{token}` is genuinely free or already belongs to
another account, the caller gets the identical HTTP status and, once
request-scoped values like ids and tokens are set aside, the same body
*shape* — this is what `email-collision-matrix.e2e.spec.ts`'s full
`{claim, email-change} x {mail configured, unconfigured} x {notice window
fresh, already claimed}` grid pins, comparing across different accounts.
A collision is a **silent no-op**: the email member is dropped, every
other member in the same request still applies, and the caller sees an
ordinary success. This is a direct continuation of E8 (enumeration
safety) as it already applied to the invite-claim flow — an
authenticated re-auth gate is a new surface for the same class of bug,
not an exemption from it.

**⚠️ Known, owner-ACCEPTED limitation — read before citing this
section as "enumeration-safe."** The claim above holds at the
STATUS/SHAPE level, but a residual oracle survives inside the body
*value* for the narrower case of ONE authenticated actor comparing their
OWN successive attempts: `PATCH /users/me`'s 200 body echoes the
submitted address back when it was free, and echoes the caller's
UNCHANGED prior address back when it collided — the two are trivially
distinguishable from the response alone (a 30-trial blind classifier
scored 30/30; a follow-up `GET /users/me`, which carries no rate limit at
all, confirms it independently). The claim-flow twin is the same bit one
step later: a colliding claim's account is left `email: null`, readable
with the access token the claim itself returns. Full write-up: STATE.md
"Current-password re-auth on self-changes + the email-collision signal",
opus adversarial review findings R-F1/R-F2. **This is a genuine E8-vs-E1/
E4 trilemma, not an oversight an in-scope patch can close**: no server
can simultaneously (1) apply an email change immediately with zero mail
required (E1/E4), (2) let the actor read their own account back
(inherent to any authenticated profile endpoint), and (3) hide from that
SAME actor whether the address they just submitted was already taken
(E8/F5) — closing it requires relaxing one of those three locked
decisions, which was an owner call. **Resolved 2026-08-02: the owner
accepted this limitation in favour of E1/E4** — a self-hosted household
install keeps zero-mail, immediately-settable email, and the exploiter
must already be an authenticated member (low real-world exposure), so the
oracle is accepted and documented here rather than closed by relaxing E1
or E4. `reauth-review-findings.e2e.spec.ts` keeps the two proving cases as
`it.skip(...)` as a permanent record of the accepted behaviour; they are
not to be re-enabled or "fixed" without re-opening the tradeoff with the
owner.

Both dispatch sites (`updateUserSelf` and `claimInviteAndEmit`) detect a
collision with an in-transaction pre-`SELECT` that **excludes the
caller's own row** — re-setting your current address is never treated
as a collision, only a genuine match against a *different* account id
is. Detection returns the collided address as an internal field on the
result (`collidedEmail`), never serialized to the client; the controller
layer alone decides whether to act on it, which keeps the DB layer
mail-free and avoids enqueueing a job inside a transaction that might
still roll back.

**The out-of-band notice.** When a collision is detected **and**
`MailConfigService.isConfigured()` is true, the controller enqueues a
`mail-send` job (`templateId: "email-in-use-notice"`) addressed to the
*existing* owner of the address — a calm, URL-free security notice
naming the server, with nothing to click and nothing to act on unless
the recipient recognizes the attempt as unwanted. An unconfigured
install produces zero signal, honestly documented as a delta rather than
silently degraded.

**Rate limiting the notice itself.** A per-address ledger
(`email_collision_notice_ledger`, migration 0025 — `email CITEXT primary
key, last_notice_at_ms bigint`) caps delivery to at most one notice per
address per 24 hours, claimed atomically with a single
`INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING`
statement (`claimEmailCollisionNoticeWindow`,
`packages/db/src/query/email-collision-notice.ts`) — a database ledger
rather than the in-memory `KeyedRateLimiter` every other rate limit in
this codebase uses, because this window has to survive a routine server
restart and `@loombre/jobs` exposes no dedup primitive to ride on
instead. The `isConfigured()` check runs **before** the ledger claim, so
an unconfigured install never burns the window — a later collision
against the same address, once mail is configured, still notices. The
window is address-keyed, not dispatch-site-keyed: a collision reached
through the claim flow and one reached through the email-change flow
share the same 24-hour window for a given address.

**A fresh timing surface, and its fix.** The collision cell of an
email-bearing request does strictly more post-commit work (a ledger
claim, sometimes an enqueue) than the non-collision cell — a caller
could otherwise time "did my attempt collide" purely from response
latency. Both `updateMe` (whenever the body carries an `email` member)
and `claimInvite` (unconditionally, since every claim resolves an email
one way or another) apply a fixed wall-clock floor — `EMAIL_CHANGE_MIN_MS`
/ `CLAIM_INVITE_MIN_MS`, both 200ms, the same `FORGOT_PASSWORD_MIN_MS`
precedent already used elsewhere — so the collision and clean cells cost
the caller the same regardless of which one actually happened. A plain
profile save with no email member is not floored at all.

## Why this holds together: enumeration safety (E8)

All three measures were built against one standing rule: a response must
never let a caller distinguish *why* something didn't happen the way
they expected. Concretely, this run's own adversarial test suite
(`apps/server/test/reauth-adversarial.e2e.spec.ts`,
`apps/server/test/email-collision-matrix.e2e.spec.ts`) pins:

- A wrong `currentPassword` produces byte-identical `403` bodies whether
  the target was a password, a free email, or a colliding email — and
  whether it was thrown from `updateMe` or `putRestricted`.
- A missing `currentPassword` produces byte-identical `422` bodies under
  the same conditions.
- A colliding-email response is indistinguishable from a free-email
  response, STATUS AND SHAPE, across the full `{claim, email-change} x
  {mail configured, unconfigured} x {notice window fresh, already
  claimed}` grid.

None of this is enforced by convention alone — every claim above has a
matrix or e2e case backing it, and a future change that breaks one of
these fails a test, not just a review.

**This does NOT extend to the residual body-VALUE oracle documented under
"Email-collision signal (F5)" above (R-F1/R-F2)** — that gap is real,
proven by live probe, tracked as a pending owner decision, and
deliberately NOT claimed as closed here. Cite this page's E8 claims at
the STATUS/SHAPE granularity they were actually tested at; do not extend
them to "no enumeration channel exists anywhere on these endpoints"
without reading the known-limitation callout above first.

## Appendix: the unauthenticated surface, enumerated (R9)

<!-- Sourcing: apps/server/src/gateway/auth.guard.ts (PUBLIC_ROUTES +
     PUBLIC_ROUTE_PATTERNS), apps/server/src/remote/probe-page.controller.ts,
     apps/server/src/remote/wireguard/ + packages/wg-native (listener),
     apps/server/src/remote/tunnel/cloudflared-connector-manager.ts.
     STATE.md "Loombre Remote" R9: the probe endpoint, the WireGuard UDP
     listener, and the cloudflared connector are the ONLY unauthenticated
     surfaces that remote-access work added — this appendix is the standing
     enumeration R9 requires, and any future addition to PUBLIC_ROUTES or
     any new listener/child process MUST add a row here in the same PR
     (review-blocking otherwise). -->

Every surface reachable without a valid access token, and why each one is
allowed to exist. Anything not listed here that answers unauthenticated
traffic is a bug.

**HTTP routes (`PUBLIC_ROUTES` / `PUBLIC_ROUTE_PATTERNS` in
`apps/server/src/gateway/auth.guard.ts` — the M12 quartet applies to every
entry: contract `security: []`, guard entry, conformance
`PUBLIC_OPERATION_IDS`, named rate-limit policy):**

| Surface | Why it must be public | Containment |
| --- | --- | --- |
| `GET /healthz` | Liveness for supervisors/proxies; also the restart poller's probe. | Static body, no version/config data. |
| `POST /auth/login`, `POST /auth/refresh` | The door itself. | Dedicated auth rate limiters; anomaly log; byte-uniform failures. |
| `GET /system/capabilities` | Pre-login client feature negotiation. | Feature flags only; `rateLimit.capabilities`; no instance identity. |
| `GET /setup/state`, `POST /setup/first-admin` | First-run bootstrap has no users yet. | Permanently 404s (byte-identical to catch-all) once any user exists; `rateLimit.setup`; advisory-lock race safety. |
| `POST /auth/forgot-password`, `POST /auth/reset-password` | Recovery is for people who cannot authenticate. | Anti-enumeration empty responses; shared `rateLimit.passwordReset` (per-IP); tokens SHA-256-hashed at rest, single-use. |
| `GET|POST /invites/claim/{token}` | Invitees have no account yet. | High-entropy token, hashed at rest; `rateLimit.claim`; unknown/expired byte-identical 404. |
| `GET /probe/{token}` (remote-access run) | The reachability proof MUST be reachable before auth works from outside — the phone on cellular is the external vantage (R6). | 256-bit single-use token, SHA-256 at rest, 15-min expiry, DB-equality lookup (constant-time by construction); `rateLimit.probe` per-IP; success page is fixed static HTML with zero server info (no name, no version, `res.end()` so no ETag); every failure is the byte-identical catch-all 404. |
| `?token=` query-param transport on `@AllowQueryToken()` media routes | `<img>`/`<video>` elements cannot send headers. | Still a fully-validated signed JWT — alternate transport, not an auth bypass. |

**Non-HTTP listeners and processes:**

| Surface | Why it exists | Containment |
| --- | --- | --- |
| WireGuard UDP listener (`remote.wireguardPort`, default 51820 — only when the Remote path is enabled) | The Private Ring's front door; WireGuard by design authenticates with the first packet. | Cryptographic silence: packets that do not complete a Noise handshake against an enrolled peer key get NO bytes back (property-tested in `packages/wg-native` + server e2e — garbage and wrong-key initiations both). Scanners see a closed port. Tunnel egress is a raw pipe to the loopback backend listener ONLY — netstack registers no forwarder, so the tunnel cannot reach the LAN or any other address (containment-tested). |
| Loopback backend HTTP listener (ephemeral port, 127.0.0.1, only while Remote is enabled) | Hands tunnel TCP streams to the same Express handler the main listener uses (RG2). | Bound and verified loopback-only; unreachable from the network; carries the same auth stack as the main listener (tunnel transport ≠ authentication — every request still needs a valid token). |
| `cloudflared` connector child process (Tunnel path only) | Cloudflare's outbound-only tunnel daemon (R4, BYO token). | Outbound connections only — no listening socket of ours; connector token delivered via `TUNNEL_TOKEN` env (never argv, never logged); supervised with bounded restarts; its stdout/stderr ring buffer is admin-only via `getRemoteTunnelLogs`. |
| IPC loopback listener (`apps/server/src/ipc/`) | Pre-existing (not from the remote run): tray/menubar controller channel. | Loopback-bound + bearer token + `timingSafeEqual`; enumerated here for completeness. |

The remote-access run added exactly three rows (probe route, WG UDP
listener + its loopback backend, connector child) — matching R9's
"ONLY new unauth surfaces" claim. UPnP/NAT-PMP/PCP appear nowhere in this
codebase, enforced by a grep-gate and stated in the ops docs as a feature:
Loombre never reconfigures your network.
