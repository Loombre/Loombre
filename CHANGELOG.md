# Changelog

All notable changes to Loombre are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) —
docs/PLAN.md §4.1's additive-only-within-a-major-version policy governs the
API surface specifically (`oasdiff` enforces it in CI); this file is the
human-readable history alongside that machine-enforced contract.

**Convention note (pre-v1.0):** Loombre has not had a tagged public release
yet — every entry below through Phase 4 documents *development-phase*
history against the project's internal `STATE.md` phase tracking, not a
shipped version (the root `package.json` version stayed effectively
unreleased through Phases 0–3; STATE.md P4.11 introduced real single-source
version stamping in Phase 4). Once a `v*` tag is actually pushed, entries
below gain real semver headers and dates, and this note can be retired.
Until then, phase names are the version axis.

## [Unreleased]

### System notices: admin broadcasts with live delivery everywhere (2026-08-04)

Admins get a first-class broadcast channel — **Settings → Notices** —
composing a message (500-char plain text, info/warning/critical) with
quick presets ("Restart in 5/15/30 min" pre-fills a critical notice with
a live countdown; "Maintenance" a warning with a composer-set window).
One active notice at a time: publishing replaces the current one after
an explicit confirm, cancel takes it down live. New contract surface
(tag `notices`): POST /system/notices, POST /system/notices/{id}/cancel,
GET /system/notices (admin history, cursor-paginated, derived status),
and GET /notices/active — the all-user read every client calls on boot
and socket reconnect, so late connectors see an active notice too. Two
new ALL-USER event types (`notice.published`/`notice.cancelled`, enum
35→37) ride the existing outbox → events-socket broadcast path with zero
new plumbing. Rendering per severity: info → the standard toast;
warning → persistent dismissible top banner (per-session, returns on
reconnect); critical → non-dismissible banner — via the app's FIRST
global banner region (AppShell), with system notices taking precedence
over the settings restart-pending banner. All severities also render as
a non-blocking overlay strip INSIDE the video player's stage element —
the only DOM position that survives real fullscreen — so a fullscreen
viewer never misses a restart warning. Countdowns are computed against
server time (`serverNowMs` / envelope `tsMs` anchors), never the
client's wall clock, and flip to a static "restarting now" state at
zero — the notice system deliberately restarts nothing (the Power card
remains the operator action). New table `system_notices` (migration
0028, real severity enum, expiry CHECK: only critical may run
"until cancelled"); audit = the broadcast events themselves (envelope
actor). Admin + user docs.

Post-review polish: message length is counted in characters (code
points) everywhere — 500 emoji are 500 characters, not 250; every
cursor-list endpoint now clamps `?limit` to the contract's maximum
(200) via one shared helper; the mobile notice banner clears the
compact back-mode header correctly instead of leaving a 46px gap; and
the restart copy is honest about today's reality — every setting on the
settings screens applies immediately (the restart-pending banner
machinery stays, tested, for the first future setting that genuinely
needs a restart).

### Web admin: Restart / Shut down server from Settings → Server (2026-08-04)

New admin-only contract operations **POST /system/restart** and
**POST /system/shutdown** (202-before-teardown, RFC 9457 refusals; SDK
regenerated), surfaced as a "Power" card on the Server settings tab with
danger-tinted confirm steps. Restart rides the existing graceful-shutdown
path but exits with a NAMED restart code (86) that every shipped
supervisor relaunches — launchd `SuccessfulExit=false`, systemd
`on-failure`, Windows SCM recovery (the service host logs the code by
name instead of calling it a crash), Docker `unless-stopped` — and the UI
polls `/healthz`, claiming "back online" only after observing the server
actually go down first. Shutdown reuses the tray/menubar in-band
self-stop (clean exit, stays down everywhere except Docker); under
container supervision the endpoint refuses honestly with a 409
(`shutdown-unsupported-under-container-supervision`, the image sets
`LOOMBRE_SUPERVISOR=container`) pointing at `docker compose stop`, and
the UI renders that verbatim. The settings "RESTART REQUIRED" banner
finally gets its pairing: a link to the new Power card. Triggers are
armed only by the direct-entrypoint bootstrap, so embedded/test contexts
(conformance walks the endpoints with a live admin token) get a logged
no-op instead of a dead test runner. New admin-guide page "Restart &
shut down".

