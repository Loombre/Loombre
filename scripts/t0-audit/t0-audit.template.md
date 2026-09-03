# Loombre Tier-0 physical-hardware performance audit

**reviewed-by-owner: PENDING**

Phase 4 Wave 3, deliverable H (STATE.md Phase 4 Mission: "a physical-hardware
Tier-0 performance audit"). Budgets below are copied verbatim from
docs/PLAN.md §9.1/§9.2/§9.3 — this file is a TEMPLATE: every cell in the
**Measured** column is a blank the owner fills by actually running the
commands in `docs/ops/t0-audit-runbook.md` on the real N100. **No number in
this file is fabricated or estimated** — a cell reading `MEASURE:...` means
"not yet run," not "assumed passing." `scripts/t0-audit/collect-report.mjs`
fills these mechanically from the JSON each measurement script writes; only
the Lighthouse score and the free-text environment/notes fields are ever
hand-typed by the owner.

## The rule (mission-mandated, not optional)

> Every budget breach becomes either (a) a **blocker** — filed against the
> owning lane, Phase 4 does not close until it's fixed or re-measured green
> — or (b) an explicit **owner-signed budget amendment** recorded in this
> file's "Budget amendments" section below, with a stated reason. There is
> no third option ("looks close enough," "probably fine on real hardware")
> — the Verdict column is one of exactly `PASS`, `FAIL → BLOCKER`, or
> `FAIL → AMENDED (see below)`, decided by the owner after reading the
> measured number against the budget, never inferred by a script silently
> rounding in Loombre's favor.

---

## Environment

| Field | Value |
|---|---|
| Audit date | FILL:audit_date |
| Hardware | FILL:n100_hardware (exact SKU/RAM/storage — e.g. "Intel N100, 8GB DDR4, 256GB SATA SSD + 2TB 5400rpm HDD for media") |
| OS / kernel | FILL:n100_os |
| Loombre version | FILL:loombre_version (from `GET /system/info` or `VERSION` in the tarball) |
| Install method | FILL:install_method (tarball path per docs/install/linux.md; embedded PostgreSQL per lane B — NOT external) |
| ffmpeg build | FILL:ffmpeg_build (from the bundled `ffmpeg/ffmpeg -version`, or reports/hw-verify-linux.md if produced alongside this audit) |
| Hardware backend verified (hwprobe) | FILL:hw_backend (e.g. "qsv: decode h264/hevc PASS, encode h264/hevc PASS" — from `pnpm --filter @loombre/worker run hwprobe` / `GET /admin/capabilities`) |
| `loombre` service-user groups | FILL:loombre_groups (must include `render`/`video` for `/dev/dri` QSV access — runbook Step A) |

---

## §9.2 Server budgets (T0-throttled, 50k-item seed where noted)

| # | Budget (docs/PLAN.md §9.2) | Command | Threshold | Measured | Verdict |
|---|---|---|---|---|---|
| 1 | Server idle RSS | `scripts/t0-audit/rss-sample.mjs` | ≤ 220 MiB | MEASURE:idle_rss_server | MEASURE:idle_rss_server_verdict |
| 2 | Stack idle RSS (server+worker+embedded PG) | `scripts/t0-audit/rss-sample.mjs` (same run) | ≤ 500 MiB | MEASURE:idle_rss_stack | MEASURE:idle_rss_stack_verdict |
| 3 | p95 browse page @ 50k items | `scripts/t0-audit/run-perf-t0.mjs` (wraps `pnpm perf:t0`) | ≤ 100 ms | MEASURE:p95_browse | MEASURE:p95_browse_verdict |
| 4 | p95 item detail @ 50k items | same run | ≤ 100 ms | MEASURE:p95_item_detail | MEASURE:p95_item_detail_verdict |
| 5 | p95 continue-watching @ 50k items | same run | ≤ 100 ms | MEASURE:p95_continue_watching | MEASURE:p95_continue_watching_verdict |
| 6 | p95 search-as-you-type @ 50k items | same run | ≤ 100 ms | MEASURE:p95_search | MEASURE:p95_search_verdict |
| 7 | Cold start (steady-state, already-provisioned data dir) | `scripts/t0-audit/cold-start.mjs` | ≤ 5 s | MEASURE:cold_start | MEASURE:cold_start_verdict |
| 8 | Scan throughput on HDD | same `run-perf-t0.mjs` run, `--hdd-tmp-dir` on real HDD | ≥ 200 files/min | MEASURE:scan_throughput | MEASURE:scan_throughput_verdict |

Notes:
- Rows 3–6 and 8 come from ONE `scripts/t0-audit/run-perf-t0.mjs` invocation
  (it wraps the existing, already-enforcing `scripts/perf-t0.mjs`) — see the
  runbook's Step C for exactly how DATABASE_URL is pointed at the real
  embedded-PG install and TMPDIR at real HDD storage.
- Row 8's HDD-ness depends on `--hdd-tmp-dir` actually resolving to
  HDD-backed storage — confirm with `findmnt <path>` before trusting this
  number; the collector cannot verify this for you (see the runbook).
- Rows 1–2's "server" and "worker" are the REAL `loombre-server.service` /
  `loombre-worker.service` systemd units, not `perf-t0.mjs`'s own
  self-spawned instance (that script boots a separate process from a
  source checkout for the p95/scan measurements above — see
  `run-perf-t0.mjs`'s header for exactly why that's still a faithful
  database/hardware measurement despite not being the packaged binary).

## §9.1 Headline test — two simultaneous 1080p hardware transcodes, sustained 30 minutes

| Field | Measured | Note |
|---|---|---|
| Item A — title / resolution / source codec | MEASURE:headline_item_a | |
| Item A — hardware backend confirmed (`hw-encoder-selected:<backend>`) | MEASURE:headline_backend_a | Must NOT be `software` |
| Item A — segments consumed over the window | MEASURE:headline_segments_a | |
| Item A — segment gap detected | MEASURE:headline_gap_a | Any `true` here is an automatic FAIL |
| Item A — ffmpeg RSS start → end (trend) | MEASURE:headline_rss_trend_a | No numeric budget in §9 — owner judgment, see below |
| Item B — title / resolution / source codec | MEASURE:headline_item_b | |
| Item B — hardware backend confirmed | MEASURE:headline_backend_b | Must NOT be `software` |
| Item B — segments consumed over the window | MEASURE:headline_segments_b | |
| Item B — segment gap detected | MEASURE:headline_gap_b | Any `true` here is an automatic FAIL |
| Item B — ffmpeg RSS start → end (trend) | MEASURE:headline_rss_trend_b | No numeric budget in §9 — owner judgment, see below |
| New dmesg thermal/throttle lines during the window | MEASURE:headline_thermal | Any line here is an automatic FAIL when dmesg was readable |
| `scripts/t0-audit/sustained-monitor.mjs` mechanical verdict | MEASURE:headline_mechanical_verdict | `overallPass` from its JSON output |
| **Headline test verdict** | | MEASURE:headline_verdict |

**Owner judgment required on the RSS-growth trend**: docs/PLAN.md §9 states
no numeric sustained-transcode RSS-growth ceiling (it names the idle-RSS
budgets in §9.2 and the "≥2 simultaneous 1080p hw transcodes" capability
commitment in §9.1, not a growth-rate figure under sustained load). This is
a genuine, disclosed gap between the mission's ask ("flags throttling") and
what the spec gives a mechanical threshold for — `sustained-monitor.mjs`
reports the trend honestly and does NOT invent a pass/fail number for it.
Read `t0-audit-results/sustained-monitor.json`'s `sessions[].ffmpegRss`
figures and either accept them as stable-enough (note why below) or file a
blocker if the growth looks unbounded/leak-shaped.

## §9.3 Web client budgets (verified on the N100 itself — real CPU, not a CI runner)

| # | Budget (docs/PLAN.md §9.3) | Command | Threshold | Measured | Verdict |
|---|---|---|---|---|---|
| 9 | Browse route JS, gzipped | `pnpm perf:web-budget` (from a repo checkout, on the N100) | ≤ 200 KB | MEASURE:web_bundle | MEASURE:web_bundle_verdict |
| 10 | Lighthouse performance (throttled) | `pnpm perf:lighthouse` (from a repo checkout, on the N100) | ≥ 90 | MEASURE:web_lighthouse | MEASURE:web_lighthouse_verdict |

**Scope note (updated — the "known architecture gap" this paragraph used
to disclose is CLOSED)**: the packaged web output is now served on every
installed channel (`output: "standalone"` in `apps/web/next.config.mjs`;
Linux's `loombre-web.service`, Docker's `web` container, Windows'
`LoombreWeb` service, macOS's `com.loombre.web` daemon) — see
docs/ops/t0-audit-runbook.md §6's matching scope note. Rows 9–10 are
still run from a full source checkout **on the N100's own hardware**
(`pnpm run build && pnpm run start`, real CPU/thermal conditions, real
N100), because their question is "does this app hit its web budgets on
T0-class hardware" — not "is the installed web service serving," which
the runbook's Step A install smoke already answers.

---

## Owner notes

FILL:owner_notes (free text — anything the tables above don't capture:
surprises, hardware quirks, deviations from the runbook, why a measurement
was re-run, etc.)

## Budget amendments

FILL:budget_amendments (owner-signed only — format: `<row #> — <old budget>
→ <new budget> — reason — signed <name/date>`. Leave "none" if every row
above is either PASS or a filed blocker instead.)

## Blockers filed

FILL:blockers_filed (owner-signed only — format: `<row #> — <issue/PR
reference> — <one-line summary>`. Leave "none" if every FAIL row above got
a budget amendment instead.)
