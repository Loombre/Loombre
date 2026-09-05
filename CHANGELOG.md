# Changelog

All notable changes to Loombre are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) —
docs/PLAN.md §4.1's additive-only-within-a-major-version policy governs the
API surface specifically (`oasdiff` enforces it in CI); this file is the
human-readable history alongside that machine-enforced contract.

**Convention note:** `1.0.0-beta.1` (2026-09-03, a GitHub pre-release) is
Loombre's first published release, so it is the first entry with a real
semver header. Everything beneath that header is the development history
that shipped in it: the `v0.9.0-rc.*` sections were tags whose drafts were
never published, and the older sections document *development-phase*
history against the project's internal `STATE.md` phase tracking rather
than shipped versions (single-source version stamping arrived in Phase 4,
STATE.md P4.11). Those sections keep their original names as the version
axis; nothing before `1.0.0-beta.1` was ever released.

## [Unreleased]

### Added

- **`.rpm` and `.deb` packages for Linux x64.** `sudo dnf install
  ./loombre-<version>-linux-x64.rpm` or `sudo apt install
  ./loombre-<version>-linux-x64.deb` puts the payload at `/opt/loombre`,
  creates the `loombre` system user, the data dir and
  `/etc/loombre/loombre.env`, installs the three systemd units and the
  `loombre` CLI, then enables and starts the services — and an upgrade
  stops them before the files change and starts exactly those again, while
  never touching your env file. Channels: the `.rpm` covers Fedora, RHEL 9
  and 10 with their Rocky/Alma rebuilds, and openSUSE Leap 15.6; the `.deb`
  covers Debian 12 and 13 and Ubuntu 22.04/24.04 LTS; the tarball remains
  the channel for every other glibc ≥ 2.34 distro and the only one with
  relocatable paths. Both packages are built from the release tarball
  itself, so all three channels ship identical bytes for a version.
  (`docs/install/linux.md`.)

### Changed

- `install.sh` renders the env file from
  `installers/linux/loombre.env.template` instead of an inline heredoc —
  the same template the packages render, proven byte-identical.
- The env template documents `LOOMBRE_SERVER_ORIGIN`, the variable LAN
  installs need alongside `LOOMBRE_CORS_ORIGINS`: the web client's CSP
  allows calls to that one API origin, and it defaults to
  `http://localhost:3001`.
- The Linux tarball now bundles Node's own `LICENSE` next to the runtime.

## [1.0.0-beta.1] — 2026-09-03 (pre-release)

Published as a GitHub pre-release for testers: the in-app update check
reads `releases/latest` only, so betas are never announced to it.

- First 1.0 beta, for testers — the v0.9.0-rc.12 dry-run tree plus the
  subtitle fixes below. The line from here: `1.0.0-beta.N` tester builds,
  then `1.0.0-rc.1` (the build intended to ship unchanged), then `1.0.0`
  on the same code. 1.0.0 is where docs/PLAN.md §4.1's additive-only API
  policy becomes a public promise. (The tag was cut twice before this and
  discarded unpublished each time — first ahead of the subtitle fix,
  then ahead of the seek-performance work below — along with every
  rc.* tag; none of them ever had a published release.)
- Player: seeking is fast. Every transcode/remux session now serves
  2-second HLS segments (was 6 s): the first playable segment after a
  seek needs a third of the encoded content it used to (a 1×-realtime
  server: ~7 s → ~3 s; Apple Silicon hardware encode: 0.9 s → 0.4 s),
  soft seeks fetch three-times-smaller fragments, and the server holds
  the playlist request while a seek is in flight (until the restarted run
  is actually listed) so the player lands the moment it exists. Windows servers no longer pace the
  head of every run (`-readrate_initial_burst 30`), which alone was
  costing ~6 s per seek there. Rapid seeks coalesce client-side; the
  worker reacts in 100 ms and no longer rewrites unchanged playlists; and
  the player's forced playlist reloads no longer push its next natural
  refresh out by one interval each (the 10–40 s freeze right after a seek
  landed on the old build). The video pauses at the seek and resumes at
  the landing instead of playing the abandoned run under the spinner.
  (docs/PLAYBACK.md §9 "Segment duration"; reports/state/DECISIONS.md
  SPF-1–SPF-6.)
