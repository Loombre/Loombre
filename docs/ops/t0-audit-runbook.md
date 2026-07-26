# Tier-0 physical-hardware performance audit runbook

Phase 4 Wave 3, deliverable H (STATE.md Phase 4 Mission: "a physical-hardware
Tier-0 performance audit"). **This runbook is executed by the owner on real
Intel N100 hardware** — nothing in Phase 4's CI or dev environment can
substitute for it (T0-throttled CI containers approximate CPU/RAM limits;
they cannot approximate a real QSV media engine, a real spinning HDD, or 30
minutes of sustained real silicon). This document plus
`scripts/t0-audit/**` make that execution turnkey and its pass/fail
criteria mechanical; **you still have to physically run it.**

Authoritative budgets: docs/PLAN.md §9 ("Performance engineering — budget
hardware as a contract"), specifically §9.1 (hardware tiers), §9.2 (server
budgets), §9.3 (web client budgets). STATE.md D15/P2.6 record the T0 perf
harness this runbook builds on (`scripts/perf-t0.mjs`, already
CI-enforcing since Phase 2). Nothing in this runbook changes those budgets
— it only measures against them on the reference hardware plan §9.1 names.

**Every number that ends up in `reports/t0-audit.md` must come from
actually running the commands below.** No measurement is estimated,
extrapolated from CI, or copied from a different machine. Where a script
cannot determine something safely (e.g. whether `--hdd-tmp-dir` is really
HDD-backed), it says so explicitly rather than guessing.

---

## 0. How this runbook is organized

| Step | What | Script(s) |
|---|---|---|
| A | Provision — full install, embedded PostgreSQL, from scratch | `installers/linux/build-tarball.mjs`, `install.sh`, `scripts/t0-audit/preflight.mjs` |
| B | Libraries — synthetic 50k seed + real-file scan corpus + your real media | `pnpm db:seed-large`, real scan via the admin UI/API |
| C | §9.2 measurement battery — idle RSS, p95 @ 50k, cold start, scan throughput | `rss-sample.mjs`, `run-perf-t0.mjs`, `cold-start.mjs` |
| D | **Headline test** — two simultaneous 1080p hardware transcodes, sustained 30 min | `dual-transcode.mjs`, `sustained-monitor.mjs` |
| E | §9.3 web budgets, verified on the N100's own hardware | `pnpm perf:web-budget`, `pnpm perf:lighthouse` |
| F | Assemble `reports/t0-audit.md` | `collect-report.mjs` |

Every step is also runnable end-to-end via `scripts/t0-audit/run-all.sh`
(§8 below) once you've done Step A by hand once. Read Step A and Step D in
full before running the orchestrator, though — both have gotchas that will
silently produce a misleading result if skipped.

**Ports**: this runbook targets the N100's normal ports (3001 for the
server, 5433 for embedded PG — see Step A). If you ever smoke-test any of
these scripts against a throwaway local instance instead of the real
target, use ports 4100–4199 (this lane's assigned local range) so you
don't collide with anything else running.

---

## 1. Prerequisites

- A physical Intel N100 box (or Pi-5-class ARM — the plan treats them as
  the same T0 tier; this runbook's commands are written for the N100/Linux
  x86_64 case, called out where arm64 differs).
- A Linux distribution with `systemd` as PID 1, `sudo`/root access,
  `sha256sum`, `pgrep`, `ps`, `dmesg` (root-readable —
  `sysctl kernel.dmesg_restrict=0` or run as root, see §9 Troubleshooting).
- Intel Media Driver + oneVPL/libmfx runtime packages for QSV (e.g. on
  Debian/Ubuntu: `intel-media-va-driver-non-free`, `libmfx1` or `libvpl2`
  depending on your distro's packaging generation) — the bundled ffmpeg
  supports QSV by dynamically loading these at runtime; it does **not**
  bundle them itself (see `installers/ffmpeg-manifest.json`'s
  `linux-x64.licenseNote`: only vaapi/nvenc/vdpau/OpenCL are dlopen'd
  hw-accel deps it lists explicitly — confirm QSV works for your kernel/
  driver combination with `vainfo` before proceeding).
- **Two things on this N100, not one**: (1) the installed tarball at
  `/opt/loombre` (Step A) — the actual system under test — and (2) a full
  **source checkout** with `pnpm install` already run, used to invoke
  `pnpm perf:t0` / `pnpm perf:web-budget` / `pnpm perf:lighthouse` /
  `pnpm --filter @loombre/worker run hwprobe` (these are dev-toolchain
  commands; the packaged tarball intentionally ships no dev toolchain —
  see `installers/linux/LAYOUT.md`'s "Why `pnpm deploy` alone is not
  enough" section). Node 24 + pnpm (`.nvmrc`/`packageManager` pin) on the
  checkout side.
- At least two real 1080p+ media files somewhere you can point a Loombre
  library at, each with a **runtime ≥ the sustained-test duration**
  (default 30 minutes — an ordinary movie clears this easily; a short clip
  will hit EOF and end the session before the window completes, which is
  a setup mistake, not a budget failure).
- A real HDD (not the boot SSD, not tmpfs) reachable as a directory on this
  host, for Step C's scan-throughput measurement.

---

## 2. Step A — Provision from scratch (embedded PostgreSQL, NOT external)

The mission requires embedded PostgreSQL (lane B) specifically — this is
the packaging path public installs actually ship, and it's the one with a
real "cold start includes provisioning" story worth measuring. The
external-PG path (`docs/ops/external-postgres.md`) is equally
first-class per D1, but it is **not** what this audit measures.

### A.1 Build the tarball

From the **source checkout**, on the N100 (cross-building from macOS/CI is
fine for a release, but building natively here guarantees the vendored
`sharp`/`@img/sharp-*` native binaries and the embedded-PG payload
actually match this host):

```sh
cd /path/to/loombre-checkout
node installers/linux/build-tarball.mjs --arch x64
# arm64 host (Pi-5-class T0): --arch arm64
```

This runs `scripts/fetch-embedded-pg.mjs` and `scripts/fetch-ffmpeg.mjs`
automatically (see `installers/linux/LAYOUT.md`'s "Where things come
from" table) — first run will download both; expect several minutes.
Output: `installers/linux/.build/stage/loombre-<version>-linux-x64/`
(and the packaged `.tar.gz` next to it — see the script's own final log
line for the exact path).

### A.2 Install

```sh
cd installers/linux/.build/stage/loombre-<version>-linux-x64
sudo ./install.sh
```

Default layout: app at `/opt/loombre`, data at `/var/lib/loombre`, config at
`/etc/loombre/loombre.env`, system user `loombre` — see
`docs/install/linux.md` for the full walkthrough and
`installers/linux/LAYOUT.md` for exactly what's inside. Don't pass
`--no-systemd` — this audit needs the real systemd units (`rss-sample.mjs`/
`cold-start.mjs` read `systemctl show`).

### A.3 QSV pre-flight — `loombre` user device access

`install.sh` creates the `loombre` system user via a bare `useradd
--system` (no supplementary groups). QSV needs `/dev/dri` render-node
access:

```sh
sudo usermod -aG render,video loombre
```

(Some distros only need one of the two groups; adding both is harmless.)
You'll re-verify this in A.8 below — don't skip ahead and assume it
worked.

### A.4 Configure `/etc/loombre/loombre.env`

Edit the file `install.sh` generated. Two changes, both required for this
audit specifically:

```sh
# Leave DATABASE_URL commented out/absent — embedded PG activates when
# it's unset (apps/server/src/bootstrap/provisioning.ts). Setting it here
# would put this instance in EXTERNAL-PG mode, which this audit does not
# measure.

# REQUIRED — packaging gap (STATE.md Phase 4 Open item: "Installer
# packaging must set LOOMBRE_EMBEDDED_PG_VENDOR_DIR" — the wrapper scripts
# do not do this yet, so it must be set by hand here):
LOOMBRE_EMBEDDED_PG_VENDOR_DIR=/opt/loombre/pg

# Strongly recommended (avoids the ephemeral-JWT-secret restart-logs-
# everyone-out footgun — P4.17):
LOOMBRE_JWT_SECRET=<output of: openssl rand -base64 48>

# Set this NOW, ahead of Step D, so you don't have to remember to come
# back — the tier-0 DEFAULT is 1 simultaneous transcode
# (apps/server/src/playback/resolve-policy.ts TIER_DEFAULT_MAX_TRANSCODES),
# which would 429 the headline test's second session. Setting it here
# means one clean provision -> boot -> audit run, not a restart mid-way:
LOOMBRE_MAX_TRANSCODES=2
```

If `/opt/loombre/pg` doesn't exist or is empty, `build-tarball.mjs`'s
`fetch-embedded-pg.mjs` step didn't produce a payload for this arch (check
its console output from A.1) — you cannot proceed with embedded PG until
that's fixed; do not fall back to external PG for this audit (it changes
what's being measured).

### A.5 Start + verify

```sh
sudo systemctl start loombre-server loombre-worker
sudo systemctl status loombre-server loombre-worker
curl http://127.0.0.1:3001/healthz
```

First start does real `initdb` + a fresh `postgres` boot inside
`bootstrapProvisioning()` before Nest ever constructs anything — expect
this first `/healthz` to take longer than the steady-state cold-start
budget measures later (that's expected and is exactly why
`scripts/t0-audit/cold-start.mjs` reports `firstBootMs` and
`steadyStateMs` as two different numbers — see Step C).

If it doesn't come up, `journalctl -u loombre-server -f` and
`docs/install/linux.md`'s Troubleshooting section (the `ECONNREFUSED`/
`ERR_MODULE_NOT_FOUND` entries there predate embedded PG but the same
triage order still applies).

### A.6 Bootstrap the database

Same documented path `docs/install/linux.md` step 4 already names for
external PG, pointed at the embedded instance instead. From the source
checkout, resolve the real `DATABASE_URL` (the superuser secret file
`bootstrapProvisioning()` writes):

```sh
cd /path/to/loombre-checkout
export DATABASE_URL="postgres://loombre:$(sudo cat /var/lib/loombre/postgres/superuser.secret)@127.0.0.1:5433/loombre"
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` creates the fixed seeded admin
(`admin` / `loombre-seed-admin`) every script in `scripts/t0-audit/**`
authenticates as by default. **This permanently disables the first-boot
setup wizard for this instance** (P4.10: the setup surface is inert once
any user exists) — expected and correct for this audit (the wizard itself
is a separate, already-covered Wave-3 item: "Install smokes ×3"), but
don't also try to click through onboarding on this same install afterward
expecting it to work.

### A.7 Verify hardware capabilities

Still from the checkout, pointed at the **bundled** ffmpeg (not any system
ffmpeg the checkout might otherwise resolve via `PATH` — this matters:
you want to probe the exact binary that will actually run transcodes):

```sh
export LOOMBRE_FFMPEG=/opt/loombre/ffmpeg/ffmpeg
export LOOMBRE_FFPROBE=/opt/loombre/ffmpeg/ffprobe
pnpm --filter @loombre/worker run hwprobe
```

Read the printed report. You are looking for a `qsv` (or whatever this
specific N100's working backend turns out to be) entry with at least one
`encode` codec (`h264`/`hevc`) — if every backend but `software` comes back
empty, STOP and fix the driver stack (`vainfo`, `usermod`, a reboot after
group changes) before continuing to Step D; the headline test cannot pass
without this.

Consider also producing `reports/hw-verify-linux.md` while you're here
(a per-backend capability table from the hwprobe output) — that's STATE.md
P3.4's still-open Linux hardware-verification checklist, adjacent to but
not part of this deliverable; doing it now while hwprobe is already fresh
in your terminal is convenient, not required by this runbook.

### A.8 Automated pre-flight check

```sh
node scripts/t0-audit/preflight.mjs
```

Confirms everything above mechanically: embedded-PG mode (not external),
`LOOMBRE_EMBEDDED_PG_VENDOR_DIR` set and non-empty, the superuser secret
exists, `loombre`'s group membership, `/dev/dri` presence, the server unit
is active, login succeeds, and the capability report has a working
non-software encoder. Fix everything it flags as a problem before
continuing — this script exists specifically so Step D doesn't waste 30
minutes discovering a setup mistake at minute 29.

---

## 3. Step B — Libraries: which corpus for which measurement

Two different synthetic generators already exist in this repo, and they
answer two different questions — using the wrong one for a given
measurement would produce a technically-real-but-meaningless number:

| Generator | What it produces | Faithful for |
|---|---|---|
| `pnpm db:seed-large` (`packages/db/seed/seed-large.mjs`) | 50,000 `catalog_items` rows inserted **directly into Postgres** — no files on disk, no scanner involvement | §9.2's p95-latency-@-50k-items budgets (rows 3–6 in the report) — these measure query/API latency against a large catalog, which needs a large catalog to exist, not a large set of real files to scan |
| `scripts/perf-t0.mjs`'s own `buildFakeMovieFiles` (internal to its `scanThroughput` measurement — the same technique `scripts/scan-smoke.mjs` uses for its own, separate correctness test) | 500 real files, real bytes, real directory tree, actually walked + hashed + probed by the real scanner | §9.2's scan-throughput-on-HDD budget (row 8) — this measures disk + scanner I/O, which needs real file-system traffic, not database rows |

**Neither one substitutes for the other.** Running `db:seed-large` alone
would leave the scan-throughput budget unmeasured (no files exist to
scan); running only the file generator would leave the 50k-item p95
budgets unmeasured (the catalog is 500 items, not 50k, and query planner
behavior at those two scales is not the same thing).

### B.1 The 50k seed (for Step C's p95 budgets)

```sh
export DATABASE_URL="postgres://loombre:$(sudo cat /var/lib/loombre/postgres/superuser.secret)@127.0.0.1:5433/loombre"
pnpm db:seed-large
```

Safe to re-run (replaces its own "Large Library" library each time —
`seed-large.mjs`'s own header). Requires `pnpm db:seed` (A.6) to have
already run.

### B.2 The real-file scan-throughput corpus (for Step C's scan budget)

You don't run this generator directly — `scripts/t0-audit/run-perf-t0.mjs`
invokes `scripts/perf-t0.mjs`, which generates and scans its own 500-file
library as part of the same run (see that script's own `measureScanThroughput`
for exactly what it writes: 500 directories, 1–9 MiB pseudo-random content
each, deterministic PRNG). The only thing **you** control here is *where*
it writes that library — by default, `os.tmpdir()`, which is very likely
**not** your HDD (see Step C.2's `--hdd-tmp-dir` flag; this is the single
most important gotcha in the whole §9.2 measurement battery).

### B.3 Your real library subset

Log into the web client as `admin` / `loombre-seed-admin`
(`http://<n100 IP>:3001`), or use the API directly:

```sh
TOKEN=$(curl -s http://127.0.0.1:3001/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"loombre-seed-admin","deviceName":"t0-audit-manual","deviceProfile":{"profileId":"manual","directPlayContainers":["mp4","mkv"],"hls":{"container":"fmp4","supportsFmp4":true,"lowLatency":false},"video":[{"codec":"h264","maxProfile":null,"maxLevel":null,"maxBitDepth":8,"maxWidth":1920,"maxHeight":1080,"maxFrameRate":60,"maxBitrateBps":20000000}],"hdr":{"hdr10":false,"hlg":false,"dolbyVision":false},"audio":[{"codec":"aac","maxChannels":2,"passthrough":false}],"subtitles":{"renderText":["subrip"],"hlsVtt":true,"renderImage":false},"maxStreamBitrateBps":null}}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken')

curl -s http://127.0.0.1:3001/libraries -H "Authorization: Bearer ${TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"name":"T0 Audit Real Media","mediaKind":"movie","paths":["/mnt/media"]}'
# note the returned "id", then:
curl -s -X POST "http://127.0.0.1:3001/libraries/<id>/scan" -H "Authorization: Bearer ${TOKEN}"
```

Make sure `/mnt/media` (or wherever) is readable by the `loombre` user —
`docs/install/linux.md`'s "Permission errors reading library folders"
section covers `chown`/`chmod` for bind-mounted/network paths. Confirm the
scan completed (`GET /admin/...` jobs view, or just wait and check
`GET /movies` returns items) before Step D — `dual-transcode.mjs` needs at
least two 1080p+ items to auto-pick from (or pass `--item-a`/`--item-b`
explicitly once you know their ids).

---

## 4. Step C — §9.2 measurement battery

| Budget (docs/PLAN.md §9.2) | Command | Threshold | What it needs from Step B |
|---|---|---|---|
| Server idle RSS | `node scripts/t0-audit/rss-sample.mjs --label idle` | ≤ 220 MiB | nothing |
| Stack idle RSS (server+worker+embedded PG) | same run | ≤ 500 MiB | nothing |
| p95 browse page | `node scripts/t0-audit/run-perf-t0.mjs --repo-checkout <checkout> --hdd-tmp-dir <hdd path>` | ≤ 100 ms | B.1 (50k seed) |
| p95 item detail | same run | ≤ 100 ms | B.1 |
| p95 continue-watching | same run | ≤ 100 ms | B.1 |
| p95 search-as-you-type | same run | ≤ 100 ms | B.1 |
| Cold start (steady-state) | `node scripts/t0-audit/cold-start.mjs --runs 3` | ≤ 5 s | nothing (data dir must already be provisioned — run after A.5) |
| Scan throughput on HDD | same `run-perf-t0.mjs` run | ≥ 200 files/min | B.2 (generated automatically, but see the `--hdd-tmp-dir` note below) |

### C.1 Idle RSS

```sh
sudo node scripts/t0-audit/rss-sample.mjs --label idle --results-dir ./t0-audit-results
```

(`sudo` because it reads `ps`/`systemctl` state for the `loombre`-owned
server/worker/postgres processes.) Run this with the stack freshly started
and otherwise idle — no scans, no active playback sessions, no `curl`
loops from another terminal. It samples once and writes
`t0-audit-results/rss-sample.idle.json`.

### C.2 p95 latency + scan throughput

**Before running this**, confirm your `--hdd-tmp-dir` argument actually
resolves to spinning-disk storage, not the boot SSD or a tmpfs mount:

```sh
mkdir -p /mnt/media-hdd/loombre-perf-tmp
findmnt /mnt/media-hdd    # confirm the filesystem/device is really the HDD
```

Then:

```sh
node scripts/t0-audit/run-perf-t0.mjs \
  --repo-checkout /path/to/loombre-checkout \
  --hdd-tmp-dir /mnt/media-hdd/loombre-perf-tmp \
  --results-dir ./t0-audit-results
```

This wraps the existing, already-CI-enforcing `scripts/perf-t0.mjs`
unmodified — read `run-perf-t0.mjs`'s own header comment for exactly what
"against the real install" means here (short version: real embedded-PG
database + real hardware, but the SERVER PROCESS perf-t0.mjs measures p95
against is one it boots itself from the checkout, not the packaged
`loombre-server.service` — that's why idle RSS is measured separately in
C.1 against the real systemd units instead of trusting perf-t0's own idle-
RSS figure). Takes several minutes (500-file scan + 50k-row cursor walk +
800 warmed-up HTTP samples across four endpoints). Exits nonzero if
`perf-t0.mjs` itself reports a hard-enforced budget breach — the exact
same breach list it already prints in CI.

### C.3 Cold start

```sh
sudo node scripts/t0-audit/cold-start.mjs --runs 3 --results-dir ./t0-audit-results
```

Stops and restarts `loombre-server.service` up to 3 times, timing
stop→start→first-healthy-`/healthz`. The **first** run against a
freshly-provisioned data dir (i.e. your very first invocation after A.5)
includes one-time `initdb` cost and is reported separately
(`firstBootMs`, informational) — only the steady-state samples count
against the ≤5s budget. Run `--runs 2` minimum so at least one
steady-state sample exists even on that very first invocation.

---

## 5. Step D — HEADLINE TEST: two simultaneous 1080p hardware transcodes, sustained 30 minutes

This is the test docs/PLAN.md §9.1 actually names as T0's defining
commitment ("≥ 2 simultaneous 1080p hw transcodes"), and the one every
other budget in this runbook is secondary to. Read all of D.1 before
running D.2 — skipping the pre-flight config produces a 429, not a useful
result.

### D.1 Pre-flight — the tier-0 default WILL block this test

`apps/server/src/playback/resolve-policy.ts`'s tier-0 default
`maxSimultaneousTranscodes` is **1**, not 2 — it is not auto-detected from
CPU/RAM (only scan concurrency is; transcode concurrency is a flat,
deliberately-conservative per-tier default, overridable). If you set
`LOOMBRE_MAX_TRANSCODES=2` in Step A.4 already, you're done — verify with:

```sh
grep LOOMBRE_MAX_TRANSCODES /etc/loombre/loombre.env
```

If not, set it now and restart:

```sh
echo 'LOOMBRE_MAX_TRANSCODES=2' | sudo tee -a /etc/loombre/loombre.env
sudo systemctl restart loombre-server
```

This is expected/by-design (T0's conservative default protects small
installs from over-committing by accident), not a bug — `dual-transcode.mjs`
gives you this exact same explanation if you forget and hit the 429 anyway.

### D.2 Start both sessions

```sh
node scripts/t0-audit/dual-transcode.mjs \
  --library-name "T0 Audit Real Media" \
  --results-dir ./t0-audit-results
```

(Omit `--library-name` to search across every library the seeded admin can
see; pass `--item-a <uuid> --item-b <uuid>` instead if you already know
which two items you want.) This script:

1. Logs in, force-picks (or accepts your explicit) two real 1080p+ items.
2. Calls the **read-only** `POST /playback/plan` preview for each and
   REFUSES to proceed unless `decision === 'transcode'` **and** the plan
   carries `hw-encoder-selected:<backend>` with `backend !== 'software'`
   — i.e. it proves hardware routing before spending a real session.
3. Calls `POST /playback/sessions` for real, for both items.
4. Writes `t0-audit-results/dual-transcode.json` (session ids, manifest
   URLs, confirmed backend, and — needed by the next step — the access/
   refresh token pair).

If it fails with a "SOFTWARE fallback" error, hwprobe (A.7) didn't find a
working hardware encoder, or the `loombre` user still can't reach
`/dev/dri` — go back to A.3/A.7, don't proceed with a software-routed
"headline" test (it would not be testing what §9.1 actually commits to).

### D.3 Watch it for 30 minutes

```sh
DATABASE_URL="postgres://loombre:$(sudo cat /var/lib/loombre/postgres/superuser.secret)@127.0.0.1:5433/loombre"
sudo node scripts/t0-audit/sustained-monitor.mjs \
  --database-url "${DATABASE_URL}" \
  --duration-min 30 \
  --results-dir ./t0-audit-results
```

`--database-url` is optional but strongly recommended (it's what lets the
monitor read `suspended_by_throttle`/`produced_segment` straight from the
`playback_sessions` row via the same guarded `@loombre/db` query layer
`apps/server`'s own controllers use, rather than only inferring progress
from the HLS manifest) — `sudo` because RSS sampling reads
`systemctl`/`/proc/<pid>/cwd` for the real server/worker/postgres/ffmpeg
processes.

**Pacing**: this script deliberately consumes exactly one new HLS segment
per session every 6 seconds (matching `resolve-policy.ts`'s
`segmentDurationSec`) — i.e. it behaves like a real video player watching
in real time, not a script racing to drain the stream as fast as
possible. This is *why* the test takes the full 30 minutes and *why* your
source items need ≥30 minutes of real runtime (§1 Prerequisites) — ffmpeg
itself is not rate-limited by the transcode runner; docs/PLAYBACK.md §9's
throttle-suspend-at-ahead>10 mechanism exists precisely because ffmpeg
would otherwise blast through the whole file in well under a minute and
then sit idle, which would not exercise "sustained" anything.

While it runs, it logs a line every 5 seconds (server/worker/embedded-PG
RSS, per-session produced-segment index, per-session ffmpeg RSS, hottest
thermal zone) so you can watch it live instead of waiting blind.

### D.4 Pass criteria

`sustained-monitor.mjs` computes a **mechanical** `overallPass` from
exactly these checks (no judgment calls):

- both sessions' plans confirmed a non-`software` `hw-encoder-selected`
  backend (checked in D.2, re-asserted in the final report by
  `collect-report.mjs`);
- no segment-index gap was ever observed in either session's consumed
  sequence (a gap = a dropped/missed segment);
- neither session's `status` was ever observed as `failed`;
- neither session ever needed more than one run directory (a second run
  dir would mean an unexpected seek/restart occurred — this test never
  seeks);
- zero new `dmesg` thermal/throttle lines appeared during the window
  (when `dmesg` was readable at all — see §9 Troubleshooting if it
  wasn't).

**One thing it does NOT auto-fail on, by design**: sustained ffmpeg RSS
growth. docs/PLAN.md §9 gives no numeric ceiling for RSS growth *during* a
transcode (only the *idle* RSS budgets in §9.2, which this test doesn't
touch — no session is idle). `sustained-monitor.mjs` reports the
first→last RSS trend per session honestly and asks **you** to read it and
decide — that's the report template's explicit "owner judgment required"
row (§9.2 doesn't name a threshold; inventing one here would be exactly
the kind of fabricated-looking-precision this runbook is built to avoid).
A flat or slowly-growing-then-plateauing trend is expected and fine (codec
lookahead buffers, GOP structures); an unbounded, still-climbing-at-minute-
30 trend is a real finding — file it as a blocker, don't wave it through.

---

## 6. Step E — §9.3 web budgets, verified on the N100's real hardware

The enforcing CI job (`perf-web-budget`/`perf-lighthouse`, already
blocking since Phase 2 per STATE.md P2.6) already runs these on every
push. What this step adds is running the **exact same commands** on the
**N100's own CPU** — Lighthouse's throttled-profile score in particular is
sensitive to real single-core performance, and an N100 is meaningfully
weaker than a GitHub Actions runner.

```sh
cd /path/to/loombre-checkout
pnpm perf:web-budget
cp perf/web-budget-result.json ./t0-audit-results/web-budget-result.json

pnpm perf:lighthouse
# read the printed "categories:performance" score from LHCI's own summary
# table — pass it to collect-report.mjs in Step F (--lighthouse-score).
```

**Known, disclosed architecture gap** (not this lane's to close): nothing
currently serves the packaged tarball's `web/` output as part of an
installed deployment — STATE.md's Phase 4 Open list carries "Web-serving
architecture unresolved for installed deployments" verbatim (no
`output: standalone` in `next.config`, no static serving in
`apps/server`). Both commands above therefore build+serve `apps/web`
straight from the checkout (`pnpm run build && pnpm run start`, matching
what CI already does) — real N100 CPU, real thermal conditions, correctly
answering "does this app hit its web budgets on T0-class hardware," but
**not** "does the shipped installer's web output get served" (nothing
serves it yet, on any host). That second question stays exactly where
STATE.md already logs it — out of scope here, not silently declared fixed.

---

## 7. Step F — Assemble the report

```sh
node scripts/t0-audit/collect-report.mjs \
  --results-dir ./t0-audit-results \
  --lighthouse-score 0.94   # whatever Step E actually printed
```

Stamps every `MEASURE:<key>` placeholder in `reports/t0-audit.md` it has an
artifact for; anything missing stays a visible `MEASURE:...` placeholder
plus a console warning naming which script to (re-)run. Re-run this
collector as many times as you like as you fill in gaps — it always
re-derives verdicts from each source script's own breach/pass fields
rather than re-encoding the budget numbers a second time.

**What is never auto-filled** (by design, not oversight): the
"Environment" table's free-text fields (hardware SKU, OS, install method,
etc. — `FILL:` prefixed, not `MEASURE:` prefixed, in the template), owner
notes, and the budget-amendments/blockers-filed sections. Fill those by
hand, then read every `Verdict` cell and make the call this mission
mandates explicitly: **every FAIL becomes either a filed blocker or an
owner-signed budget amendment** — see the template's own "The rule"
section at the top of `reports/t0-audit.md`. Set `reviewed-by-owner:` at
the top of the file once you've done that.

---

## 8. Turnkey: `run-all.sh`

Once Step A is done by hand (it's genuinely one-time setup — build,
install, configure, verify hardware), Steps C–F can run unattended:

```sh
sudo scripts/t0-audit/run-all.sh \
  --repo-checkout /path/to/loombre-checkout \
  --hdd-tmp-dir /mnt/media-hdd/loombre-perf-tmp \
  --library-name "T0 Audit Real Media" \
  --duration-min 30 \
  --results-dir ./t0-audit-results
```

It stops and prints manual instructions at Step E (web budgets — the
Lighthouse score genuinely needs a human to read LHCI's own console
output; see Step 6's own reasoning for why this collector doesn't attempt
to parse LHCI's report format automatically), then finishes with
`collect-report.mjs`. Every step it runs is identical to running that
script directly — this is a sequencing convenience, not a different code
path.

---

## 9. Troubleshooting

- **`dmesg: permission denied` / empty output even though throttling might
  be happening**: many distros default `kernel.dmesg_restrict=1` (dmesg
  root-only). Run the sustained-monitor step under `sudo` (the runbook
  already says to) — if it's still empty, check
  `sysctl kernel.dmesg_restrict`. `sustained-monitor.mjs` reports this
  explicitly as "UNVERIFIED, not confirmed clean" rather than silently
  passing when it can't actually check.
- **`findFfmpegPidForSessionDir` never finds a pid /
  `headline_rss_trend_*` reads "no ffmpeg RSS samples captured"**: confirm
  you're running the monitor as root (or as the `loombre` user) —
  `/proc/<pid>/cwd` of another user's process needs one of those. Also
  confirm the session didn't fail immediately (`journalctl -u
  loombre-worker -f` during D.2/D.3).
- **`POST /playback/sessions` → 429 mid-run even after setting
  `LOOMBRE_MAX_TRANSCODES=2`**: confirm the restart in D.1 actually
  happened (`systemctl status loombre-server` shows a recent start time) —
  editing the env file alone doesn't reload a running process.
- **`hwprobe` reports every backend but `software`**: confirm `vainfo`
  (or `vainfo --display drm --device /dev/dri/renderD128`) shows your
  N100's iGPU and lists H.264/HEVC VAEntrypointEncSlice profiles outside
  Loombre entirely first — if the OS-level driver stack doesn't work,
  nothing above this runbook can fix it.
- **Scan throughput measures suspiciously fast even off a real HDD path**:
  double-check `--hdd-tmp-dir` with `findmnt` — a bind-mount or symlink
  that still resolves back onto the SSD/tmpfs is the most common mistake
  (§4 C.2).
- **Everything in this runbook up to Step A.6 works, but `pnpm db:seed`/
  `pnpm perf:t0`/etc. can't reach the database**: double check the
  `DATABASE_URL` you built from the secret file — the port is 5433
  (`EMBEDDED_PG_DEFAULT_PORT`, not 5432/5442), and the secret file needs
  `sudo` to read (0600, `loombre`-owned).

---

## 10. Verifying these scripts without an N100 (what this lane actually checked, and where)

None of this repo's CI/dev hosts (including the M3 Max this lane was
authored on) can run the hardware-dependent paths for real — no systemd
unit named `loombre-server`, no `/dev/dri`, no embedded-PG data directory
matching the real install layout, no QSV. What WAS verified locally,
without fabricating a hardware result:

- **Every script**: `node --check` clean (syntax only — see the repo-wide
  gate note in this doc's own commit for the exact command run).
- **`scripts/t0-audit/run-all.sh`**: `shellcheck` clean.
- **`scripts/t0-audit/lib/common.mjs`**: the platform-independent helpers
  (`parseArgs`, `readEnvFile`, `fmtMiB`, `readThermalZones`/
  `readCpuFreqSample`/`readDmesgThrottleLines` on a non-Linux host —
  confirmed they degrade to empty results/a clear "unavailable" marker
  rather than throwing) were exercised directly via `node -e` against real
  inputs.
- **`scripts/t0-audit/collect-report.mjs`**: exercised end-to-end against
  hand-built fixture JSON standing in for every other script's real
  output (`rss-sample.idle.json`, `run-perf-t0-summary.json`,
  `cold-start.json`, `dual-transcode.json`, `sustained-monitor.json`,
  `web-budget-result.json`) covering both an all-PASS run and a
  deliberate-breach run — confirmed every `MEASURE:` placeholder in a
  scratch copy of `reports/t0-audit.md` stamped correctly with the right
  value AND the right PASS/FAIL verdict in both cases, and that missing
  artifacts leave their placeholders untouched with a named warning
  instead of silently defaulting to PASS.
- **HLS manifest parsing / segment pacing math**
  (`sustained-monitor.mjs`'s internal `parseSegmentUris`/`segmentSortKey`):
  hand-verified against a real-shaped fixture playlist matching the
  contract's documented `runN/sNNNNNN.m4s` / `runN/init.mp4` naming.

**Not verifiable here, genuinely N100-only**: `rss-sample.mjs` and
`cold-start.mjs`'s `systemctl`/`ps` calls; `embeddedPgRssBytes`/
`findFfmpegPidForSessionDir`'s process discovery; the entire live HTTP
flow in `dual-transcode.mjs`/`sustained-monitor.mjs` (needs a real running
server + real hardware transcode); `preflight.mjs`'s group-membership and
capability-report checks; the actual §9.2/§9.1/§9.3 pass/fail outcomes
themselves. This is exactly why this document exists as an owner-run
runbook rather than a CI job — see the mission statement at the top of
this file.

---

## Appendix — full budget → command → threshold table

| Plan clause | Command | Threshold | Report row |
|---|---|---|---|
| §9.2 server idle RSS | `rss-sample.mjs` | ≤ 220 MiB | 1 |
| §9.2 stack idle RSS | `rss-sample.mjs` | ≤ 500 MiB | 2 |
| §9.2 p95 browse | `run-perf-t0.mjs` | ≤ 100 ms | 3 |
| §9.2 p95 item detail | `run-perf-t0.mjs` | ≤ 100 ms | 4 |
| §9.2 p95 continue-watching | `run-perf-t0.mjs` | ≤ 100 ms | 5 |
| §9.2 p95 search-as-you-type | `run-perf-t0.mjs` | ≤ 100 ms | 6 |
| §9.2 cold start | `cold-start.mjs` | ≤ 5 s | 7 |
| §9.2 scan throughput (HDD) | `run-perf-t0.mjs` | ≥ 200 files/min | 8 |
| §9.1 ≥2 simultaneous 1080p hw transcodes, sustained | `dual-transcode.mjs` + `sustained-monitor.mjs` | mechanical checks in §5 D.4 | headline table |
| §9.3 browse route JS (gz) | `pnpm perf:web-budget` | ≤ 200 KB | 9 |
| §9.3 Lighthouse (throttled) | `pnpm perf:lighthouse` | ≥ 90 | 10 |

## Cross-links

- `docs/install/linux.md` — the general installer walkthrough this
  runbook's Step A specializes for embedded PG + this audit's specific
  needs.
- `installers/linux/LAYOUT.md` — exact tarball contents/provenance.
- `docs/ops/systemd.md`, `docs/ops/external-postgres.md`,
  `docs/ops/backup.md` — adjacent ops docs (external-PG is the path this
  audit deliberately does NOT use; see Step A's opening note).
- `scripts/perf-t0.mjs` — the underlying, already-CI-enforcing T0 harness
  `run-perf-t0.mjs` wraps rather than replaces.
- `docs/PLAN.md` §9 — the budgets themselves (source of truth; this
  runbook never restates a number it doesn't also cite from there).
- `reports/t0-audit.md` — this runbook's output.