### Full-shutdown parity: Windows tray + Linux/Docker docs (2026-08-04)

Closes the Windows parity gap flagged in the macOS entry below. The
Windows tray gains **"Shut down Loombre…"**: confirmation dialog → one
UAC prompt → `net stop` of all three services consumers-first
(LoombreWorker → LoombreWeb → LoombreServer, so the bundled-PG-hosting
server goes down last and SCM dependents stop before their dependency) →
SCM verification that everything reports Stopped → the tray exits too.
Stop stays deliberately admin-only (Services.wxs grants Users
query+start, never stop) — the same one-prompt posture as macOS.
**"Start server" is now "Start Loombre"** (it already started all three
services; the label catches up). Canonical service names/orderings/
elevated command lines move to the cross-platform-testable
`Loombre.Tray.Ipc/ServiceStack.cs`, pinned by new `ServiceStackTests`
(46/46 green on macOS via `dotnet test`; the WinForms tray compiles
clean with `EnableWindowsTargeting`).

Linux and Docker are headless — their service manager is the interface —
so parity there is explicit documentation: `install/linux.md` gains a
"Stopping / shutting down completely" section (one `systemctl stop` line
with the correct ordering, plus `disable --now` for off-across-reboots)
and `install/docker.md` gains the compose `stop`/`down`/`down -v`
distinctions.

### macOS menubar: full shutdown UI (2026-08-04)

The macOS menubar app gains **"Shut Down Loombre…"** — the first UI able
to stop the whole installed stack. Previously "Stop Server" only ended the
API server process and "Quit" only closed the menu bar item, leaving the
worker and web LaunchDaemons running with no way to stop them short of
`sudo launchctl` in a terminal. The new item, after a confirmation dialog
and one administrator prompt, boots out all three daemons (worker → web →
server, so the embedded-PostgreSQL-hosting server goes down last) and then
quits the menubar controller — nothing of Loombre left running. Services
still return at next boot (`RunAtLoad`); the dialog says so.

**"Start Server" is now "Start Loombre" and starts all three daemons**,
not just the server — required so a full shutdown is recoverable from the
menu (a server-only start would have left worker + web booted out until
reboot). Idempotent per-service `kickstart || bootstrap` groups; verified
`launchctl` exit-code semantics are pinned in `LifecyclePlanTests`.

Windows parity gap noted (tray "Exit" likewise leaves the services
running, though `services.msc` at least exists there) — not addressed in
this change.

### Loombre Remote: embedded WireGuard, three-path wizard, reachability proof, posture card (2026-08-04)

Remote access lands end-to-end. **Loombre Remote** embeds a userspace
WireGuard endpoint (wireguard-go/netstack class) inside the Loombre
process — no kernel module, no root, no OS network interface, no
routing-table changes — exposing only Loombre's listener through the
tunnel, never the LAN, with per-device keys, split-tunnel QR/`.conf`
provisioning in an app-agnostic format, and revocation wired into the
device list. Two alternative paths ship beside it: BYO-token tunnel
automation with a managed connector, and a guided Direct path (ACME +
router instruction cards). A three-path wizard routes between them by
interview (CGNAT detection included), a one-time-token cellular-QR
reachability proof verifies the chosen path from genuinely outside the
LAN, and an exposure-aware security posture card summarizes where the
install stands. Server surface in `apps/server/src/remote/`, native
tunnel code in `packages/wg-native/`, nine new
`remote.*`/`tunnel.connector.state`/`posture.*`/`probe.arrived` event
types, and fully restructured remote-access operator docs
(`docs/ops/remote-access/`). Adversarially security-reviewed across
every new surface; green on all three OSes.