- Player: playback failures name their cause. Every unavailable screen
  and seek toast shows a specific error code (`transcode-input-missing`,
  `transcode-encoder-init-failed`, `hls-network-error` with the HTTP
  status, …), a one-line explanation and a copyable detail line; failed
  sessions expose `errorDetail` on the API (sanitized, never the raw
  ffmpeg log). Try again from the error screen restarts playback where
  you were. The codes are documented in the user guide
  (docs/user-guide/playback-errors.md). (SPF-7.)
- Server: the default number of simultaneous conversions is 2 (was 1),
  and when every slot is taken the server first releases the stalest
  paused-and-left session (no heartbeat for 90 s, `evicted-for-admission`)
  instead of refusing — a viewer who walked away no longer blocks the
  next one. (SPF-8, SPF-9.)
- Server: a viewer who comes back after the 90 s idle suspend is revived
  by their next heartbeat (status back to active, encoder resumed) instead
  of staying frozen until the 15-minute sweep — and is therefore never an
  eviction candidate while watching. (Peer review R1.)
- Server: HEVC is only preferred for conversion when a hardware encoder
  actually verifies it (or, on tier 1/2, when the box has no hardware
  encode route at all). The always-present software encoder used to
  satisfy the check, so tier-0 machines software-encoded libx265 at 2–4×
  the cost of H.264 and h264-only hardware encoders were bypassed for
  full software — a plausible cause of stutter on software boxes.
  (SPF-10, peer finding.)
- Playback planning: H.264 Constrained Baseline and Constrained High
  (phone recordings, screen captures, WebRTC/OBS exports, many hardware
  encoders) now rank at their parent profiles instead of being treated as
  unsupported, so those files direct-play again rather than being forced
  through a transcode session that occupied a conversion slot and turned
  native seeking into the restart path. (SPF-12, peer finding.)
- Worker: a library whose folder is missing, blocked by a macOS privacy
  prompt, or otherwise unreachable can no longer freeze the worker at
  boot — the file watcher probes every path with a timeout and skips the
  ones that don't answer, so scans, probes and transcodes keep running.
  Found live on a stale Desktop library: every job silently stalled.
- Worker: the file watcher can no longer stall jobs at all. Job consumers
  now register and confirm before any watcher starts, and the watcher
  itself runs in its own thread, so a native watch that macOS holds on a
  privacy prompt (or an FSEvents quirk) costs that library's change
  notifications and nothing else. On macOS a library under Desktop,
  Documents, Downloads, iCloud Drive or a Photos library is watched by
  stat polling, which never makes the call macOS can hold; a watcher
  thread that is wedged inside the OS is never joined at exit, so a
  restart or crash still ends the process instead of leaving it alive but
  dead. `LOOMBRE_SCAN_POLL=0/1` still overrides every automatic rule.
  Verified on a Mac with a library whose Desktop folder had been deleted.

- Player: text subtitles can actually be turned on. The track picker still
  rendered every subtitle as "requires transcoding (Phase 3)", a Phase-2
  stub left behind after the server grew its WebVTT side-track
  (docs/PLAYBACK.md Stage E `hls-vtt` + the subtitle-extract worker job).
  Picking a text stream (subrip/ass/webvtt/mov_text) now re-creates the
  session pinned to it (`PlanRequest.selection.subtitleStreamIndex`),
  resuming where the viewer was with no second resume prompt; Off and
  re-picking the extracted stream are client-side only. Image subtitles
  (pgs/vobsub/dvbsub) stay disabled with an honest "needs burn-in
  (transcode)" note. The picker's note no longer overflows the popover.
- Player: the side-track is fetched with a CORS request and attached as a
  blob: URL — a bare cross-origin `<track src>` is refused by browsers, and
  the web app and server are different origins in every deployment (:3000
  vs :3001). The fetch retries while the subtitle-extract job is still
  running (the live check hit two 404s before the 200).

### v0.9.0-rc.12 draft (2026-09-03)

- Twelfth release candidate — a pipeline dry run, the first tagged build
  with the Intel macOS leg below. No product changes beyond the fast-uri
  bump.
- deps: fast-uri 3.1.5 → 3.1.6 (transitive, via the server's ajv) —
  clears four HIGH advisories published 2026-09-02 (host confusion / SSRF
  in URI normalization: GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc,
  GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp). Lockfile-only; no
  audit-allowlist entry.
- macOS: the release pipeline now builds an Intel (`x64`) `.pkg` alongside
  the Apple Silicon (`arm64`) one — one matrix leg per architecture, the
  x64 leg natively on GitHub's `macos-15-intel` runner, each leg asserting
  its runner CPU matches its arch before building (`swift build` and the
  wg-native Go build emit host-arch binaries; `--arch` only selects the
  Node/ffmpeg/PostgreSQL payload). Intel support is published on a demand
  basis and may be dropped in a later release; docs/install/macos.md
  states the policy.

### v0.9.0-rc.11 draft (2026-09-02)

- Eleventh release candidate — the macOS recursive-grant fix below.
- macOS folder grant: apply the media-folder read entry with `chmod -R +a`,
  not `chmod +a`. The inherit flags only reach files and subfolders added
  after the grant; existing contents were left unreadable (the folder was
  granted but the media inside it was not). `-R` reaches what already
  exists. The menu bar app's read operation, the picker's fallback command,
  and the install guide all carry the fix; the traverse-only and names-only
  grants stay single-directory. Linux (`setfacl -R`) was already correct.

### v0.9.0-rc.10 draft (2026-09-01)

- Tenth release candidate — rc.9's cross-platform media-permissions wave
  plus the macOS native grant flow below.
- macOS: the folder picker's permission grant no longer needs Terminal.
  Each step of the home-folder flow gets an **Allow in Loombre…** button
  that hands the grant to the menu bar app via a new `loombre://grant`
  URL scheme; the app re-validates the request under the server's own
  policy (never a whole-home read, never Desktop/Documents/Downloads,
  traversal only on your own home), shows a native consent dialog naming
  the exact folder and scope, and applies the same `chmod +a` entry as the
  signed-in user — no password, since you own the folder. The picker
  re-checks automatically. Commands remain for browsers on other machines.
  Contract: additive `FilesystemPermissionRemediation.nativeGrantUrl`.

### v0.9.0-rc.9 draft (2026-09-01)

- Ninth release candidate — the media-permissions fix wave from the rc.8
  macOS installer live test. The folder picker's "grant access" flow was
  unreachable for media in a macOS home folder (it deliberately offered
  nothing for `/Users/<you>`, and listing the home is exactly what the
  `_loombre` service account is denied); it is now a two-step flow — a
  names-only `list,search` ACL on the home folder, then the media folder's
  own inheriting read grant — with a scope note on every step
  (`FilesystemPermissionRemediation.note`, additive). Whole-home read
  grants are still never scripted.
- Linux gets the same scripted flow with POSIX ACLs (`setfacl`: traverse-
  only on blocked ancestors, recursive read + default entry on the media
  folder — additive and revocable), except where it provably cannot work:
  systemd's `ProtectHome` roots, filesystems without ACLs (FAT/exFAT/NTFS/
  network), containers. The 403/404 details on Linux and Windows are now
  path-aware: `ProtectHome` (`/home` is hidden outright — bind-mount
  guidance), desktop Linux's private `/media/<you>` mount roots, and the
  Windows services' LocalSystem account (mapped drive letters invisible;
  shares reached as the computer account — UNC + share-permission
  guidance). Install guides updated accordingly; the Linux guide's
  `chown -R loombre:loombre` advice is retired (it took the files away
  from the operator).

### v0.9.0-rc.8 draft (2026-08-31)

- Eighth release candidate, drafted from `main` — rolls up everything
  since rc.7 (2026-08-10): the AV1 ladder / adaptive multi-variant
  delivery / encoder-lifecycle wave, seek model V8, the full-app QA
  sweep and remediation, the web UI conformance pass, zone-only
  restricted content, and the verified remote-access + mail fixes
  (entries below).
- Documentation corpus audited end-to-end (doc-audit-2026-08-30, 325
  verified findings) and corrected in the same-day fix run
  DFX-2026-08-31: specs, install/ops/admin/user/developer guides,
  API-reference prose, installer and design docs now match the code at
  HEAD; a sourcing-citation grep-gate now guards doc→code pointers.