### Current-password re-auth on self-changes + the email-collision signal (2026-08-02)

Account-critical self-service changes — password, email (set, change, or
remove), restricted PIN set/change, and restricted opt-in/out — now
require the current password, verified by the same argon2id compare as
login, constant-time on failure, and counted by a per-user rate limiter
*before* the compare so the re-auth prompt cannot become a
password-guessing oracle (wrong password → 403
`urn:loombre:problem:current-password-invalid`). A successful
self-service password change now revokes every other device's refresh
tokens (new `session.revoked-by-password-change` event) while keeping
the current session — the UI says so plainly. The invite-claim and
email-change flows gain the out-of-band email-collision signal,
enumeration-safe by construction (responses never split on whether an
email exists). Contract: `RestrictedSettingsUpdate` requires
`currentPassword`; `UpdateMeRequest` gains it via `dependentRequired`
on password/email only — bare display-name saves stay re-auth-free.
Phosphor settings forms gain the masked current-password field at both
breakpoints. Two adversarial review passes; docs updated in all
registers.

### Optional mail transport + invitation & reset flows (2026-08-02)

Loombre gains an optional SMTP mail transport plus admin-driven
invitation and password-reset flows that work end-to-end with **zero
mail configuration**: every invite and reset produces a copyable link
first; email delivery is an optional extra, never a prerequisite.
Invites are single-use (a concurrent-claim race admits exactly one
winner), revocable, expiring, and can never grant admin or
restricted-library access. Reset tokens are 256-bit, SHA-256 at rest,
30-minute, single-use, and enumeration-safe — timing probes were part
of review, and the fix wave drove the timing classifier back to chance.
With SMTP configured (which requires a validated public URL —
Host-header poisoning is defeated by never reading `req.headers.host`
anywhere in the mail/link pipeline), invite/reset/notice mail is
delivered as HTML+plaintext with zero external resources, sent through
a real job (`mail-send` — never inline SMTP), with failures surfacing an
admin notice plus a `mail.failed` event carrying the real SMTP error.
The admin test-send button reports real transport results both ways.
New admin (`mail.md`, `inviting-users.md`), user, and operator docs.

### Stash SQLite metadata sync + dedicated Restricted Content surface (2026-08-01)