### Remote access & mail: verified as packaged, and fixed (2026-08-30)

A verification pass took the 2026-08-04 Remote-access and mail features
from "reviewed and green in CI" to verified-as-shipped, and fixed what it
found. Distribution gaps closed: the WireGuard native library and the
mail environment plumbing were missing from every shipped distribution —
Loombre Remote now works from a real installed artifact, not just a dev
checkout. Live events now reach the TLS and WireGuard remote paths (the
events socket was attached to the wrong HTTP server), a
WebSocket-triggered shutdown hang is fixed, and enabling the tunnel path
auto-writes its settings so the posture card shows the tunnel hostname.
Mail hardening: queued invite/reset jobs no longer embed the action link
— the payload carries a sealed (AES-256-GCM) reference and the worker
builds the URL from the *current* configured public URL at send time;
the reachability probe's URL scheme likewise derives from the configured
public URL; the `mail.failed` event's template enum covers the
email-in-use notice; every reverse-proxy recipe now routes
`/probe/{token}`; and the SMTP credential pair is documented.

### Restricted content is now zone-only (2026-08-30)

The restricted-content visibility model is amended (docs/PLAN.md §6.4
surface scoping): general surfaces — browse, search, home rails,
"recently added", watchlist and progress lists, people, tags — compile
the general-only filter unconditionally, so a live unlock never changes
what they return. Restricted items are reachable ONLY inside the
dedicated restricted zone (plus direct item-addressed reads), each still
requiring the full five-gate clearance. Spatial separation replaces
temporal: previously, a live session unlock made restricted rows appear
in regular search/browse/recently-added until relock. `ViewerContext`
gains a `surface` dimension enforced by the query guard itself; the zone
gets its own watchlist rail, a zone watchlist toggle, and a route-driven
websocket zone subscription. User and admin docs updated to the new
model.

### Web UI conformance pass (2026-08-29)

A design-system enforcement run across the web client: shared
control-height tokens and pulse keyframes, machine-enforced spacing and
type scales (the mono floors retired), a Toast action rule, the topbar
rebuilt as three zones with a route label and centred search field,
sentence-case pill labels, and a full rework of Settings → Advanced —
plus dozens of smaller alignment, copy, and behavior fixes verified
against a 52-shot screenshot baseline. The `/browse` route budget
re-measured green (175.6 of 200 KB gz).

### Full-app QA sweep and remediation (2026-08-20 → 2026-08-25)

A QA sweep of the whole app (API validation, browser flows, player,
restricted surfaces) produced 46 findings plus four follow-up dispatch
waves, all fixed and verified. Server: write paths gain body-key
allowlists and honest validation (UUID checks on every plugins route,
duplicate username/email → 409, email-format checks, a first-admin field
allowlist), `/home/continue-watching` gains real cursor pagination, the
whole 404 family shares one problem shape, the restricted capability is
auth-only, and legacy `/admin/*` routes redirect at the HTTP level.
Player: the EOF-seek wedge self-repairs, hls.js fatal retries are
bounded with failed sessions surfaced honestly, deep-link `?t=` routes
through the hard-seek path, keyboard shortcuts are gated while the
resume prompt is open, StrictMode's twin session-create is deduped, and
sessions end on full-document teardown. Web: doomed poster fetches are
skipped, the watchlist-id fetch is shared and retried, a 401 routes to
`/login`, browse sort round-trips through the URL, and the zone filter
panel stops overflowing phone widths.

### Seek model V8: source-clock seeking (2026-08-20)

Seeking on transcode sessions is rebuilt around the source clock:
playlists carry timing anchored to the SOURCE axis, a seek is a
first-class server call with an explicit client landing (no more
inferring where a seek landed), absorbed seeks land at response time,
and hard seeks are never silently swallowed. Follow-ups serialize EOF
progress flushes and stop segment-GET self-relocation churn.

### AV1 ladder, adaptive multi-variant delivery, encoder lifecycle (2026-08-11)

Transcode sessions gain a real ABR ladder: a master playlist with a
`v{K}` variant family under a slot-handoff law (rung switches rebuild
ffmpeg arguments and hand off mid-session under a single-restart rule),
a Tier-0 advertised-variant cap in the pure decision engine, and a
quality selector in the player; the playback matrix grew past 540 cases
covering it. A parallel lifecycle-hardening pass guarantees no orphaned
encoders: ffmpeg pids are persisted and a boot reaper reclaims
crash-orphaned transcodes, graceful shutdown terminates in-flight runs,
retention-pruned HLS playlists state their media sequence correctly, and
plugin circuit-breaker state re-seeds on boot.

### v0.9.0-rc.7 draft + deletion-proof ffmpeg vendoring (2026-08-10)

Upstream deleted the pinned ffmpeg autobuild mid-draft, so vendoring is
now deletion-proof: the seven ffmpeg/ffprobe archives are mirrored
byte-identically on a dedicated `ffmpeg-mirror` release, the fetch
script falls back to the mirror on a primary download failure, and a
daily liveness probe watches the primary sources. The v0.9.0-rc.7 draft
was built on the repinned vendors.

### Owner fix list LD-1..13 + playback QA fixes (2026-08-10)

An owner live-QA pass produced thirteen fixes across the player and
settings — including the player transport's seek buttons moving from
15s-back/30s-forward to a symmetric **10 seconds in both directions**
(LD-12, superseding the 2026-07-25 transport entry below), a fixed
session-refused layout, settings pages that report hardware-transcode
status truthfully, one unified Plugins page (registered plugins join
provider keys), and Advanced-server registry repairs (dead switch, chip
locks and ordering, JSON editor). Same-day playback fixes: open-GOP HEVC
leading pictures are stripped on seek-restart copy runs, the HLS
manifest serves while a session is suspended, the heartbeat scheduler no
longer crashes on first play, Safari's token rotation no longer reloads
playback every ~15 minutes, and event ordering is guaranteed (UUIDv7
ties sort deterministically). Dev hygiene: destructive test suites are
isolated from the dev database, and a cleanup script swept 1,062 leaked
test databases (14.6 GB).

### v0.9.0-rc.5/rc.6 drafts, macOS live-test fixes, docs site live (2026-08-06 → 2026-08-08)

Three release-candidate drafts went through the real tag-triggered
pipeline: rc.4 and rc.5 on 2026-08-06 (the Windows WiX leg's XML-comment
bug found by rc.4 and proven fixed by rc.5) and rc.6 on 2026-08-08
(after clearing a dependency-audit HIGH via a scoped nanoid override). A
three-wave polish pass landed shared design-system fixes, an IA
restructure with page-level polish, and first-class handling of an
empty hardware-capability set. macOS live-testing fixes: the `.pkg`
pins Loombre.app non-relocatable (it could previously install over a
stray copy instead of `/Applications`), the directory picker gains a
scripted folder-access grant flow, and the menubar's reopen behavior
opens the web UI. The documentation site went live at
[www.loombre.com/docs](https://www.loombre.com/docs) (2026-08-07/08).

### Security & correctness audit fix waves (2026-08-05 → 2026-08-06)

Six fix waves against a full-codebase audit: an unauthenticated ACME
denial-of-service plus three sibling missing-error-boundary defects;
five silent data-loss/integrity defects; SSRF bypass, secret-leakage,
token-revocation and rate-limit gaps; contract-surface fixes (17
cursor-validator 500s, DELETE status drift, enum gaps); release-pipeline
gaps (the signed-manifest gap, an arm64 hardcode, the untested default
install path); and a polish wave for docs that fail when executed, false
spec claims, dead code, and measured UI defects. The first fully green
3-OS CI run on `main` followed the merged result.

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

The sidebar/tab-bar glyphs, player transport (play/pause and the seek
buttons — at the time 15s-back/30s-forward, matching iOS's
`gobackward.15`/`goforward.30`; superseded 2026-08-10 by the symmetric
±10s transport, LD-12 — see that entry above), the restricted-content
lock, and a
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
(hardware-transcode status, the anti-telemetry assertion line — the
static "no phone-home code exists" statement), Libraries and Users &
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
  installers + two cosign-signed multi-arch Docker images
  (`loombre`, `loombre-web`), assembling and
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
- Zero third-party media-server API surface, schema, or naming anywhere —
  enforced by a CI grep gate from commit one, alongside the telemetry-import
  ban (D14: no telemetry, ever).