Connect a Stash SQLite database and Loombre syncs its metadata — titles,
dates, studios, performers, tags, chapters, and covers (from DB blobs or
Stash's filesystem blob store) — strictly read-only: the Stash DB is
byte-identical after a full sync. Schema versions 67-85 are supported;
anything else disables the provider loudly with an exact status-card
notice and a `stash.provider.disabled` event rather than guessing.
Proven at scale on a real 43,679-scene library: 100% matched, 5.9 min,
562.6 MiB peak. Synced content lands in a dedicated Restricted Content
zone behind the restricted-content gates: uncleared viewers see zero
trace of the zone (no nav entry, no palette actions, zone URLs redirect
home), while cleared viewers PIN-unlock into zone home, browse, and
scene detail with chapter deep-links. Two new job types
(`stash-inventory`, `stash-sync`) and `stash.sync.*` events. Admin
guide: "Connecting Stash"; user guide: zone browsing.

### Phosphor movie/series detail screens + mark-watched (2026-07-25)

Movie and series detail pages are rebuilt to the Phosphor prototype's full
structure at both breakpoints: a full-bleed scene banner with a "← LIBRARY"
pill, a pulled-up poster + metadata column, per-file VERSIONS cards (size,
codec, full path, a DEFAULT badge), a CAST rail, and a METADATA card.
Series detail gains season pill tabs (replacing the old per-season
disclosure list) and episode rows with a watched badge and an in-progress
sliver; its primary action ("Continue S2E4") now reflects a real,
computed resume point.

**New: "Mark watched" / "Mark unwatched."** Movie detail's action row gets
a real toggle backed by the existing per-user progress record (previously
only writable implicitly via playback) — synced across devices like any
other progress update, with a confirmation toast.

**Movie-detail VERSIONS/METADATA cards now report each file's on-disk path,
video codec, HDR type, and every audio/subtitle track** — additive fields
on the existing per-item file listing, sourced from data the scanner
already probes and stores (no new schema, no migration).

**Known gap:** the METADATA card has no "match confidence" or "studio"
row — neither is modeled by any provider integration today, so nothing is
shown rather than a placeholder. Editing an item's metadata from this
screen is not yet possible (shown disabled with an explanation) — no
server-side capability exists yet, and building one needs an explicit
decision on how it interacts with per-field metadata locking. A capability
indicator for whether the current device can play a title without
transcoding was considered for the action row and deliberately left out:
nothing on this screen currently holds that verdict pre-play, and
computing an approximate one here would reintroduce a client-side
prediction the player itself moved away from.

### Phosphor custom icons, accent + scanlines preferences, ⌘K polish (2026-07-25)

The sidebar/tab-bar glyphs, player transport (play/pause, 15s-back/30s-
forward seek — the buttons now show and act on the same amount, matching
iOS's `gobackward.15`/`goforward.30`), the restricted-content lock, and a
handful of other icons the Phosphor design draws are now Loombre's own
custom glyphs instead of `lucide-react`'s. Everything else keeps its
existing lucide icon.

**Accent is now a user preference** — four options (amber, the default;
lime; mint; blue), applied instantly and remembered on this device.

**Scanlines are now a user preference**, default ON — a subtle static
texture over the item-detail banner and the player's idle/paused artwork.
Both preferences are client-side only for now (not yet synced to your
account) — a settings-page control for them is coming.

**⌘K / Ctrl+K** now opens the search field from anywhere and its results
include matching screens (Home, Browse, Settings, and — for admins — the
admin sections) and a couple of quick actions (lock/unlock restricted
content, sign out), not just catalog search.

### Phosphor Settings IA unification (2026-07-25)

Settings is now ONE surface for every user, at both breakpoints
(`design/phosphor/README.md` "Screens -> Settings" + "Screens -> Mobile ->
Settings hub"): `/settings` hosts a desktop pill-tab list + 760px pane, or
a mobile grouped hub list with live-derived badges (library/user counts,
provider-key coverage, registry key count — never stored, always
re-fetched). Non-admins see exactly their existing profile/restricted-PIN/
playback-preferences content, unchanged. Admins additionally get Server
(hardware-transcode status, the telemetry line), Libraries and Users &
Profiles (both restyled per the prototype, with real add-library/add-user
sheets), Playback and Remote Access (the relevant registry keys surfaced
inline), Plugins (metadata-provider keys) and Advanced Server (the full
registry), and About. `/admin/users`, `/admin/libraries`, and
`/admin/settings` still work as redirects to their new homes. The sidebar's
former duplicate "Settings" entry (one per audience) collapses to one;
the mobile large-title/in-page-heading duplicate title is fixed; the inert
theme picker is removed from the personal settings form (the contract's
`UserSettings.theme` field itself is untouched).

Two prototype fields have no server-side equivalent and are represented
honestly rather than faked: the RESTRICTED/GUEST user roles and the
restricted-profile PIN badge (the real user model only has `isAdmin` plus
an admin-settable content-rating ceiling, which is what's shown instead),
and a handful of Remote Access/Playback fields (detected reverse proxy,
token-redaction verification, direct-play preference) that no endpoint
backs today.

### Phosphor responsive mobile chrome (2026-07-25)

Below a 768px viewport width the labelled sidebar and desktop topbar are
replaced by a mobile large-title header (back navigation, restricted-lock
control, account menu) and a bottom tab bar (Home / Movies / TV Shows /
Search / Settings — Restricted joins once its route lands). The
now-playing mini-bar reflows to dock above the tab bar on phone widths.
768–1279px keeps Wave 0's icon-collapsed sidebar; ≥1280px is unchanged.
One component tree throughout — no separate mobile app or user-agent
branching, per `design/phosphor/README.md` "Responsive strategy".

Also: the Next.js default 404 page (previously an unthemed white page
inside this otherwise dark-only app) is replaced with a themed Phosphor
not-found page.

### Phosphor retheme; dark-only (light theme removed) (2026-07-25)

The web client's visual language is replaced wholesale: cool near-black
surfaces, an amber accent, self-hosted Archivo (variable width) + IBM Plex
Mono type, and a labelled 210px sidebar replacing the icon-only nav rail
(collapsing to icons below 1280px). Full details in
`design/phosphor/README.md`.

**User-visible feature removal: the light theme and its toggle are gone.**
Loombre is dark-only going forward — there is no setting to switch back.
This was a deliberate design decision (amber cannot legibly carry accent
text on a light background without a second, undesigned accent value); a
future light theme remains architecturally possible (the design tokens are
unaffected by whether more than one theme exists) but is not planned.

### Project renamed: Lumbre → Loombre (2026-07-24)

The project, formerly named **Lumbre** (Spanish: hearth-fire), is now
**Loombre** — a pronunciation respelling of the same word (LOOM-breh).
Because zero installs existed and nothing had ever been published, this
was a hard cut with complete internal freshness: no compatibility shims,
no migration paths, no legacy aliases. Every identifier moved in one
pass — npm scope (`@loombre/*`), CLI (`loombre`), env vars (`LOOMBRE_*`;
old-name vars are simply unknown), database name + the UUIDv7 SQL
function, keyring service, platform identifiers (bundle ids
`com.loombre.*`, `loombre.service`, Windows service with a fresh MSI
UpgradeCode), artifact names, docs, and the canonical domain
(loombre.com). This entry is the one place in the living tree that
records the former name; a permanent CI grep gate forbids it everywhere
else outside immutable dated history (STATE.md, reports/).

### Phase 4 — Product hardening (in progress)

Ground-up installable product: platform installers with embedded
PostgreSQL and bundled ffmpeg, first-run onboarding, export/import data
freedom, complete admin surfaces, signed release manifests with
notify-only update checks, operator documentation, a security hardening
pass, and a physical Tier-0 performance audit.

- **Release engineering** (this lane): single-source version stamping
  (root `package.json` → generated `packages/shared/src/version.ts` →
  `/system/info` + the new `loombre` CLI + the release manifest builder, all
  reading the one value); the `loombre` CLI (`--version`, `--help`, `paths`,
  `doctor`); the tag-triggered release pipeline
  (`.github/workflows/release.yml`) building Linux/Windows/macOS
  installers + a cosign-signed multi-arch Docker image, assembling and
  minisign-signing a release manifest + `SHA256SUMS`, and attesting build
  provenance for every artifact; the notify-only update check (`GET
  /system/update`, admin-only) — a zero-identifying-payload, minisign-
  verified, never-auto-applying manifest fetch (see `docs/ops/updating.md`
  for exactly what the request contains).
- **Contracts (Wave 0, frozen):** the embedded-Postgres provisioning
  interface (`@loombre/provisioning`), the local controller IPC contract
  (`@loombre/controller-ipc`), and the release manifest + minisign
  signing-format package (`@loombre/release-manifest`) — a zero-new-
  runtime-dependency ed25519 verifier proven against real, hand-encoded
  minisign wire-format fixtures, including tamper cases.
- Distribution posture decided: unsigned installers (no Apple
  notarization, no Authenticode — signing certificates cost money this
  no-telemetry, no-revenue project doesn't take), with checksums +
  minisign + cosign-signed images + first-class honest documentation as
  the trust model instead.

### Phase 3 — Playback engine (2026-07-24, complete)

The pure `plan()` decision engine (all seven pipeline stages: container,
video, HDR, audio, subtitles, bitrate/ladder, hardware routing), the
deterministic ffmpeg argument builder with golden-file tests, a real
hardware-capability self-test probe (verified against a physical macOS/M3
Max VideoToolbox target), and the HLS session execution layer (throttling,
seek, heartbeat, admission control).

- Matrix exit: **506 green / 0 red / 506 total** cases (target was ≥500),
  covering H.264/HEVC/AV1 × SDR/HDR10/HLG/Dolby Vision, every supported
  audio codec, all four subtitle strategies, and hardware/software
  capability sets.
- 28 golden ffmpeg-argument snapshots; all four property tests
  (determinism, direct-play bias, totality, reason-completeness) green in
  real (non-fixture) mode.
- Session integration suite green on all three OS CI runners
  (first-segment, seek numbering/discontinuity, throttle suspend/resume,
  heartbeat teardown, admission).
- Owner smoke-verified: a real 4K HDR10 movie tone-maps and plays end to
  end in Chrome from the web client, with live resume and in-window seek.
- Adversarial spec-vs-implementation audit: every finding fixed or logged
  as a tracked spec-clarification candidate — zero silent divergence from
  `docs/PLAYBACK.md`.

### Phase 2 — Direct play + web client (2026-07-23, complete)

Auth, devices, and remote-access groundwork; the web client's
browse/detail/search/player/music surfaces at the plan's performance
budgets; direct-play and direct-stream-free playback with progress and
continue-watching; device capability profiling at login; websocket
presence; the Tier-0 performance harness flipped from warn-only to
enforcing in CI.

- Budgets green and enforcing: browse-route JS ≤ 200 KB gz (118.5 KB
  measured), Lighthouse ≥ 90, Tier-0 server RSS/p95 within plan §9.2.
- Auth hardening: per-device rotating refresh tokens with reuse-detection
  chain revocation (proven live, not just unit-tested); restricted-content
  unlock/lock with auto-relock; per-IP/per-user rate limits with a
  fail2ban-compatible anomaly log.
- Design language locked: soft-geometry radius tokens, liquid-glass shell
  chrome, compositor-only motion, ambient backdrop depth — all measured
  under Lighthouse ≥ 90 + 60 fps with every effect enabled, not excepted
  from the budget.
- Security review pass: findings fixed or logged with severity + owner
  acknowledgment.

### Phase 1 — Catalog pipeline (2026-07-23, complete)

Idempotent, rename-aware scanner; content-hash file identity; ffprobe
ingestion into typed `media_streams`; TMDB/TVDB/MusicBrainz metadata
providers behind a common internal interface; field-level metadata
precedence and locks; a pre-scaled image pipeline with blurhash; working
search; live catalog API endpoints; domain events; and the restricted
(adult) content library proven leak-free across every surface.

- Leak-impossibility suite: zero `it.todo`s, adversarial review found no
  bypass (search, people/tags, images, continue-watching, event delivery
  — all query-guard-enforced, not UI-filtered).
- Real-library validation against the owner's own media (33 files, mixed
  HDR10/E-AC3-Atmos content) with zero parse failures and zero missing
  items; one real spec gap found and fixed (`color_transfer` not being
  persisted) during that pass.
- Parser fixture corpus: 123 movie / 157 TV / 62 music cases, all above
  the mission's minimums.

### Phase 0 — Contracts & harness (2026-07-22, complete)

Monorepo scaffold (Turborepo/pnpm/TypeScript strict); the OpenAPI
contract-first pipeline with a generated, drift-gated TypeScript SDK; the
full PostgreSQL schema including restricted-content structures and the
mandatory query-guard skeleton; the verification harness (`oasdiff`,
dependency-cruiser module boundaries, the license gate, the telemetry-ban
grep gate); and the (deliberately failing) 10-case `PlaybackPlan` matrix
scaffold that Phase 3 later turned fully green.

- 3-OS CI baseline green (ubuntu/windows/macos) on the very first pushed
  commit, with two real cross-platform bugs found and fixed in the same
  pass (a macOS `oasdiff` release-asset name mismatch; a Windows
  `pnpm`-shim spawn issue).
- Zero an upstream media server/an upstream media server API surface, schema, or naming anywhere — enforced by
  a CI grep gate from commit one, alongside the telemetry-import ban
  (D14: no telemetry, ever).
