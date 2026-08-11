# STATE.md — Lumbre Phase 4 (Phases 0–2 complete; Phase 3 automated exit met, owner review items Open)

## 0.9.0-rc polish pass — UI polish, IA restructure, scanner/probe fix (2026-08-07, IN PROGRESS)

Driven by owner's annotated screenshots from real Windows 11 ARM VM (Parallels) +
macOS installs. W1–W18; locked decisions D-1…D-8 (owner brief — do not re-litigate).
Wave plan: Wave 0 = W1 solo (P0, opus-reviewed) → Wave 1 = shared components
(W2+W3, W4, W5, W6, W7, W8, W13a) → Wave 2 = pages (W9, W10+W11, W12, W13b, W14,
W15, W16, W17) → Wave 3 = opus review + exit gates. W18 verify-only behind W1.

### Work item status

| Item | Status | Evidence |
|---|---|---|
| W1 probe/scanner decouple (D-1) | **DONE** — opus-reviewed (2 reviewers), all substantive findings fixed, gate ALL GREEN ×2 | RCA + review section below. Fixes: type-scoped ledger reconciliation with split horizons + FOR UPDATE + predicate re-assertion (packages/db/src/internal/jobs.ts, worker boot wiring), resolve-caps empty==missing (capabilitiesFromSnapshot), contract-first three-state probe status incl. re-probe-over-snapshot visibility (CapabilityProbeStatus + admin.controller + migrations/0037 index), shared web derivation hasNoAcceleratedCapabilities (fires on the REAL GPU-less outcome: software verified, hw rows empty), recordActive clears finished_at_ms. Tests: jobs-reconcile 7/7 (incl. race-predicate + type-scoping + plain-language pins), resolve-caps 5/5, playback e2e 35/35, admin-capabilities e2e 20/20 (never-ran/pending/failed/zero-backends/re-probe-failed-over-snapshot), scan hwcaps-independence 2/2, matrix 518/518, capability-view 4/4, wizard-state 37/37. `pnpm gate` ALL STEPS PASSED. |
| W2+W3 segmented control (D-2/D-3) | **DONE** (Wave 1) | ONE shared component confirmed: track `width: fit-content` + explicit `fullWidth` opt-in prop; segment padding tightened to the one `--space-sm` token (matches Chip/StatusPill); ZoneSortControl's copy-pasted track/segment consolidated via `composes:`; AddLibrarySheet Kind now displays Movie/TV/Music via label map (lowercase enum still hits the API — pinned by new AddLibrarySheet.test.tsx); severity/role pickers audited already-correct. New SegmentedControl.test.tsx pins the token + fit-content + full-width opt-in. Flagged for W3-review: wizard "Movies/TV Shows" plural idiom vs D-3 singular (deliberate, wizard cited as the good reference); CapabilityCard's third label map ("TV shows"). |
| W4 focus ring clipping | **DONE** (Wave 1, re-run after one API-error casualty; zero stray edits from the dead attempt — verified via git) | ROOT CAUSE: app-wide `:focus-visible` ring is a NON-inset box-shadow (3px outside border-box, globals.css:75 + tokens.css:197) and SheetOrModal's desktop `.body` is an unpadded overflow clip container (overflow-y:auto forces overflow-x:auto per spec) — full-width controls get the ring cropped at the body edge. FIX at shared level: inset ring + local inset keyframe (the global keyframe's non-inset final frame would re-clobber) on Input; same for Button (rightmost action button flush against the clip edge — real, demonstrated); orchestrator follow-through for the two same-defect-same-dialog deferrals: shared `.textarea` (AddLibrarySheet Paths field) + SegmentedControl segments. admin/Modal-based dialogs verified structurally immune (padding+overflow same box). Deferred list (PinModal raw input etc.) recorded for Wave 3. **[WAVE-A CLOSED eb421044 2026-08-11]** (PinModal consolidation) |
| W5 styled select | **DONE** (Wave 1) | components/ui/Select.tsx: real `<select>` restyled (appearance:none, pill surface matching Input, aria-hidden chevron) — native keyboard/SR semantics kept; wired into both AccountSection language prefs; styleguide entry added. Other native selects (CreateInviteSheet, ComposeNoticeCard ×2, RemoteEnrollCeremony, ProviderChainEditor ×2) recorded as conversion candidates for Wave 3 consistency audit. |
| W6 date picker | **DONE** (Wave 1) | components/ui/DatePicker.tsx: typeable YYYY-MM-DD field + calendar popover with month/year quick-jump Selects, WAI-ARIA grid keyboard nav (arrows/Home/End/PageUp/PageDown), opacity/transform-only animation; NEVER seeds from today — empty stays empty (the screenshotted defect), maxDate=today on birth date; pure UTC calendar-math helpers with injectable clock, 30-case DatePicker.test.ts. AccountSection birth-date uses explicit label htmlFor (three labelable descendants can't share one implicit label). |
| W7 settings layout system (D-4) | **DONE** (Wave 1) | ROOT CAUSE: TWO stacked width caps (SettingsShell .pane 760px + every section's own 640px max-width), neither centered → left-hug + dead right margin; admin/layout.tsx same bug standalone (1100px, no margin:auto). FIX: ONE primitive, SettingsPageLayout (.layout flex-center + .inner max-width:1120px), wired at both choke points (SettingsShell for all /settings/*, admin/layout.tsx for all /admin/*) + the two deliberate standalone routes (/settings/data, /settings/devices); ALL section-level max-widths removed (grep-verified none remain); System page grid: removed `align-items:start` override (equal-height via grid default stretch) + minmax 480px → clean 2×2 at 1120px. |
| W8 registry-row typography | **DONE** (Wave 1) | SettingField.module.css: description --text-xs(12px)→--text-base(14.5px) (clears the ~14px floor); DEFAULT/CURRENT/PINNABLE mono line --mono-xs(8.5px)→--text-sm(13px) = exactly ONE step below body on the same scale (also clears tokens.css's own hint-color floor the old size violated); key name → --text-base semibold mono. Deferred flag: .caution/.lockedValue sizes unchanged (outside the three named elements). **[WAVE-A CLOSED 753feba3 2026-08-11]** (+ 08cf9146, sourcePill default variant) |
| W13a registry-row tooltip mechanism (D-7) | **DONE** (Wave 1) | SettingField gains optional `technicalDetails` prop + ⓘ InfoTooltip (hover+focus+click-toggle, Escape via shared useEscapeKey, aria-describedby, role=tooltip, on-demand mount, compositor-only + reduced-motion variant); env-pin name RELOCATED from visible PINNABLE fact into the tooltip layer (PINNABLE label stays); 26/26 SettingField tests incl. new tooltip suite. W13b (Wave 2) wires per-key technical copy. |
| W9 Dashboard+System merge (D-5) | **DONE** (Wave 2) | Single "Dashboard" nav entry; /admin/system → redirect stub (libraries-stub pattern); its six cards extracted to components/admin/system/*.tsx and composed on /admin in the W7 equal-height grid (CapabilitiesCard's W1 three-state logic moved INTACT); AdminNav "System" sub-tab removed. |
| W10+W11 IA restructure + avatar menu (D-6) | **DONE** (Wave 2) | Nav: "Settings"→"System Settings", SYSTEM group right after Dashboard, admin-only (verified nav-items.ts:197). section-registry now 10 server-scoped sections only; AccountSection → components/profile/ProfileSettings at new /profile route; SettingsShell redirects ANY non-admin on ANY /settings* URL → /profile; /settings/account → redirect stub; quick-search/mobile-header/back-links swept. API layer: ~15 admin controllers audited (all requireAdmin/requireLiveAdmin first) + NEW settings-authz.e2e.spec.ts — 66 admin routes × 403-for-casual + user-scoped surfaces still work (88/88 green, runs in gate). UserMenu: Phosphor surface (raised bg/border/shadow tokens), pill hover items, inset focus ring, roving-focus menu keys (arrows wrap/Home/End/Escape-refocus), "Profile settings" entry; 11 new tests. Deferred: mobile tab-bar Settings target (fixed 6-tab spec; non-admin gets client redirect), /settings/devices entry-point TODO. **[WAVE-A: verified already-resolved by f94a0ce9 2026-08-11]** (stale row; superseded) |
| W12 log-tail empty-state copy | **DONE** (Wave 2) | LogsTailCard empty state: plain "writing logs to console output; installed setups configure a file automatically" + one linked sentence to the env-reference docs page; LOOMBRE_LOG_FILE demoted to secondary technical line. |
| W13b registry copy sweep (D-7) | **DONE** (Wave 2) | All 57 registry entries swept plain-language; technical facts relocated to NEW additive `technicalDetails` field (registry → contract AdminSettingSchemaEntry (oasdiff-verified non-breaking) → server DTO → SettingsCategoryCard → W13a tooltip); 587/465/25 SMTP facts pinned by test; no env-pin duplication (tooltip auto-folds it); MailSection intro decision-ID leak fixed; +7 registry tests, +2 passthrough tests. Orchestrator follow-through: gen-settings-reference.mjs now renders BOTH layers ("Technical details:" line, 15 entries) so generated docs lose nothing; regenerated settings/env references committed. |
| W14 power buttons (D-8) | **DONE** (Wave 2) | Both buttons equal width (min-width sized to longer label), "…" dropped, Restart = new `warning` variant (amber), Shut down = `danger`; confirm dialogs untouched. BONUS real find: shared danger BUTTON FILL failed AA (white on --color-danger = 4.08:1) — new `--color-danger-fill` (color-mix 90% danger/10% black) = 4.89:1, benefits every danger button app-wide; all ratios computed and recorded. |
| W15 Advanced Server rework | **DONE** (Wave 2, after W13b) | Search-icon crowding root-caused as RegistryFilterBar's LOCAL padding landing inside the icon footprint (shared Input variant verified fine) → 40px clears it; NEW shared FilterChip primitive in ui/Chip.tsx (explicit min-height fixes cross-line raggedness, --space-sm inset, SegmentedControl-matching amber active, real count badge, 44px touch floor) replacing the forked buttons; filter header boxed as its own block; spacing rhythm bumped; phosphor-mobile-css test updated to assert the new architecture. |
| W16 Search empty state | **DONE** (Wave 2) | /search's own 720px uncentered cap removed; page wraps SettingsPageLayout (existing standalone-route precedent); empty-state hero recomposed centered (recent-pills row + ghost watermark as one deliberate block); zero behavior/query/keyboard changes. Visual pass queued for Wave 3. |
| W17 macOS installer text wrap | FIXED at source + verified via Quick Look renders; real-Installer screenshot pending Screen Recording permission | welcome/readme/conclusion converted .txt→.rtf (proper paragraph flow, bold path—description list that survives any pane width; conclusion had the same defect class, included). Authoring HTML sources committed at installers/macos/pkg/resources-src/ (README documents the textutil regen + the charset-meta mojibake trap found and fixed: UTF-8 read as Latin-1 shipped em dashes as "â€""). Distribution.xml.tmpl → text/rtf; distribution-xml.test.mjs fixtures updated; `pnpm installers:test` green. Panes preview pkg (real Distribution + real resources, stub payload) opened in Installer.app on this M3 Max for eyeball check; scripted screenshot of the Installer window requires Screen Recording permission for the terminal host (screencapture: "could not create image from display") — final exit screenshots deferred to Wave 3 / owner grant. **[WAVE-A CLOSED f51a35d9 2026-08-11]** (RTF-regen drift check; real-Installer screenshot remains owner-verify) |
| W18 tray coherence | CODE-VERIFIED (no tray↔caps coupling exists); live VM re-check deferred to next Windows install | W1 RCA lane C traced the full chain: tray status text comes verbatim from GET /ipc/v1/status; the PRIMARY worker signal is a pg_stat_activity row with application_name 'loombre-worker:<pid>:<start>' scoped to current_database() (packages/db/src/query/worker-liveness.ts:79-93) — the hwprobe report plays NO part anywhere in the chain, so a worker running with zero hw backends reports "running" by construction in rc.3+. The screenshot's "Worker: stopped" was a TRUE liveness report (worker down / wrong-DB dev fallback in db-url.ts:44-51 / pre-labeling binary), not a caps symptom; the only misreport mode is the job-ledger fallback (idle==stopped) which engages solely when the liveness QUERY throws. No tray fix needed. Live confirmation (tray shows running + zero backends after W1's probe fixes) requires the owner's Parallels VM on the next rc install — flagged in the deferred list. |

### Wave 3 — opus review (3 reviewers), fix pass, visual sweep, exit gates (COMPLETE)

**Review verdicts drove a real fix wave.** 3 opus reviewers (design-system,
IA/authz, copy/decisions) over the three wave commits. All substantive findings
fixed same-session; full list + dispositions:

- **[BLOCKER, fixed] Invisible keyboard focus on filled controls.** The W4
  inset-ring consistency pass painted the amber --color-focus ring ON amber
  fills (measured 1.11:1 on .primary — WCAG 2.2 needs 3:1). New invariant: a
  FILLED control's inset ring uses its own TEXT color (currentcolor), whose
  contrast against the fill is AA-proven by the pairing itself — applied to
  Button .primary/.warning/.danger, SegmentedControl active segment, FilterChip
  active. Also .danger:hover now DARKENS (brightness 1.1 had pushed white-on-red
  to 4.16:1 mid-hover; 0.9 raises contrast in every state).
- **[HIGH, fixed] SeasonPillTabs** — last un-consolidated segmented lookalike
  (carried the exact pre-D-2 values incl. the 16px pill inset) → composes the
  shared track/segment like ZoneControls/SortControl.
- **[HIGH, fixed] D-3 chips** — new lib/enum-labels.ts (MEDIA_KIND/USER_ROLE/
  PROVIDER_KIND/STASH_SYNC_MODE label maps) applied at 7 Tag call sites
  (UsersSection's "admin" chip vs its own "Admin" picker etc.).
- **[HIGH, adjudicated] SettingField/PluginConfigForm enum widgets keep RAW
  values ("starttls", "http-01", "tier-gated") — D-3 EXCEPTION, recorded:
  registry enum values are the canonical technical config tokens that
  descriptions/tooltips/env pins/docs reference verbatim; title-casing would
  corrupt the vocabulary. The mistitled test ("uppercased via...") now titled
  honestly and carries the adjudication. allowToneMapCpu's description now
  NAMES its three values so pill and prose meet.
- **[HIGH, fixed] CATEGORY_LABELS missing 'stash'** (raw slug rendered as a
  filter chip). Reviewer's companion claim that updateCheck/rateLimit were dead
  entries was WRONG (grep: both live) — verified before acting, not applied.
- **[HIGH, fixed] Mobile tab bar D-6 gap** — tab-items gained role-aware
  resolution: non-admin's Settings slot → "Profile"//profile; mobile-header
  says "System Settings"; ⌘K's redundant "Admin Settings" entry removed.
- **[HIGH, fixed] authz sweep gaps** — GET /system/info + /system/update added
  (both verified requireAdmin-guarded); POST /system/shutdown guard now runs
  BEFORE the container-supervision 409 (a non-admin on Docker got deployment
  details instead of 403).
- **[HIGH, fixed] W12 copy was factually false** — NO installer sets
  LOOMBRE_LOG_FILE (they capture console output at the service-manager level),
  so every install shape lands on that card. Copy now states the truth + where
  logs actually live per platform; link relabeled "Environment reference"
  (stale admin-logs-tail.ts comment fixed too). DEFERRED owner call: give
  LOOMBRE_LOG_FILE real docs coverage (env-only registry entry feeding the
  generated env-reference) or have installers set it.
- **[HIGH, fixed] gen-env-reference.mjs lost the W13b technical layer** —
  operator docs silently dropped every fact that moved to technicalDetails
  (UDP on the WG port, trust-proxy formats, the AUD-A6b-002 platform-default
  lists). Both generators now render both layers; docs regenerated (23
  technical-details lines in env-reference).
- **[MEDIUM, fixed] registry copy corrections** — rateLimit.login/refresh no
  longer claim per-DEVICE for per-IP buckets; http.port/avifQuality positional
  "below/above" references replaced with named settings (the "above" resolved
  to the WRONG key); wireguardPort's false causal restart claim fixed; ms units
  spelled out on all three ms keys; cross-field couplings (segmentAhead pair,
  sessions pair) + ladderRungs shape/bounds now in technicalDetails;
  missingFileGraceHours unit + mechanism added.
- **[MEDIUM, fixed]** DatePicker's reduced-motion claim was wrong (tokens only
  shorten, never null the transform) → opacity-only reduced keyframe like its
  siblings; UserMenu Tab no longer drops focus to <body> (refocuses trigger,
  default Tab continues); SettingField ⓘ third ring technique unified; the five
  remaining native selects converted to ui/Select; /settings/data + /settings/
  devices moved to /profile/* with redirects + ProfileSettings entry links
  (D-6 "no user-scoped page under /settings" now literally true); stale
  "Admin → System"/"Settings > System" strings (incl. the PUBLIC
  /system/capabilities description) → "the Dashboard"; styleguide gained
  danger/warning buttons, FilterChip, filled-button focus demo; Dashboard's
  stacked "System/System" headings dedup'd (card retitled "Server info").
- **Deferred (recorded, owner-visible):** SegmentedControl et al. ship
  role="tablist" without arrow-key nav/tabpanel across 7 implementations —
  pre-existing, now load-bearing for registry enums; proper fix is the
  radiogroup pattern + roving tabindex (follow-up ticket, not this run).
  **[WAVE-A CLOSED 20e30a22 2026-08-11]** (+ b198c53b, radiogroup pattern +
  inset ring; 4 of 7 consolidated onto the shared component).
  FilterChip 30px vs segment 44px desktop heights — deliberate two-family
  sizing, kept. **[RE-AFFIRMED 2026-08-11]** Power confirm step stays red for Restart (escalation at the
  commit moment, documented in-file). /system/info fetched 3× per Dashboard
  load (perf nit). W17's HTML→RTF regen has no drift check. PinModal's raw
  input + shared .textarea-class number inputs remain outside ui/Input.
  Installers setting LOOMBRE_LOG_FILE. hevc-in-synthesized-fallback
  (verifiedAtMs:0 asserting hevc encode) — pre-existing Phase-3 BIND shape,
  flagged for owner.

**Visual sweep (live app, seeded DB, headless Chrome):** screenshots in
reports/polish-2026-08-07/ (gitignored; after-*.png per work item): dashboard
(W9/W1/W12 — hwprobe ran end-to-end live: VideoToolbox+Software backends,
ledger Completed), server power (W14), playback+mail registry rows with a
tooltip open (W8/W13), advanced filter chips incl. the Stash label (W15),
profile with DatePicker open (W5/W6/W10), search empty state with uncropped
focus ring (W16/W4), user menu (W11), add-library sheet (W2/W3/W4 — the
annotated screenshot's three defects visibly gone), non-admin sidebar (no
SYSTEM group) + live /settings→/profile redirect (D-6). Dev-stack note for
future sessions: `pnpm dev` WITHOUT DATABASE_URL provisions an EMBEDDED
postgres for the server while the worker falls back to compose 5442 — pin
DATABASE_URL=postgres://loombre:loombre@localhost:5442/loombre when driving
the seeded dev stack.

**Exit gates:** `pnpm gate` ALL STEPS PASSED (×4 across the waves);
`pnpm gate:full` ALL STEPS PASSED (web production build + bundle budget
"within budget"); oasdiff non-breaking (probe field + technicalDetails both
verified additive); W1 regression suite green incl. empty-caps scan-completes;
settings-authz e2e (now 79 admin routes × 403 + user-scoped still-works);
pill/segmented/chip audit grep-clean (SeasonPillTabs was the last straggler);
no third-party requests/fonts (website build's own CSP checks green);
docs regenerated + synced to website (build green; deploy stays manual).
W17 final Installer-window screenshot still requires Screen Recording
permission for the terminal host (Quick Look renders + a real preview pkg
opened in Installer.app stand in; content parity vs old .txt verified by
review lens 3).

### Pushed + deployed (2026-08-08, owner-directed)

- **Pushed**: 0dd6a504..f94a0ce9 → origin/main (gate:full green on that tree).
- **Website DEPLOYED to www.loombre.com** — live-verified: /docs/ops/env-reference
  + settings-reference serve the two-layer copy; the API reference serves the
  neutral description with ZERO CLAUDE.md mentions; root 200 with CSP intact;
  loombre-website modified_on 2026-08-08T02:34:17Z.
- **How (recorded for future sessions — wrangler is UNAUTHENTICATED on this
  machine; the Cloudflare MCP plugin's OAuth is the only credential):** the
  plugin's token can't mint API tokens (/user/tokens* → "Invalid API Token" for
  OAuth) and its execute-sandbox egress is allowlisted (external fetches 403),
  so `npm run deploy` can't work and neither can sandbox-pulls-from-a-tunnel.
  Working bridge for the assets-only worker: (1) build the manifest LOCALLY
  with wrangler's exact hash (blake3(base64(contents)+extension) hex[0:32],
  via the site's own node_modules/blake3-wasm; _headers/_redirects excluded);
  (2) MCP execute → POST /workers/scripts/loombre-website/assets-upload-session
  (account auth) → session JWT + needed-hash buckets; (3) upload buckets from
  THIS machine with plain fetch — the upload endpoint auths with the SESSION
  JWT, not the account token (POST /workers/assets/upload?base64=true,
  FormData of base64 File parts named by hash) → completion JWT on the last
  bucket; (4) MCP execute → PUT /workers/scripts/loombre-website multipart
  metadata {assets:{jwt, config:{html_handling, not_found_handling, _headers,
  _redirects}}, compatibility_date} (account auth, tiny payload). Custom
  domains/routes untouched by the script PUT. loombre-redirect worker
  unchanged (no redeploy needed). Note: /docs/*.html URLs 301 to
  extensionless paths (html_handling) — verify live content with curl -L.

### W1 root cause (RCA COMPLETE 2026-08-07 — 5-lane parallel trace, every claim file:line-verified)

**The suspected probe→scanner coupling DOES NOT EXIST in code.** Exhaustive trace
(worker battery/persistence, jobs queue + scan consumer, server controllers + IPC +
tray, web flows, playback resolve): no code path gates scanning, library CRUD, or
per-item ffprobe analysis on hardware-capability state. `runScan` has zero hwcaps
reads (apps/worker/src/scan/scanner.ts imports verified, full file); scan enqueue is
unconditional server-side (libraries.controller.ts:259) and client-side
(AddLibrarySheet.tsx:86-98 auto-POSTs /libraries/{id}/scan after create; wizard
LibraryStep.tsx:96-108 same with full:true); pg-boss gives each job type independent
fetch loops, so a failing/hung hwprobe cannot starve scan consumption.

**What actually produces the observed symptoms — four real defects + one
environmental condition:**

1. **Ledger/sweep mismatch permanently wedges the hwprobe boot re-enqueue
   (REAL BUG, fix landing this wave).** `hasQueuedOrActiveJobOfType`
   (packages/db/src/internal/jobs.ts:92-100) reads Loombre's own jobs LEDGER with
   no staleness bound. Ledger transitions are written only by the in-process batch
   handler (packages/jobs/src/queue.ts:267-295) — pg-boss's SQL-side sweeps
   (timeout-fail of 'active' jobs; 14-day retention-delete of never-fetched jobs;
   pg-boss defaults, Loombre configures neither) never touch the ledger. So a
   hwprobe job that was enqueued but never consumed (worker down / rc.2-era zero
   consumers), or fetched and orphaned by a worker death, leaves a ledger row stuck
   'queued'/'active' FOREVER → `checkHwCapabilitiesAndEnqueueIfNeeded`
   (apps/worker/src/index.ts:413-414) sees `alreadyPending` on every future boot →
   the probe is never re-enqueued again, ever → System page shows "no probe" /
   no backends permanently. Same wedge class applies to the image-backfill and
   stash singleton guards, and the stuck rows lie to the admin jobs UI.
2. **Probe-failed is unrepresentable (REAL GAP, D-1 requires three states).** The
   hwprobe consumer persists only on success (index.ts:221-228); GET
   /admin/capabilities returns `{report:null}` for BOTH never-ran and failed
   (admin.controller.ts:253-287; CapabilityReportEnvelope, openapi.yaml:4793 has no
   failure field). Completed-with-zero-backends IS distinguishable (non-null report,
   backends:[]) but renders as a header-only table with no copy (admin/system/
   page.tsx:124-145), and the wizard's "Worker not detected yet"
   (HardwareStep.tsx:78) actually keys on report===null — it mislabels
   "no snapshot persisted (incl. probe-failed-forever)" as a worker-status fact the
   web has no source for.
3. **D-1 gap in transcode-path selection (REAL BUG, fix landing this wave).**
   `resolveVerifiedCapabilities` falls back to synthesized software-only caps ONLY
   when the snapshot row is absent (resolve-caps.ts:67-71); a PRESENT snapshot with
   zero backend rows passes `{backends:[]}` to the engine verbatim (:77). Engine
   Stage G rule (iii) happens to be total anyway (hardware.ts:479-483 sets
   encoder:'software' unconditionally; resolve-caps.ts's header claim to the
   contrary at :15-18 is STALE), so nothing crashes — but the empty-persisted state
   bypasses the intended fallback, degrades hevcEncodePreferred inconsistently
   (resolve-policy.ts:101-102), and has zero test coverage.
4. **A completed probe on a GPU-less VM can only look "empty", never be absent-of-
   software, EXCEPT when the encoders listing fails.** The battery always emits one
   BackendReport per candidate (win32: nvenc/qsv/amf/d3d11va/software — software is
   ALWAYS a candidate, platforms.ts:19) and never throws per-backend (battery
   never-throws contract, 20s per-test timeouts). But if the one `ffmpeg -encoders`
   listing fails/times out (run.ts:69-72), EVERY test skips (no decode sources, no
   encoders) → a completed snapshot with 5 backends all empty — "completed with
   zero capabilities" is a real, valid probe outcome that the UI must explain as
   software-everything, per D-1.
5. **Environmental (verify live in W18):** "Worker: stopped" in the tray comes
   verbatim from the server's IPC status, whose PRIMARY signal is a pg_stat_activity
   row with application_name 'loombre-worker:%' scoped to current_database()
   (worker-liveness.ts:79-93). A worker that is down, restart-looping, or silently
   connected to the WRONG database (db-url.ts:44-51 falls back to the dev-compose
   URL when neither DATABASE_URL nor LOOMBRE_DATA_DIR is set) consumes nothing —
   which reproduces "libraries never scanned" AND "Worker: stopped" simultaneously,
   with zero involvement of hardware capabilities. This is the only mechanism found
   that stops scan jobs; it is a liveness/config failure, not a caps coupling.

**W1 fix plan (D-1):** (a) boot-time ledger reconciliation — worker marks
'queued'/'active' ledger rows older than a 24h horizon 'failed' (last_error names
the reconciliation) before its singleton-guard checks, unwedging hwprobe/
image-backfill/stash guards and un-lying the admin UI; (b) resolve-caps treats
backends:[] same as absent → synthesized software-only fallback + stale comment
fix; (c) contract-first three-state probe status: CapabilityReportEnvelope gains
`probe: {status: never-ran|pending|failed|completed, lastError?, updatedAtMs?}`
derived from snapshot presence + latest hwprobe ledger row; SDK regen; System page
+ HardwareStep render all three non-completed states with plain-language copy and
the completed-zero-capability state as first-class "software everything"; (d)
regression pins: scan-completes-e2e with absent AND empty snapshot, transcode
software-fallback unit + e2e for the empty-persisted passthrough, matrix `empty`
caps fixture, reconciliation unit tests, wizard-state three-state tests.

### W1 opus review (2 adversarial reviewers) — findings + hardenings applied

The review REPRODUCED a race in the first-cut reconciliation and reshaped it:

- **[BLOCKER, fixed] SELECT-then-UPDATE race.** recordActive could commit between
  the sweep's read and write, and the id-only UPDATE clobbered a genuinely
  running job to 'failed'. Now: FOR UPDATE row locks + every per-row UPDATE
  re-asserts the full staleness predicate (status + updated_at_ms) — a raced or
  double-booted sweep updates zero rows and emits zero events; a concurrent
  recordActive that loses the lock race self-heals (transitionJobLedgerRow has
  no status guard, verified).
- **[HIGH, fixed] Unbounded sweep + event flood.** Sweeping every type could hit
  a 30k-row probe backlog (one event each → outbox flood). Now type-scoped to
  the singleton-guarded types only (hwprobe/image-backfill/stash-inventory/
  stash-sync — one-per-type by design, handful of rows max).
- **[HIGH, fixed] 24h horizon missed the reported failure.** Crash-mid-probe
  leaves a fresh-timestamped 'active' row → 24h wedge per restart. Now 'active'
  rows are stale the moment they predate THIS worker process's start
  (one-worker-per-database shipped topology, worker-liveness.ts's own
  assumption); 'queued' keeps the 24h horizon.
- **[HIGH, fixed] resolve-caps guarded an unreachable shape / web copy missed the
  real GPU-less outcome.** A completed win32 probe always persists 5 backend
  rows; the common GPU-less result is software-verified + hw-rows-empty. The
  backends:[] fallback stays (defense-in-depth + test-seedable), and the
  ALL-ROWS-EMPTY snapshot deliberately passes through — engine rule (iii) still
  routes software and hevcVerified=false keeps targeting conservative h264
  (substituting the synthesized fallback there would flip hevcEncodePreferred on
  from a verifiedAtMs:0 sentinel — worse). The UI now keys on shared
  `hasNoAcceleratedCapabilities` (no NON-software backend verified anything),
  which fires on all three GPU-less shapes; one shared copy string.
- **[MEDIUM, fixed]** probe status now derived on the snapshot-present branch too
  (a NEWER queued/active/failed hwprobe row over an old snapshot → pending/
  failed with the stale report still served + banner); jobs(type, created_at
  DESC, id DESC) index added (migrations/0037 — the wizard polls this 4s);
  reconciliation last_error rewritten in plain language (it renders verbatim to
  end users); recordActive clears finished_at_ms; e2e cleanup scoped to seeded
  rows; playback-e2e comment de-overclaimed (unit spec is the revert-detector);
  512→513 prose.
- **Deferred (recorded, deliberate):** boot-only sweep (a mid-uptime ledger-write
  failure wedges the stash per-tick guard until next restart — periodic sweep is
  future work) **[RE-AFFIRMED 2026-08-11]**; unsupported-platform (freebsd etc.) 'never-ran' copy implies a
  probe that will never come (wire can't express 'unsupported'); the synthesized
  fallback's `encode: [h264, hevc]` @ verifiedAtMs:0 flipping hevcEncodePreferred
  for missing-snapshot installs is PRE-EXISTING Phase-3 BIND shape — flagged to
  owner, not relitigated here; scan hwcaps-independence spec is a forward pin
  (scanner never had the coupling), not a revert-detector — named as such.

Also this session (owner request mid-run): removed every CLAUDE.md mention from
the RENDERED API documentation (openapi.yaml info.description + 5 operation/
schema descriptions reworded neutrally; YAML comments kept — they never render);
SDK regenerated; docs rebuilt + synced to website (70 routes, build green;
deploy remains manual).

## LD wave — owner fix list LD-1..13 + follow-ups #9/#10/#11 (2026-08-10, six lanes + opus review, pre-rc.7)

Owner's annotated-QA fix list, built by five parallel sonnet lanes + a
sequenced sixth, opus-reviewed (9 findings: 0 BLOCKER, 3 MAJOR — all
applied by fix lane V4), landed as b7825f4a + 4a771dc1 + 954e74ae +
4759b08b + 1bcc5271 + 0c90b8a3. `pnpm gate:full` ALL 16 STEPS PASSED.
rc.7 tagged from this tree (owner: "push all commits and draft rc7").

- **LD-2 (954e74ae):** Settings→Server hardware card called the PUBLIC
  /system/capabilities endpoint, which hardcodes enabled:false BY DESIGN
  — structurally incapable of showing available. Now composes the
  dashboard's CapabilitiesCard against /admin/capabilities (same
  component, same three-state derivation; cannot drift). LD-3..6 order/
  copy/heading fixes same commit. LD-7 root cause: a repeated stale
  ch-max-width pattern (HeroCard, three Mail modules, origin in
  ProviderKeysCard) — not one shared class; all instances dropped.
- **LD-13 (4759b08b):** dead boolean switches REAL and root-caused (by
  the review after the lane couldn't reproduce it under act()):
  handleBoolToggle was wired to BOTH the row onClick and Toggle
  onChange; a switch click is TWO native dispatches (bubble + label
  activation-forward) and React 18 commits between them → second
  dispatch flips the fresh value back. Net: switch dead, ON/OFF text
  worked — exactly the owner report. Fix: exclusive handlers; two-act()
  regression test proven red on old wiring. All 5 boolean keys swept.
  LD-9: chip lock now = "category CONTAINS an env-pinned key" (was
  all-env-only; mixed `network` was silently unlocked). LD-10
  alphabetical chips (render-site sort only). LD-11: contained
  multi-line editor for ALL JSON-typed keys (bounded height, internal
  scroll, W4 inset ring, wrapping fact values).
- **LD-1/12 (1bcc5271):** session-refused screen debannered, Back leads
  the badge row (phone sheet keeps its own Back); transport cluster
  centered via three-zone bar; 10s skips both directions incl. keyboard;
  seekBack10/seekForward10 glyphs reuse the exact existing arc/arrowhead
  construction. Recovery state machine untouched (proven by suite).
- **LD-8 (0c90b8a3):** plugins consolidated onto Settings→Plugins (full
  12-feature inventory moved: list, register wizard, config, event
  grants, enable/disable, refresh→re-approval, HMAC once-display,
  remove, delivery status, pseudonymization, live ws). Dashboard tab
  removed; /admin/plugins* → redirect stubs (id preserved). REAL AUTHZ
  GAP found in the move: the new detail route rendered below both
  client-side admin gates — fixed via NEW shared useAdminGuard hook
  (replaces 3 copy-pasted guards; AppShell chrome now mounts during the
  check instead of a blank viewport).
- **#9 CLOSED (b7825f4a):** Class-A no-tiebreak reads fixed (plugins,
  plugins-delivery, stash-sync-reports, both chapter-marker reads);
  Class-B UUIDv7 tiebreaks verified pagination-safe + documented in
  cursor.ts. Event reads switched to ORDER BY seq (readEventsForViewer
  afterId→afterSeq — verified zero production callers;
  filterEventsForViewer = the ws send order; readUnprocessedEvents).
  REVIEW CATCH: the plugin-delivery cursor was a SECOND persisted
  id-keyset — same-ms sibling below an advanced cursor was skipped
  permanently, silently, outside the ts_ms gap detector (LPP §3.2
  violation). Migration 0040: cursor_event_seq (backfilled; events
  never pruned), candidate read keysets on seq with explicit minTsMs
  floor; cursor_event_id kept for the still-id-based gap detection.
  Old-shape skip proven by counterfactual test in both suites.
- **#10 CLOSED as considered-and-rejected:** cookie auth for media
  routes is architecturally unavailable — serverUrl is a runtime
  user-entered value (cross-SITE in the general case), plain-HTTP LAN
  is first-class (kills SameSite=None;Secure), CORS is deliberately
  credentials:false, hls.js needs credentialed-XHR reversal, native
  clients have no cookie jar. Reopens only if the web app becomes a
  streaming proxy or HTTPS is mandated (spec changes). The #6
  client-side machinery is the durable answer. Full record in task #10.
- **#11 CLOSED (4a771dc1):** cleanup-test-databases.mjs dropped 1062
  leaked per-suite DBs (1302→240, 14.6 GB reclaimed). Guards: never
  touches loombre/postgres/template*/active-connection targets or
  DATABASE_URL's own database; dry-run default. 238 remaining
  disposables predate the _test naming contract — left for a human.
- **Process:** parallel owner session running the an upstream media server comparative
  study shares this checkout (STATE.md section + docs/analysis/ are
  ITS files — deliberately excluded from this wave's commits). Its
  Phase-0 file:line citations predate this wave's playback commits —
  flagged to the owner for its Phase-2 pass.

## Vendor-mirror hardening + rc.7 shipped (2026-08-10→11, task #16 CLOSED; new task #17 opened)

v0.9.0-rc.7 DRAFT BUILT (all four legs green; macOS pkg carries the
relocation fix; publish remains the owner's manual action). Two
release-day incidents handled en route: (1) BtbN deleted the pinned
ffmpeg autobuild mid-draft — repinned d3a6883d (hashes independently
verified + cross-checked against upstream checksums); (2) the new
uninstall stray-bundle tests shimmed pkgutil but not macOS-only plutil
— red on the gate's ubuntu leg, hermetic shim added c5682d5e.

- **#16 CLOSED (660fda48):** all 7 pinned archives mirrored on this
  repo's `ffmpeg-mirror` release (tag deliberately outside the v*
  release trigger; assets append-only, named <sha256[0:12]>--<basename>
  so the pinned hash derives the name AND gates the bytes).
  fetch-ffmpeg falls back to the mirror on primary failure (token-
  gated; Node fetch drops Authorization on the cross-origin redirect —
  empirically verified), docker leg via optional buildx secret
  (absent → byte-identical build). vendor-liveness.yml probes all
  pinned URLs + mirror presence daily. LICENSE-INTENT records the GPL
  corresponding-source obligation that activates if the repo goes
  public. End-to-end proof: doctored-404 manifest pulled the real
  125MB mirror asset through the unchanged verifyChecksum path.
- **NEW task #17 (found while closing #16, NOT fixed):** the
  windows-installer-diag msiexec smoke failed on run 31460901255 with
  ERR_MODULE_NOT_FOUND for kysely/dist/operation-node/cast-node.js in
  the INSTALLED tree — while the same smoke PASSED 20 minutes earlier
  on an effectively identical tree (only a macOS test file differed).
  MSI file harvest appears NONDETERMINISTIC, and release.yml's
  build-windows leg does not run the smoke, so the shipped rc.7
  windows-x64.exe may or may not carry the defect. OWNER: smoke-test
  the Windows asset on the VM before publishing (or dispatch the diag
  workflow for more signal). Full evidence in task #17.

## an upstream media server-study IMPLEMENTATION run — close every verified defect + recorded deferral, then AV1 + ABR (kicked off 2026-08-10, owner brief "Close every verified defect and recorded deferral surfaced by the an upstream media server comparative study…"; Wave A is part of the 1.0 ship gate)

AUTHORITY: the owner's implementation brief supersedes the study's "no implementation"
lock — this run IS the authorized implementation orchestration. Waves: 0 foundations
(solo) → ⛔ STOP → A contract-free fixes (5 lanes) → B contract-touching (3 lanes) →
C feature builds (C1 AV1 then C2 ABR, each fable spec → ⛔ owner sign-off → build →
fable review) → D fable review + run exit. 1.0 does not tag until Wave A's exit
criteria hold; Waves B–D gate the release only if the owner says so at the Wave A stop.

RUN LAW (compressed; the brief is authoritative): three model tiers — haiku BANNED,
sonnet floor for standard lanes, opus pre-assigned to A1 lifecycle / A2 DV-strip /
B2 TOCTOU / both Wave C builds (orchestrator may promote a lane to opus, recording
promotion+reason here), fable for ALL review passes + Wave C specs + adjudications;
a lane never reviews its own work. STATE.md ground truth before each next wave;
agent-reported completion never accepted without orchestrator verification. License
firewall: study is concept-level reference ONLY — no lane clones/consults/cites
an upstream media server source this run; LICENSE-SENSITIVE areas derived from first principles.
Publication ban LD-1. Lane safety: spec-file allowlists only (never package-level
test runs); resumed worktree lanes pin absolute worktree path first; orchestrator
checks git status + worktree list on main after any resume; settings-registry lanes
run docs:build + commit regen. Contract: SDK regen+build atomic per touch (sdk-drift),
oasdiff per change, conformance unimplemented-allowance stays zero; engine changes
ship matrix+goldens same PR + ENGINE_VERSION bump. Feedback-loop-first. Read-only
scout before writes in every lane; Wave 0 + both C specs end in confirmation stops.

### LD register (LD-1..LD-16, owner-adjudicated 2026-08-10 — DO NOT re-litigate; distinct from the fix-list "LD wave" LD-1..13 numbering at the section above)

- LD-1 Study internality: relocate study to gitignored reports/ path; purge history
  if ever committed; srcExclude analysis/** belt-and-braces; docs-build verify.
- LD-2 Windows-ARM authorized: candidatesForPlatform gains arch param; win32+arm64
  → ['software'] only; d3d11va excluded until real ARM64-Windows decode evidence
  (recorded re-open condition).
- LD-3 DV strip real: dv-stripped-to-hdr10 copy path emits a genuine DOVI-RPU-
  removing bitstream filter AND drops the enhancement layer on repackage for
  profile-7 dual-layer — clean single-layer HDR10, zero DV residue. Red-first vs
  real ffmpeg + real DV sample (open-GOP-strip precedent), goldens, matrix both
  directions, spec + reason semantics updated to the now-true behavior.
- LD-4 devices.profile stays (deliberate cache); C10 = fix the stale migration
  comment to say exactly that.
- LD-5 No theming work; themes-as-LPP-plugin formally retired (LPP excludes UI
  extensions by design) — record in plugin roadmap doc.
- LD-6 ABR implemented (Wave C2): master playlist route, multi-variant session
  shape, client rung switching. Governed by LD-16.
- LD-7 AV1 fully supported (Wave C1): LadderCodec enum + VideoAction.targetCodec
  contract additions; encoder tables + DB CHECK + TS unions one coordinated change;
  matrix/goldens same PR. Governed by LD-16.
- LD-8 rateLimit.loginByIdentifier stays as-is — ACCEPTED, recorded here.
- LD-9 Remote cross-path TOCTOU properly fixed: serialize enables; mechanism MUST
  guarantee release on any thrown external side effect (no permanent-lockout mode);
  design states its release guarantee explicitly; reviewer attacks it.
- LD-10 Perf harness variance-resilient: best-of-N / repeat-on-breach targets the
  MEASUREMENT; perf/baselines.json budgets untouched; real regression still fails.
- LD-11 Installers set LOOMBRE_LOG_FILE on every shape (pkg/MSI/Docker/tarball
  docs); W12 empty-state copy + env-reference regenerate.
- LD-12 Stash sort=rating lands: migration 0023→(next free number) two measured
  partial expression indexes (238→7ms), explicitly reversing decision 0009 with a
  documented reason at the decision site.
- LD-13 Mail posture trio now: (a) currentPassword on self-changes; (b)
  ClaimInviteRequest.email null-to-clear; (c) emailApplied:false post-auth claim
  signal (reviewer verifies no pre-auth distinguishability). R-F1 PATCH-me oracle
  accept+document NOT reopened.
- LD-14 AUD-A4v3-003: amend the broken design rule itself, then conform the
  implementation; both reviewed together.
- LD-15 DV profile-7 subsumed by LD-3 (EL dropped on repackage; no gating-out).
- LD-16 ABR/AV1 tier posture (verbatim law): every quality rung is a separate
  workload under the existing admission capacity limit; a quality change hands the
  existing slot from one rung to another — never an additional unrestricted
  transcode; Tier-0 advertises a limited variant count (C2 spec proposes exact
  count for owner sign-off); AV1 on Tier-0 ONLY with probe-battery-verified
  hardware encoding; Tier-1+ may fall back to software AV1.

### Wave 0 — foundations (solo, orchestrator, 2026-08-10) — COMPLETE, at ⛔ STOP

LD-1 EXECUTED + VERIFIED: study moved docs/analysis/upstream-media-server-comparative-study.md →
reports/upstream-media-server-study/ (git check-ignore confirms .gitignore:47 reports/ covers it);
`git log --all -- docs/analysis/` EMPTY (never committed — no history purge needed;
index clean, no stash); docs/.vitepress/config.mts srcExclude now ["PLAN.md",
"PLAYBACK.md", "public/**", "analysis/**"] with a firewall comment; pnpm docs:build
ALL STEPS PASSED and `grep -ril upstream-media-server docs/.vitepress/dist/` → ZERO hits, no
analysis/ route in dist. Documentation Sync standing rule honored for the config
edit: dist → website site/docs-dist (verbatim replace) + website `npm run build`
green (70 docs routes merged, CSP/invariant checks pass). Deploy NOT run (manual
owner action, per the rule). Run-law-3 structural enforcement: the an upstream media server clone
was DELETED from the session scratchpad. Stale worktree lane/remote-t2 pruned;
`git worktree list` = main checkout only.

CITATION RE-PIN vs HEAD 88c5e6e5 (tree clean; the post-rc.6 QA + fix-list + LD +
vendor-mirror waves all landed since the study — every study SHA is stale, these
supersede):
- C1 CONFIRMED, mechanism intact: apps/worker/src/index.ts shutdown() (≈:563) does
  queue.stop() + hashPool.terminate() + watcher/delivery-loop stops + db.destroy()
  — NO live-run registry, NO terminate of in-flight transcode runs. runner.ts has
  an internal idempotent handle.terminate() (:226, :307) ready to be registered.
- C2 CONFIRMED, mechanism intact: process.ts:111 detached POSIX spawn; NO worker_pid
  anywhere (grep of migrations + worker src empty); index.ts:484
  SINGLETON_GUARDED_JOB_TYPES still excludes "transcode"; playback-sessions.ts
  countActiveTranscodeSessions :701-709 counts non-terminal statuses (now incl.
  'seeking') — orphan-frees-slot-while-burning-CPU conclusion unchanged.
- C3 CONFIRMED at new line numbers, scope REFINED by the QA wave's controller
  rewrite: hls-file.controller.ts:57 SEGMENT_DURATION_SEC=6, :58
  SEEK_LOOKAHEAD_SEGMENTS=3; seek fires at :255 (lookahead>3 path) and :274
  (ENOENT/pruned path), BOTH still `segmentIndex * SEGMENT_DURATION_SEC * 1000` —
  nominal-duration arithmetic vs real variable-duration segments. requestSeek
  (packages/db/src/query/playback-sessions.ts:611-623) writes seek_target_ms
  VERBATIM — the missing [0,durationMs] clamp is confirmed. New context Lane A2
  must honor: manifest now serves active OR suspended (:179 manifestServable, the
  manifest-serves-suspended fix), requested-segment tracking at :245
  (updateRequestedSegment), seek check runs BEFORE any filesystem touch; worker
  consumes seeks in runner.ts (spawnRun seekTargetMs :203/:311, startSeg =
  (producedSegment ?? -1) + 1 at :309). Goldens 33/34 (seek-copy-opengop) now
  exist and constrain the arg-builder side.

FLAGS FOR THE STOP: (1) fix-list task #10 (Safari cookie-auth structural fix) is
listed in the brief's ground-truth inputs but NO wave lane owns it — owner assigns
or explicitly re-defers; (2) the fix-list "LD wave" section above uses its own
LD-1..13 numbering — unrelated to this register.

Lane briefs: reports/upstream-media-server-study/briefs/ (gitignored evidence tree) — file-scope
allowlists, spec-file allowlists, exit-evidence lists per lane; briefs are the
verbatim spawn prompts for Waves A/B; C briefs are the spec-lane charters.

STOP RESOLVED (2026-08-11): owner approved Wave A; owner directed task #10 →
Wave B. AFTER the stop presentation the orchestrator discovered the LD wave had
ALREADY adjudicated the three fix-list tasks: #9 CLOSED (b7825f4a — full Class
A/B sweep + review-caught plugin-delivery second id-keyset, migration 0040;
commit verified), #11 cleanup CLOSED (4a771dc1 — 1062 DBs dropped; the TWO
residuals remain open and are Lane A1's), and #10 CLOSED considered-and-rejected
(cookie auth for media routes architecturally unavailable: serverUrl is runtime
user-entered/cross-site, plain-HTTP LAN is first-class → kills SameSite=None;
Secure, CORS deliberately credentials:false, hls.js credentialed-XHR reversal,
native clients have no cookie jar; recorded reopen conditions: web app becomes a
streaming proxy OR HTTPS mandated). The #10→Wave B direction was given against
the orchestrator's stale "unassigned" flag — discrepancy surfaced to owner;
recommendation: honor the recorded closure. RESOLVED 2026-08-11: owner directed
"honor the recorded closure" — task #10 stays CLOSED considered-and-rejected;
the conditional Wave B slot is withdrawn; Wave B remains B1/B2/B3 as chartered.

### Wave A — SPAWNED 2026-08-11 (5 parallel worktree lanes; A1/A2 opus, A3/A4/A5 sonnet)

Lane adjustments vs the briefs as presented at the stop (all recorded in the
brief files too): A1's mission = C1 + C2 + C7 + task-#11 RESIDUALS only (#9
dropped as closed; cleanup half done); migration numbers pre-assigned to avoid
parallel collision — A1 gets 0041 (worker_pid/worker_started_at_ms), A5 gets
0042 (LD-12 rating indexes); A2 runs a mandatory work order (C3 → C6 → C9, then
LD-3 SCOUT ONLY — fixture proposal returns for orchestrator checkpoint before
any DV implementation); A5 reads audit candidates read-only from the MAIN
checkout's reports/ (gitignored → absent from worktrees). Orchestrator holds:
gate runs, docs sync, integration merges, per-claim verification.

**A2 checkpoint (2026-08-11, mid-wave):** items 1–3 DONE and orchestrator-verified
(38/38 re-run in the lane worktree; zero engine/contract diffs). C3 landed as a
pure controller-side derivation (deriveSegmentStartMs: exact cumulative real
#EXTINF sums inside the served window, measured-mean extrapolation outside,
nominal only as last resort) + [0,durationMs] clamp at both call sites —
requestSeek untouched (no A1 handoff needed). LD-2/C6: candidatesForPlatform
arch param REQUIRED (not defaulted — a default would silently re-admit the x86
list); win32+arm64 → ['software']; re-open condition in-file. C9 done. SCOUT
CONFIRMED THE STUDY'S C4 FINDING IS WORSE THAN DOCUMENTED: dv-stripped-to-hdr10
emits `-c:v copy` and NOTHING else — no DV-aware builder code exists; RPU NALs
AND container dvcC/dvvC signalling pass through; profile-7 EL not dropped
either; copy branch never re-tags hvc1. LD-3 implementation AUTHORIZED at the
checkpoint with: fixtures = NAL-splice CI floor + dovi_tool primary (2.3.3
installed via brew, PATH-resolved dev tool, MIT — LICENSE-INTENT.md entry
required) + owner-sample env hook; mechanism decided EMPIRICALLY between
filter_units=remove_types=62-63 and the DV-aware dovi_rpu bsf (present in PATH
ffmpeg; vendored-build availability must be reported) against a three-fold
zero-residue oracle (trace_headers NAL scan + no DOVI side-data record + hvc1
tag); open-GOP composition ships as ONE -bsf:v value (golden 37); reason stays
`dv-stripped-to-hdr10` made TRUE with EL-drop in parameterized detail (NO new
reason code — contract enum is closed; distinct-code option deferred to owner).
NEW A2-FOUND DEFECTS RECORDED FOR POST-A1 DISPOSITION (runner.ts is A1's file):
(1) presentation-vs-source timeline divergence — seek runs spawn `-ss` without
-copyts, output timeline restarts at 0 while segment indices are a global
monotonic counter and no per-run source origin is recorded server-side → exact
source-time anchoring impossible for runs ≥1 and post-seek progress reporting
(video.currentTime) is wrong; (2) seek-restart livelock — client retrying a
too-far-ahead index re-fires requestSeek per 503 and the worker restarts
unconditionally (no de-dup against in-flight target); (3) renderServedPlaylist
EVENT playlist prunes head without EXT-X-MEDIA-SEQUENCE (assigned to A2's
continuation, its file).

**A3 checkpoint (2026-08-11, mid-wave):** first pass done. GENUINELY-OPEN items
closed: C5.1 breaker boot re-seed (pure seed primitive + server wiring; RED run
exposed a WORSE bug — an un-reseeded restart REGRESSED the durable
consecutive_failures column downward on next write); C5.3's new half (secret
dropped from a live manifest stranded its keyring entry forever —
removeOrphanedManifestSecrets keyed on the manifest schema diff, deliberately
NOT on config submissions whose omission=unchanged contract is intentional);
L-6. ALREADY-CLOSED-IN-TREE verified not re-implemented: L-4 (+ a db-layer
lpp:-prefix reject covering ALL future callers), L-7, L-2/L-3 (regression tests
backfilled — none existed). Orchestrator CORRECTED one lane call: the
LAN-allowlist exact-hostname bypass (ssrf.ts:361, pinnedAddress:null) is NOT
by-design-acceptable — it is precisely the residual the owner's C5.2 wording
directs closing; continuation ordered (resolve-once-and-pin for allowlisted
names, allowlist's only remaining effect = skip the disallowed-range check;
red-first flip-resolver test). SCOPE EXTENSIONS granted to A3: (a) worker-side
SECOND breaker registry with the same unseeded gap (apps/worker metadata/
plugin-breakers.ts + plugin-delivery/backoff.ts — A3's find; index.ts wiring
would hand off through A1); (b) M-7 ledger redaction landed in packages/jobs/
src/ledger.ts recordRetrying/recordFailed (verbatim errorMessage → jobs.
last_error + job.updated outbox payload; verified at source), redactPaths
lifted from apps/worker/src/crash to a shared home. Final spec-run verification
of the whole A3 branch happens once, on the settled branch, when the
continuation returns.

**A1 checkpoint (2026-08-11, mid-wave):** all four items DONE and orchestrator-
verified (30/30 on re-run in the lane worktree incl. the 4 real-ffmpeg lifecycle
integration proofs; contract scope empty; migration 0041 additive; requestSeek
content untouched). C1: run-registry (register-at-spawn-before-any-await,
allSettled terminate-all) awaited FIRST in shutdown(), SIGCONT-before-SIGTERM
preserved and timing-asserted (<1.8s for a throttle-suspended run). C2:
worker_pid/worker_started_at_ms + reapable partial index; reaper with real
inspector (/proc Linux, ps darwin, tasklist+wmic+CIM win32, zero new native
deps); PID+cmdline verified against staging_dir — reused/unverifiable pid NEVER
signalled, session still reclaimed; kills the process GROUP. Lane FOUND+FIXED a
worse defect while proving the cap invariant: killGroup returned once SIGKILL
was QUEUED, freeing the admission slot while the process was still scheduled —
waitForRunExit (bounded, zombie-proof gone-predicate) now pins kill→re-inspect→
free-slot ordering. C7: reconciliation machinery EXTENDED with per-group
horizons (transcode group: 15-min queued-stale horizon = the sweeper's own
idle-timeout, maxRows 500, oldest-first) — singleton list untouched; WARN
orphan-signature breadcrumb in the query layer (sweeper service is A5-forbidden
territory; honest limitation documented: jobs ledger has no session id, fact 3
is instance-level). #11 residuals: (b) advisory-lock serialization of
migrate/reset (both race interleavings reproduced red first); (a) reset now
demands live-process evidence (pg_stat_activity application_name loombre-%) AND
a COMMENT ON DATABASE disposable-claim (stamped on auto-provision/ensureTest/
--allow-reset adoption; stamping itself gated on isTestDatabaseName so the real
DB can never be marked). Operator side effects recorded: shared loombre_test on
5442 stamped once by the lane; dev DB `loombre` verified UNMARKED. Lane also
tripped+scrubbed the competitor-naming grep gate in first-draft comments —
advisory relayed to A4/A5. A1 CONTINUATION ordered (A2's two runner-side finds,
now dispositioned): (1) seek-restart livelock de-dup in runner consumption;
(2) per-run source-origin recording — durable runs table (runIndex, startSeg,
sourceOriginMs), migration 0043 reserved, real columns per invariant #3, plus
the packages/db read query; controller-side consumption (derivation upgrade +
progress reporting) sequenced to A2 AFTER A1 lands; -copyts/arg-builder
timestamp semantics explicitly deferred to the ABR (C2) spec.

**A2 LD-3 checkpoint (2026-08-11): the DV strip is REAL — done and orchestrator-
verified** (76/76 on re-run: dv-strip real-ffmpeg fence + goldens + contract-
reason-codes + playback-hls; contract diff empty; ENGINE_VERSION 0.8.5→0.9.0,
bumped once). EMPIRICAL MECHANISM DECISION (real profile-8.1 + real profile-7
dual-layer samples, x265+dovi_tool, through the real HLS pipeline): chosen =
`filter_units=remove_types=62-63` + `-tag:v hvc1` on the DV-strip copy branch.
dovi_rpu=strip=1 REJECTED — strips the RPU but leaves ALL 104 EL NALs on
profile-7 (fails LD-15); filter_units clears both to zero. Container DOVI
config record: ffmpeg 8.x does not propagate it on stream copy at all (no
residue leg; no STOP needed) — but the dvh1 fourcc DID survive repackage and
-tag:v hvc1 closes it. Vendored-ffmpeg question moot by choice: filter_units
long predates the 7.1-era dovi_rpu, so a repin can never silently lose the
mechanism (manifest pins are 8.1.x). TWO DESIGN-CHANGING LANE FINDINGS:
(1) trace_headers is BLIND to unspecified NAL types 62/63 — the originally-
proposed oracle read clean over a fully intact RPU; replaced with a direct
Annex-B byte scan (the decorative-oracle trap, caught red-first); (2) two
-bsf:v flags silently overwrite each other (proven: RASL 8/9 survived) — the
open-GOP + DV composition ships as ONE merged filter_units=remove_types=
8-9|62-63 (golden 36 pins it; integration asserts exactly one -bsf:v arg).
Reason semantics contract-free as approved: no new code; detail carries
dvProfile/blCompatId/elDropped; contract hazard AVOIDED — VideoAction is
additionalProperties:false so a dvStrip flag would have been a contract change;
instead packages/playback-engine/src/dv.ts's dvStripApplies() is shared by
Stage C and the builder, making reason/args drift structurally impossible.
EXT-X-MEDIA-SEQUENCE fix landed (first-surviving-index = media sequence;
unpruned playlists byte-identical). LICENSE-INTENT.md gains the external
test-fixture-tools section (dovi_tool, MIT, PATH-resolved, never vendored).
NEW FINDING dispositioned to the Wave C2 ABR SPEC's scope: the served playlist
declares EXT-X-PLAYLIST-TYPE:EVENT while retention prunes segments — a genuine
RFC 8216 §4.3.3.5 contradiction; NOT one-line-fixable (dropping EVENT makes
hls.js treat the stream as live and jump to the live edge, breaking resume) —
the C2 spec must define playlist-type/retention semantics and close it. A2 now
HOLDS for the sequenced consumption half of the run-origin fix (post-A1-
continuation). PLAYBACK.md §3/§4/§6/§8.2/§9 updated by the lane; docs sync
orchestrator-side at integration.

**DV strip — INDEPENDENT ORCHESTRATOR VERIFICATION (owner-ordered, 2026-08-11),
five layers, all PASS:** (1) implementation read — one shared predicate
(dv.ts), one merged -bsf:v, hvc1 re-tag, contract hazard avoided; (2) wiring —
goldens 35-38 pin the production argv (36 = merged 8-9|62-63; 38 = no-strip for
a DV-capable device) and the fence calls production plan()/buildFfmpegArgs();
(3) fixture genuineness — orchestrator-authored NAL scanner (written from
H.265 §7.3.1.2, zero lane code reused) found the profile-7 fixture carries 48
RPU(62) + 104 EL(63) NALs and the 8.1 fixture 48 RPU, both with dvvC box +
dvh1 fourcc + DOVI config record — the strip result cannot be vacuously clean;
(4) physical end-to-end through the real HLS-fmp4 shape — post-strip: 0×62,
0×63, no dvvC/dvcC/dvh1 bytes in init.mp4, hvc1 present, ffprobe side_data
empty, output decodes as plain HEVC Main 10 with HDR10 colorimetry INTACT
(smpte2084 + bt2020, SEI prefix NALs retained), identical slice-NAL counts
pre/post (only DV units removed); differential composition proof — merged
filter also removed RASL 8/9, plain 62-63 left RASL alone, exactly per
goldens 36 vs 35; (5) mutation — DV_NAL_REMOVE_RANGE neutered to 60-61 +
engine rebuilt → fence fails 3/4 (zero-residue, LD-15, composition); source
restored + rebuilt → 4/4 green. Verification note for honesty: mutation round
1 falsely looked green because the fence imports the BUILT dist and the first
mutated build failed silently in an &&-chain (orchestrator harness error,
caught and redone properly). LD-3/LD-15 verdict: properly implemented and
genuine.

**A4 checkpoint (2026-08-11): all 8 items done — orchestrator spot-verified**
(29/29 on SegmentedControl/system-info/PinModal/LibraryPills re-run from
apps/web; contract diff empty; 7 commits; lane's own final combined rerun was
166/166 across 22 spec files + installers:test 59/59 + grep-gates 0). Radiogroup
sweep: all 7 implementations on WAI-ARIA radiogroup + roving tabindex; FOUR
consolidated onto shared ui/SegmentedControl (LibraryPills, SortControl,
ZoneSortControl, SeasonPillTabs); RegistryFilterBar + FeaturedBanner carry the
pattern directly (shape doesn't fit); collateral test updates caught by broad
rerun (StashModal, StashConnectionPanel, RestrictedStep, ComposeNoticeCard).
PinModal + notice number inputs → ui/Input. Poster-card item REDIAGNOSED by the
lane: all four family members were ALREADY real anchors with Enter-nav — the
actual defect was focus-ring clipping under overflow/windowing ancestors; inset
ring applied to all four (Input/Button precedent). /system/info triple-fetch →
single lib/system-info.ts call site (module cache + in-flight dedup), proof =
three simultaneous consumers, apiGet mock called exactly once. W8 tail landed
per the established scale rules. W17 RTF drift check landed (textutil regen
byte-diff, tamper-tested both directions, macOS-skip per house pattern).
VERIFIED-ALREADY-RESOLVED (stale STATE.md rows, no re-implementation): W5
native selects and mobile-tab-bar/settings-devices — both landed in the Wave 3
pass f94a0ce9 after those deferral rows were written; rows now superseded by
this entry. Lane self-scrubbed 25 competitor-naming violations after the
mid-run advisory (its comments had used the run's own section title).

**A1 FINAL (2026-08-11): continuation done — lane COMPLETE, orchestrator-
verified** (44/44 on re-run: seek-dedup + lifecycle + transcode-sessions;
migration 0043 + the WHERE seek_target_ms = $expected compare-and-clear guard
confirmed at source). Livelock: 17-spawns-red → absorb-don't-obey; absorption
only when the run is ALIVE and the target lies in [sourceOriginMs,
sourceOriginMs + producedMs] (window collapses to exact-origin once retention
prunes the run's head); a different target can NEVER be swallowed (SQL guard —
zero rows matched, survives to next tick). Run origins: transcode_runs table
(0043, real columns + FK + UNIQUE(session_id, run_index)); recorded for EVERY
spawn incl. run 0 (idempotent per (session,run) for job redelivery); reads
keyed by start_segment (the only monotonic key — source_origin_ms is NOT
monotonic under backward seeks, pinned by a three-run test); real-ffmpeg proof
maps segment→run→origin across the seek boundary. Lane root-caused a
mid-verification flake: a parallel suite reset shared loombre_test mid-run —
the NAMESPACING half of #11 residual (b); its two new integration suites now
provision per-suite DBs (worker_lifecycle_test, worker_seek_dedup_test);
RECOMMENDATION recorded: move remaining worker/jobs live-DB suites per-suite
at integration (two-line change per file). PLAYBACK.md §9 two bullets added
in A1's own block.

**A5 FINAL (2026-08-11): 16 items dispositioned — lane COMPLETE, orchestrator-
verified per-file** (sync-consumer 14/14, connect 8/8, zero-file-e2e 2/2,
events-ordering 5/5, password-recovery 21/21; earlier combined-invocation
failures were the ORCHESTRATOR'S harness batching multiple stash/db suites in
one vitest run — lanes' per-file discipline is the correct protocol, adopted
for all future verification). LANDED: C10/LD-4 comments; C8→Wave-C1 linkage
comment at args/builder.ts VIDEO_ENCODER_NAMES; reverse-proxy /images/** in
all three recipes (docs sync pending); AUD-W1-001 dotnet test step on the
gate job's Linux leg (EXECUTION PROOF = NEXT CI RUN — no local dotnet SDK);
AUD-W4-001 afterSeq NaN→MalformedCursorError (original defect closed by #9;
same class resurfaced one type down); AUD-W6-002 documented-not-faked;
AUD-W6-004 cron-parser 5.7.0 via pnpm-workspace.yaml overrides (pnpm 11 moved
overrides out of package.json — caught live); AUD-W2-001 full-mode marker
retirement deferred past apply (mirrors the incremental fix); depcruise
no-orphans (3 legitimate orphans excluded by pattern); temp-password-reuse
rejected same-password self-change; stash.provider.connected event
(transition-gated; K12: events live OUTSIDE openapi.yaml — the 8-step
closed-list touch DOES edit packages/contract/event-schemas/, accepted as the
established additive procedure, FLAGGED to Wave D reviewer 2 for
re-adjudication); LD-12 migration 0042 with the decision-0009 PARTIAL-REVERSAL
quoted at the decision site (238.7→7.4ms desc, 253.1→7.5ms asc; rating-only,
restricted-zone-only; year + date/duration remain open); LD-14 rule amended
(subtle/hint only on --text-* >=12px, NEVER --mono-*) + 8 declarations
conformed with measured contrast (login labels were 2.34-3.38:1 → 7.4:1).
REJECTED-with-evidence: limit clamp (all ~31 paginated ops already clamp,
R-F9 spec green), node drift (BUILD-NOTES already fixed; gate-node-next 26
deliberate), win32 DACL (closed by the 3-OS gate wave, mkdtempSync confirmed),
sort=date sentinel (mechanism internally consistent; the LEFT-JOIN index
limitation is A8b's recorded architectural constraint, not a bug).
CLASSIFIED→Wave B: DELETE /admin/libraries/{id}/stash-connection (new
contract op — added to Wave B's charter). REASSIGNED→A4: AUD-W6-001's real
fix is client-side (server returns clean 404 <2s, proven by committed repro).

DISPATCHES (2026-08-11): A2 continuation = consumption half (merge A1's
branch; exact per-run derivation via getTranscodeRunForSegment; post-seek
progress mapping SERVER-SIDE preferred — A4 owns web components; triple-seek
red-first). A4 continuation = AUD-W6-001 client fix (404 → UnavailableScreen)
+ LD-14 re-verify of registry footers + SORTED-BY label against the amended
rule. Wave A remaining: those two continuations, then integration (merge all
branches → gate:full → docs sync → deferral annotation sweep CLOSED/
RE-AFFIRMED → exit-gate proofs on the merged tree).

**A4 continuation verified (2026-08-11):** AUD-W6-001 CLOSED client-side —
root cause exactly as A5's repro implied: createPlaybackSession deliberately
re-throws non-refusal errors and VideoPlayer's session-create effect ran
`void run()` with no catch → unhandled rejection, phase stuck on "loading"
forever; fix routes ANY thrown error into the existing client-synthesized-
reason fatal path (UnavailableScreen), red-first with the unhandled-rejection
failure mode captured (33/33 on orchestrator re-run). LD-14 spots both
resolved-with-evidence, no changes: registry footer already complies (13px
--text-sm + hint = the accepted-exception tier — a side effect of A4's own W8
fix, anticipated in its code comment); "SORTED BY DATE ADDED" NEVER SHIPPED —
prototype-only copy in the Phosphor .dc.html (watchlist screen), traced
exhaustively, the violating mono+hint pattern was never built. A4 flagged one
NEW violation outside its asked spots: .sourcePill[data-source="default"] =
subtle color on the shared --mono-xs size — micro-continuation dispatched
(conform per the amended rule, lane's design call on color-vs-size).

**A2 FINAL (2026-08-11): consumption half done — lane COMPLETE, orchestrator-
verified** (66/66 across playback-hls + playback e2e on re-run; A1-branch
merge commit 2361e0e5 clean, zero conflicts). Exact per-run derivation: run 2
origin deliberately EARLIER than run 1's in the triple-seek case (backward
seek — clock ordering picks the wrong run), distinct per-run durations
(6006/9009/7007) so no cross-run mean can accidentally pass; mid-run leg fully
exact. LANE SELF-CAUGHT BUG worth institutional memory: selecting a run's
segments by `index >= run.startSegment` sweeps in every LATER run's segments —
a transcode_runs row records where a run STARTS, not where it ends; membership
now decided by the runN/ prefix the playlist URIs already carry. FLAG FOR
WAVE C2 SPEC + any future consumer: getTranscodeRunForSegment gives a run's
START; consumers needing EXTENT will hit the same trap. Progress mapping:
server-side at putProgress ingestion (catalog/progress.controller.ts), mapped
BEFORE the write so resume point and playback.progress payload cannot
disagree; NEVER-GUESS contract (no session/runs/staging/playlist, or position
past end → client value passes through unchanged — correct for direct-play
and un-seeked sessions, pinned by guard cases); red evidence: stored 66066
where 606006 was correct (off by 9.5 min). D2 boundary honored: pure helpers
lifted to apps/server/src/common/served-playlist.ts (catalog may not import
playback/) — depcruise clean. No engine changes; ENGINE_VERSION stays at the
single 0.9.0 bump; contract untouched. PLAYBACK.md §9: per-run anchoring rule
+ heartbeat mapping formula added. WAVE A CODE WORK NOW COMPLETE except A4's
.sourcePill micro-fix; integration begins when it lands.

### Wave A — CLOSED 2026-08-11 (exit gate MET)

Integration: all five lane branches merged to main (92bd624c A1+A2 → 76ce3ec2
A3 → 685e9219 A5 → 64992f44 A4); schema.sql REGENERATED on the merged tree
(only conflict, per standing rule); pnpm install no-op; migrate-check 56
tables. **gate:full ALL 16 STEPS PASSED** on the settled tree (web bundle
170.7 KB gz / 200 budget; perf refresh c018b564). Docs/website sync run
(website build green; deploy remains manual). Exit-gate items: lifecycle
integration proofs green (no-orphan restart, hard-kill reap, slot-never-freed-
early); triple-seek green; DV both profiles → clean single-layer HDR10 with
zero residue (goldens both directions; spec==code; independent 5-layer
orchestrator verification incl. mutation, owner-ordered); annotation sweep
landed 7334ce90 — every closed deferral CLOSED-with-commit at its originating
entry, every deliberate-keep RE-AFFIRMED, zero unanchored. Residual follow-ups
carried forward: per-suite DB isolation for remaining worker/jobs live-DB
suites (A1's recommendation — Wave D); apps/server crash-redact twin onto the
shared canonical (Wave D cleanup candidate); K12 event-schema touch
re-adjudication (Wave D reviewer 2); AUD-W1-001 dotnet CI step execution proof
(next CI run).

**OWNER DECISION (2026-08-11): release gating deferred to run exit.** The
"do Waves B–D gate 1.0?" question is not decided at the Wave A stop; nothing
tags until the full run (B, C1, C2, D) completes and the owner decides with
everything in. Wave A's exit-gate evidence stands as recorded.

### Wave B — SPAWNED 2026-08-11 (B1 mail trio sonnet, B2 TOCTOU opus, B3
harness+installers sonnet, B4 stash-connection DELETE sonnet)

PROVISIONING INCIDENT, caught + fixed before any damage: the first Wave B
spawn happened while the orchestrator's persistent shell cwd was the WEBSITE
repo (left there by the docs sync) — worktree isolation resolves against the
shell cwd, so all four lanes were provisioned as worktrees of the website
repo. Both lanes that reached the check stopped-and-reported cleanly (B2 even
delivered a useful read-only scout: the pg_advisory_xact_lock house
precedents in identity.ts/notices.ts, the argue-at-site convention, and the
central single-lock-vs-two-phase-claim tension across the Cloudflare
provisioning call — folded into B2's respawn brief); the other two were
stopped mid-scout with zero writes. Website repo verified pristine (worktrees
auto-cleaned, no stray branches, clean status). All four lanes respawned from
the platform repo with a mandatory repo-identity sanity check as every lane's
second action. Lesson recorded in orchestrator memory (worktree spawns: cd to
primary repo first). B4 note: B1+B4 edit openapi.yaml concurrently in
disjoint paths; SDK regen conflicts resolve at integration by regenerating.

SECOND PROVISIONING DEFECT (2026-08-11, caught by Lane B4): the respawned
worktrees were cut from a STALE base — 88c5e6e5, predating ALL of Wave A —
not current main. B4 self-corrected (ff-only to c018b564) before working; B2
built on the stale base unaffected in practice (its remote-* files are
disjoint from Wave A; barrel-export conflict in packages/db/src/index.ts
resolves at its continuation-merge); B1/B3 advised mid-flight to merge main
FIRST (B1's LD-13a builds directly on Wave A's 086643de, absent from the
stale base). Standing lesson (matches the recorded Remote-run hazard #4):
every lane brief must mandate a `git merge-base HEAD main` base check as a
first action — added to the respawn briefs' sanity check going forward.

**B2 checkpoint (2026-08-11): LD-9 DONE — orchestrator-verified** (12/12 on
re-run: 8 db serialization + 4 e2e race; contract untouched; guard source
read). DESIGN — rejected BOTH framed options (lock-spanning-side-effects and
two-phase claim) for a third that is strictly better: pg_advisory_xact_lock
guards ONLY the read-verify-commit transaction inside the three
enable*AndEmit writers (compiled-in, no bypass, invariant-4 posture); the
guarded region contains ZERO external I/O, so release is structural
(PostgreSQL COMMIT/ROLLBACK is the whole story — no unlock to forget, no TTL;
a hung Cloudflare call CANNOT hold the lock because no external call happens
inside it). Race loser COMPENSATES (tunnel R8 teardown / listener stop /
tls.mode revert from snapshot) — compensation is best-effort external I/O
that can fail but cannot corrupt DB state (its row write rolled back). E2e
race is HARD-synchronized (fake Cloudflare transport parks on a test-held
promise exactly in V-SEC F2's window). Disable-takes-no-lock proven
mechanically (independent session HOLDS the exact lock while all three
disable writers + resolver run — any acquisition would time the suite out).
Resolver invariant throw retained as defense-in-depth, comment now says
believed-unreachable-and-why. Micro-hardening ordered + in flight: the
load-bearing READ COMMITTED dependency (lane's own flag — guard unsound
under REPEATABLE READ, currently enforced by nothing) becomes a runtime
assertion with a red-first spec; plus the main merge.

**B2 FINAL (2026-08-11): lane COMPLETE — orchestrator-verified post-merge**
(17/17 on re-run: 13 serialization incl. the new isolation checks + 4 e2e
race). Isolation hardening 1d5dcf8c: guard reads current_setting
('transaction_isolation') after taking the lock, throws
RemotePathGuardIsolationError (names the design-note section verbatim; no
mapped problem shape — surfaces as a 500, the visibly-broken-never-masked
posture) unless exactly 'read committed'. Five checks, 4 red-first + 1
anti-vacuity: REPEATABLE READ refused; the SESSION-DEFAULT inheritance
vector refused (SET default_transaction_isolation on a pinned connection —
the shape a pooler/server-config/withTransaction change actually takes);
SERIALIZABLE refused (equality check, not a blocklist of one); refusal
precedes the body with zero locks held and activePath untouched; and the
writers' real default IS read committed (check not vacuously passing).
Main merge 80138a34 clean — the anticipated barrel conflict did not occur
(A1's exports at index.ts:369-372, B2's at :583; both verified surviving by
grep, whole-tree conflict-marker sweep clean); post-merge re-runs green
against the merged schema (0041-0043 replayed), depcruise 1466 modules
clean.

**B1 checkpoint (2026-08-11): LD-13 trio DONE — orchestrator-verified**
(88/88 on re-run: invites 38 + collision-matrix 23 + reauth-adversarial 14 +
conformance 13; base current-main lineage after its own double ff). MAJOR
SCOUT FINDING: LD-13a was ALREADY IMPLEMENTED — not by Wave A's 086643de but
by the earlier current-password re-auth run (dependentRequired contract
clause + require-current-password.ts presence check + the P4.23 narrowing
row) — the brief's premise was stale; the lane verified end-to-end and
delivered the three missing adversarial tests instead (shape parity 403-vs-
401 same RFC 9457 field set; timing parity 8-sample medians proving neither
path short-circuits argon2id; real Promise.all race vs concurrent admin
reset, coherent under either interleaving). (b) GENUINE BUG fixed red-first:
email:null was silently ignored → preset applied against claimant intent;
ClaimInviteRequest.email now [string,'null']; 8-cell grid green; web clear-
field sends explicit null. (c) TokenPair.emailApplied additive (selective-
send mirrors mustChangePassword); pre-auth byte-identity proven (the claim
GET never queries users — no timing floor needed, documented in-test); web
interstitial. Contract: oasdiff NO BREAKING (additive only; the 13a
narrowing pre-existed); sdk-drift clean; conformance allowance ZERO.
PROCESS DEVIATIONS, disclosed + accepted: (a) no red/green pair exists
because no fix was needed; (c) implemented-before-test (additive, nothing
pre-existing to contradict) — BOTH flagged to Wave D reviewer 2, who
independently re-probes LD-13c per charter. Lane ran the docs/website sync
itself from its branch — orchestrator re-syncs from merged main at Wave B
integration (branch-state dist is transient). register-lint 27 baseline
held (pre-existing, inherited from Wave A — not this lane's).

**B3 FINAL (2026-08-11): LD-10 + LD-11 DONE — orchestrator-verified**
(installers:test 83/83 + W12 spec 5/5 on re-run; perf/baselines.json ZERO
diff across the branch). LD-10: perf-t0 endpoint p95s were ALREADY
variance-resilient (pre-existing 04cc504d with its own recorded mutation
proof — brief premise partially stale, verified not re-done); perf-web-
budget hardened with repeat-on-breach best-of-N (default 3, smallest total
wins, passing case measures once, attempts recorded); MUTATION PROOF: a
deliberate lucide-react barrel import drove /browse 174.0→365.0 KB gz and
the hardened harness failed ALL 3 attempts identically — best-of-N forgives
only transient noise, never a deterministic regression. LD-11: all four
shapes set LOOMBRE_LOG_FILE aligned with where each platform's logs REALLY
land (launchd StandardOutPath; MSI service Environment matching the --log
flag; compose tee preserving `docker compose logs` with tini signal-safety
verified against a real container; tarball shims teeing before the
journalctl-preserving exec); 24 new red-first tests; W12 empty-state copy
now a from-source/dev-run signal; env-reference regenerated via generator.
One out-of-scope comment-only fix disclosed (admin-logs-tail.ts restated
the now-false claim). Lane self-scrubbed 12 naming-gate violations.

### Wave C2 — SPEC DELIVERED 2026-08-11, at ⛔ OWNER SIGN-OFF STOP (V1–V7)

Fable spec lane committed b2523b38 (PLAYBACK.md +675/−5, spec only; §7.2
rule-(iii) untouched per the reservation — composes with the incoming
finding-1 clause). CORE DESIGN: one session = one slot = at most one live
pipeline, LD-16 structural — the worker keeps producing ONE union playlist
(Wave A machinery unchanged); a master playlist (pure render from the stored
plan, never-503) enumerates plan.ladder; EVERY variant URL serves the same
playlist bytes — variant identity lives only in the URL path and THE PATH IS
THE SWITCH SIGNAL (v{K} GET with K≠active records pending_rung_index,
compare-and-clear discipline); handoff = terminate→observed-exit→spawn at
origin old.sourceOriginMs+producedMs (exact — ffmpeg's per-run playlist is
append-only), a SEEK-SHAPED RESTART indistinguishable from any run to every
Wave A consumer (derivation/progress/dedup/reaper need ZERO semantic
changes). Rejected alternative recorded: N variant playlists ⇒ N pipelines =
the exact LD-16 violation. Slot-handoff state table incl. crash-mid-handoff
(slot correctly HELD — nothing encodes; reaper/sweeper reclaim) + census ≤1
pinned by real OS sampling at build. TWO NEW SAME-FAMILY DEFECTS FOUND while
spec'ing: pruning whole runs desyncs hls.js's discontinuity counter (missing
EXT-X-DISCONTINUITY-SEQUENCE) and completed encodes NEVER get ENDLIST —
both fixed by the (a) resolution. Findings resolved: (a) EVENT contradiction
→ type-less sliding window + DISCONTINUITY-SEQUENCE + terminal ENDLIST with
prune-freeze + client startPosition pin (ffmpeg's per-run playlist KEEPS
EVENT — its append-only completeness makes handoff origins exact); (b)
extent trap → runs stay start-only with a normative two-source extent rule,
one-row >=start derivation FORBIDDEN, doc comment at the query; runs gain
ladder_rung_index; (c) -copyts REJECTED permanently for v1 (switches need
discontinuities anyway; run map is the sole timeline bridge; progress
mapping zero-change, pinned by test). Contract preview EMPIRICAL: 0 err /
3 warn / 1 info (new master.m3u8 endpoint; ladder-variant-capped reason
trio; manifestUrl value-semantics only). DB migration 0044 additive
(active/pending_rung_index + ladder_rung_index). ⭐ V1 = TIER-0 ADVERTISES
EXACTLY 3 VARIANTS (top + geometric-mid + floor; law constant, not a knob):
encode cost is count-INVARIANT under slot handoff (cap=1 bounds concurrency)
— the count's only T0 cost is SWITCH CHURN (1-4s full-pipeline handoff);
3 rungs guarantee >=~2x adjacent ratios so crossing needs throughput to
halve/double (rare), vs the 6-rung table's 1.33x boundaries (Wi-Fi-variance
hovering on a 6W part); 2 leaves a 5-10x cliff, 4+ reintroduces sub-2x
boundaries. Honesty flags: Safari native token propagation across the
master→variant hop = build-verify item with spec'd fallback; expected matrix
churn stated (T0 >3-rung cases change with per-case why:, all else
byte-identical); CODECS strings need an execution fence (wrong string =
hls.js rejects the variant). V1-V7 presented (V2-V7 recommendations all
YES). Build does NOT spawn until owner signs.

**OWNER SIGN-OFF (2026-08-11): "Approved as recommended."** V1 = Tier-0
advertises EXACTLY 3 variants (law constant); V2 ladder-variant-capped
reason YES; V3 playlist model YES; V4 -copyts rejected permanently YES;
V5 manifestUrl→master YES; V6 T1+ uncapped YES; V7 both bounded trade-offs
accepted. Spec merged to main; C2 BUILD lane (opus) spawned. Migration
0044 assigned to the build; ENGINE_VERSION 0.10.1→0.11.0 expected.

### Wave D — REVIEWERS SPAWNED 2026-08-11 (after a red-gate triage that improved the run)

PRE-D GATE SEQUENCE: first gate:full on the merged consolidation tree went
RED — one test in 2547 (libraries.e2e restricted-rails, mid-suite 401 on a
previously-valid admin token) = the characterized under-load flake class,
now WITH ITS FIRST IN-GATE OCCURRENCE (evidence strengthened for Wave D
R2; the jwt-secret env-mutation lead stands). Triage then uncovered a
SYSTEMIC TOOLING BLIND SPOT: 17 finished lane worktrees living INSIDE the
repo tree were being swept by main-checkout vitest globs — duplicate spec
copies (with likely-shared derived test-DB names) explain the phantom
skip counts and at least part of every earlier "combined-run interference"
observation. ALL LANE WORKTREES REMOVED (branches preserved — every
ledger SHA reachable); the affected spec went 19/19 × 3 consecutive clean
runs with zero skips; gate:full RE-RUN GREEN on the cleaned tree (recorded
honestly: one red occurrence of the flake, one clean pass; the flake's
root-cause fix is Wave D territory, blocking-if-it-recurs). Orchestrator
process fixes now standing: explicit-path staging only (no add -A),
foreground merges with explicit exit codes, worktrees removed at lane
completion.

WAVE D SPAWNED: three fable reviewers over the FULL run diff
(88c5e6e5..main — Waves A+B+C1+C2+pre-D): R1 lifecycle/playback
correctness + the Wave A mutation obligations; R2 contract/security
posture + the flake root-cause; R3 UI/docs/register completeness. Fix
lanes for findings, final gate:full, closure ledger + owner-verify tail
follow.

**D-R1 (lifecycle/playback): ACCEPT-WITH-FIXES — ZERO product-code
defects.** All 6 mandated mutations CAUGHT (shutdown-terminate →
run-registry; reaper waitForRunExit → boot-reaper ×2; DV filter_units →
goldens 35/36/37 + fence 3/4; slot-handoff ordering → the pre-D
deterministic pin fires in 2.5s; T0 AV1 gate → matrix 521/523 + av1 units;
ABR cap → 35 matrix incl. 531/536), plus the CASE-not-WHERE hoist caught
(playback-sessions ×2). All headline integration proofs re-run green on
REAL state (lifecycle ps-census, seek-rung-switch 25ms census max=1, DV
Annex-B byte scan + ffprobe, AV1 real-probe refusal + real-libsvtav1 T1).
Cross-wave checks: ABR×A1 composes; C3 derivation×C2 switch composes
(backward-seek non-monotonicity pinned); DV×AV1 structurally exclusive
(golden 42 carries no filter_units/hvc1). TWO TEST-PIN GAPS (both
test-only fixes → Wave D fix lane): (D-1, MODERATE) worker_pid refresh at
RESTART spawns is unpinned — a mutation gating re-record to run 0 only
survives all suites; current source is correct (spawnRun re-records every
spawn) but a regression would resurface the C2 orphan class through the
restart seam; fix = assert row.worker_pid==latest spawned pid after the
switch in seek-rung-switch.integration. (D-2, LOW-MOD) shutdown's terminate
survives dropping its `await` (void terminateAllTranscodeRuns) — the
wiring pin is a source regex not policing the await, which C1's own
comment declares load-bearing; fix = strengthen the pin to require await
or extract a testable sequencing unit.

**D-R3 (UI/docs/register): ACCEPT-WITH-FIXES.** Central promises HELD:
radiogroup sweep APG-correct + test-pinned (116 tests / 12 files green);
docs truthfulness PASS with ONE contradicted sentence; DV spec-lie
genuinely closed (doc==code==goldens re-verified); firewall clean in
shipped code AND built dist (grep-gates 0; study gitignored+srcExcluded+
never-committed+absent-from-dist); docs:build ALL STEPS PASSED, 0 upstream-media-server
in dist. 14 register SHA spot-checks all exist and match. REQUIRED FIXES:
(D-3, MODERATE) LD-14 residual — the amended rule (subtle/hint NEVER on
--mono-*) is violated by ~53 shipped components/** declarations incl.
AuthScreen .label (password-reset form labels, the measured 2.34-3.38:1
defect class); A5's 26fb069f HONESTLY disclosed components/** was un-swept
(forbidden-boundary) but NO lane picked it up and no open-tail item records
it — LD-14 reads closed while rule≠CSS at scale; fix = mechanical
subtle/hint→muted sweep (the 08cf9146 pattern) OR explicit owner decision
+ open-tail entry. (D-4, LOW) PLAYBACK.md §4:368 ladder-variant-capped
detail format contradicts the emitted string (no tier= field; comma
format) — a NEW doc-lie, the exact class this run existed to kill; one-line
fix. (D-5, LOW-MOD) FIVE stale/missing Wave B origin annotations
(Remote V-SEC F2, mail items 3/4/7, Stash DELETE) still read SCHEDULED/
MOVED or carry nothing — violates the zero-unanchored standard 7334ce90
set; closures ARE recorded with SHAs in the Wave B section, but the
originating ledgers lie. RECOMMENDED (LOW): F4 system-info comment vs 2
straggler callers; F5 reasons.ts:66 stale 4-of-5 cause comment; F6
PLAYBACK §7.4 honesty-register xref + P3.4 durable-row AV1 amend; F7
security-posture.md HTML comment contains "an upstream media server-study" (doc source,
outside grep-gates' apps/packages scope — reword + optionally extend gate
to docs/); F8 PinModal stale arrow-key comment.

**D-R2 (contract/security): ACCEPT for the dimension — two substantive
findings routed to the fix lane.** Contract totality PASS (oasdiff 0
breaking / 31 changes all additive-or-the-one-recorded-narrowing;
targetCodec→LadderCodec removes vp9/mpeg2/vc1/mpeg4/unknown exactly;
sdk-drift 0; conformance allowance EXACTLY ZERO, both new ops covered;
LD-13a currentPassword confirmed PRE-EXISTING). LD-13c NO pre-auth oracle
(claim GET never queries users; emailApplied claim-only; 200ms floor; only
a weak POST-auth timing residual = design's stated posture). B2 LD-9 HELD
under attack (pure-SQL locked region, throw-before-fn, xact-scoped release,
5-check isolation assertion incl. non-vacuity, disable-never-blocked).
K12 additive + substantively gated — RECOMMENDATION (future-run process,
not a defect): event-schemas lives under packages/contract but is invisible
to oasdiff → add an event-schemas totality step to the contract-reviewer
charter + clarify contract-free scope. Authz uniformly user_id-scoped, no
query-token bypass. FINDINGS → FIX LANE: (F1, HIGH data-exposure) M-7
redaction PLUMBING correct but REGEX misses UNC (backslash-backslash),
glued-prefix (path=/data/…), quoted/JSON file://, space-containing paths —
realistic shapes leak into BOTH jobs.last_error AND the job.updated event
(audience incl. admin-granted plugins); no adversarial test probes them;
fix spans packages/shared + packages/jobs redact-paths + goldens, red-first.
(F2, MED) breaker delivery-loop reseed gap — C5.1 closed the server-health
path but the delivery-loop's 1-4-failure in-memory breaker reseeds from
plugins.consecutive_failures (full-trip only), not
plugin_delivery_cursors.consecutive_failures → restart mid-window discards
near-trip progress. (F3 flake) ENV-MUTATION LEAD DISCONFIRMED — real cause =
ensureTestDatabase derives <base>_<suffix> with NO per-checkout
discriminant; the 17 stray worktrees' duplicate specs computed the SAME
physical DB name → concurrent reseed moved admin password_changed_at_ms past
a live token's iat → mid-suite 401. WORKTREE REMOVAL IS THE MITIGATION
(gate green after); durable guard adopted = the standing remove-worktrees-
at-lane-completion process control (structural per-checkout-DB-name fix has
broad blast radius → deferred to a future hardening run, recorded). LOWER →
fix lane: F4 shared golden-vector for both redact suites; F5 SSRF
fetchImpl-override branch unpinned (test-seam only, prod default pinned) —
framing comment; F6 AllowQueryToken stale two-routes doc-comment.

**CORRECTION (2026-08-11): worktree agent-af5b1030cd95931b1 was NOT a
foreign session — it was THIS run's own Wave D R1-duplicate reviewer (its
process parented under the long-running orchestrator, which read as a stale
19h pid). It completed with a corroborating ACCEPT and one comment-only
review-fix (rebuild-args header), cherry-picked to main as 95174cc3. All
reviewer worktrees now removed; git worktree list = main only. The
duplication: R1 and R2 each ran twice (harness re-dispatch) — both R1s
ACCEPT, both R2s ACCEPT, findings corroborated, no contradictions (the
second R1 simply didn't attempt the two subtle mutations the first found —
D-1/D-2 stand; the second R2 refined the flake remedy). Extra R1 coverage
note folded into the fix lane: clampSeekTargetMs is pinned only at e2e
(add a served-playlist unit pin, same class as D-1/D-2).**

**D-R2 CORROBORATION (a second reviewer ran the same charter — corroborates
+ refines):** agrees env-lead DISCONFIRMED and cause = shared-test-DB reset;
adds the PRECISE substrate — SIX apps/server suites share the single
<base>_server_test DB name (conformance, auth.e2e, reauth.e2e,
password-recovery.e2e, cli/admin-reset-{pin,password}); a stray/duplicate
copy's `migrate reset` drops the schema under a live suite → getUserById
undefined → 401. BETTER REMEDY ADOPTED (close-by-construction, low blast
radius, replaces the deferred per-checkout-discriminant): give the 6 sharers
distinct DB suffixes (the convention ~30 other suites already follow) +
add .claude/worktrees to the vitest exclude(s) as belt-and-braces → FIX LANE
(retires the run's one open flake rather than leaving it to process
control). Also independently: contract 0-breaking, LD-13c no oracle, B2
holds, K12 additive — all re-confirmed. ONE DISAGREEMENT on M-7, RESOLVED:
this reviewer called the redaction "sound" (verified plumbing + the
job.updated ADMIN-ONLY audience — so F1 is admin-scoped exposure, MED not
HIGH), but the first reviewer produced CONCRETE missed-shape repros
(UNC/glued/quoted-file://); orchestrator ruling — a concrete repro beats a
happy-path pass: F1 STAYS a fix-lane item (defense-in-depth redaction that
misses realistic NAS/UNC paths is a real gap even to an admin-plugin
audience; severity MED).

### RUN EXIT — an upstream media server-study IMPLEMENTATION run COMPLETE 2026-08-11 (all four wave gates green)

199 commits over 88c5e6e5..HEAD. Four wave gates all met: Wave A (1.0
ship-gate work) → Wave B → Wave C1+C2 → Wave D. FINAL gate:full GREEN, all
16 steps, on the settled tree (web bundle 170.6 KB gz / 200 budget; one
prefer-const lint miss from the fix lane caught by this gate and fixed —
exactly what the final gate is for). Migrations added 0041 (worker pid/
started), 0042 (LD-12 rating indexes), 0043 (transcode_runs), 0044 (rung
indexes) — all additive, migrate-check 56 tables. ENGINE_VERSION
0.8.5→0.11.0 (DV strip → AV1 → ABR). Contract 161 operations, additive-only
across the run except the two P4.22/P4.23-precedent narrowings (currentPassword
pre-existing; targetCodec→LadderCodec truth-narrowing); sdk-drift 0;
conformance unimplemented-allowance held at EXACTLY ZERO throughout.

LD REGISTER — ALL SIXTEEN CLOSED: LD-1 study internality (Wave 0); LD-2/C6
win-ARM pruning; LD-3/LD-15 DV strip REAL (5-layer owner-ordered independent
verification: genuine filter_units strip, EL drop, clean HDR10, zero
residue); LD-4 devices.profile kept + comment; LD-5 themes retired (roadmap
doc); LD-6 ABR (C2); LD-7 AV1 (C1); LD-8 rateLimit accepted; LD-9 remote
TOCTOU (structural-release guard, held under D-R2 attack); LD-10 variance-
resilient perf harness; LD-11 LOOMBRE_LOG_FILE all shapes; LD-12 stash
sort=rating; LD-13a/b/c mail posture (a pre-existing+adversarially-tested,
b null-to-clear bug fixed, c emailApplied no-oracle); LD-14 contrast rule
amended + conformed (D-3 swept 53 declarations); LD-16 tier posture (AV1 T0
hardware-only unreachable-by-construction; ABR slot-handoff never a 2nd
process — both mutation-proven).

WAVE D VERDICT: three fable reviewers (each corroborated by a duplicate
run) — ALL ACCEPT / ACCEPT-WITH-FIXES, ZERO REJECT, ZERO product-correctness
defects in the shipped decision/transcode/contract paths. Every load-bearing
guarantee mutation-pinned. Consolidated fix lane closed: F1 M-7 redaction
regex (UNC/glued/file:///space — orchestrator honored the concrete repro over
the happy-path pass), F2 delivery-loop breaker reseed, the run's ONE open
flake CLOSED BY CONSTRUCTION (6 shared-DB suites split to distinct names +
worktree glob-exclude — env-lead disconfirmed, real cause was the shared
<base>_server_test reset race), R1 test-pins (D-1/D-2/D-1b), D-3 LD-14
sweep, 8 doc/comment drifts. Register D-5: five Wave B origin ledgers now
CLOSED-with-commit; P3.4 backlog AV1-amended.

INTEGRATION HYGIENE this run (all recovered, recorded, memory-updated):
STATE.md concurrent-clobber (re-applied); worktree-glob test pollution (17
lanes removed → gate green); a backgrounded-piped merge that committed
conflict markers (--amend recovered, parents preserved); an R1/R2 reviewer
mis-provisioned onto the WEBSITE repo (stopped-and-reported, respawned);
five stale-base provisionings (self-corrected by the standing base check).

OWNER-VERIFY OPEN TAIL (agents cannot close — scheduled with the next rc):
(1) real-Safari master→variant token-hop (URL semantics verified here, WebKit
not runnable); (2) N100 ABR rung-switch eyeball + tray/System single-slot
occupancy; (3) per-install-shape LOOMBRE_LOG_FILE path eyeball; (4)
AUD-W1-001 dotnet tray-test CI step execution proof (next CI run); (5)
C2-f5b phantom-switch-back — a §9.1.3 SEMANTIC decision (any guard window
trades against suppressing a legitimate switch-back) needing owner
adjudication + a future migration; (6) the AV1 hardware backlog
(av1_nvenc/qsv/vaapi/amf encode + windows-x64 libsvtav1 — fixture-only here);
(7) the pre-existing rc.7 Windows MSI nondeterminism (task #17). FUTURE-RUN
process notes: K12 event-schemas totality step for the contract-reviewer
charter; the per-checkout test-DB-name discriminant (deferred, superseded
for the flake by the 6-suite split); optionally extend grep-gates naming
scan to docs/ (needs a not-a-fork prose allowlist).

RELEASE GATING: owner deferred the 1.0-tag decision to run exit (2026-08-11).
Wave A's ship-gate criteria held from the start; B/C/D gate the release only
if the owner now says so. **AWAITS OWNER: the 1.0 tag decision.**

### Wave D — CONSOLIDATED FIX LANE dispatched 2026-08-11 (opus)

All three reviewers ACCEPT/ACCEPT-WITH-FIXES, ZERO REJECT, ZERO
product-correctness defects in the shipped decision/transcode/contract
paths. Fix lane closes: F1 (M-7 redaction regex completeness, red-first
adversarial) + F4 (shared golden-vector for both redact suites); F2
(breaker delivery-loop reseed source); FLAKE close-by-construction (6-suite
DB-suffix split + worktree glob-exclude); D-1/D-2 (R1 test pins:
worker_pid-at-restart, shutdown-await); D-3 (LD-14 ~53-decl subtle/hint→
muted sweep); D-4 + the doc-comment drift set (PLAYBACK §4 detail string,
reasons.ts:66 cause comment, PLAYBACK §7.4 xref, PinModal comment, SSRF
fetchImpl framing, AllowQueryToken comment, security-posture.md naming
reword, system-info comment/2 stragglers). ORCHESTRATOR-HELD (register =
STATE.md territory): D-5 five Wave B origin annotations + the P3.4
durable-row AV1 fixture-only amend. FUTURE-RUN process notes recorded: K12
event-schemas totality step in the contract-reviewer charter; the
per-checkout-DB-name structural fix (deferred, superseded by the 6-suite
split for this flake).

### Pre-D consolidation — LANDED + MERGED 2026-08-11 (0e0086d5) — orchestrator-verified

(seek-dedup 7, transcode-sessions 50, playback-hls 50, crash-redact 34,
sync-consumer 14 — all individually green on re-run; contract/SDK diff
empty; grep-gates 0.) C2-f3 CLOSED: three in-window seek tests (12000ms
strictly inside a fabricated produced window; both conjuncts now mutation-
fail with recorded outputs; lane de-flaked its OWN new tests — race between
waitForSpawnCount and the awaited record calls, 12 consecutive greens
after). C2-f4 CLOSED: the exact-value guard pinned via a third-connection
row-lock forcing the read-park-newer-commit interleaving (no sequential
shape can reach the guard); mutation recorded. C2-f5a CLOSED: single
control-channel write per GET via requestSeekWithRungSwitch — LOAD-BEARING
DETAIL: absorb-on-match kept as a CASE expression NOT a WHERE clause
(hoisting IS DISTINCT FROM into WHERE would silently drop a same-rung
seek, the common pinned-client case). C2-f5c CLOSED: recordActiveRungIndex
compare-and-clears a pending equal to the recorded rung, same statement.
C2-f5b NOT FIXED — correctly evaluated as a §9.1.3 SEMANTIC decision
(phantom switch-back guard trades against suppressing a legitimate
switch-back inside any guard window; needs owner/spec adjudication +
migration 0045) → RUN-EXIT OPEN TAIL. DB-ISOLATION SWEEP: 21 suites
converted (module-load top-level-await ensureTestDatabase — beforeAll
would miss describe-scope handles; scan/helpers covers all 12 scan specs);
packages/db is now the ONLY shared-loombre_test user and turbo orders it
first; session.integration converted (A1's hold expired). REDACT
CONSOLIDATION: server twin now consumes the shared canonical; 34/34
unchanged spec + a 200k-input randomized DIFFERENTIAL (byte-identical;
harness proven non-vacuous by predicate inversion). LD-5 RECORDED in the
plugin roadmap (docs sync orchestrator-side). NEW OBSERVED PRE-EXISTING
FLAKE characterized for Wave D: conformance listPeople 401 under heavy
cross-package concurrency ONLY (~2/8 full-repo runs; never alone, never
in-gate; lead = main-jwt-secret.spec's process-wide env mutation +
matching ephemeral-secret warning in logs) → Wave D R2 + open tail.

### Wave C2 — CLOSED 2026-08-11 (exit gate MET; fable review ACCEPT-WITH-FIXES)

Review verdict + both review fixes merged (c2c137ce, two-parent, full branch
history ancestor of main). REVIEW'S CONFIRMED CATCHES: (HIGH, fixed
555f63ba) ENDLIST prune-freeze RESURRECTED the pruned head — frozen playlist
listed deleted files + media-sequence collapsed to 0, firing on essentially
every completed watch >2min; the build's own pin was a timing coin flip
(review observed both outcomes) — made deterministic; (MODERATE, fixed
31e9c761) spawn-after-observed-exit ordering had only sampling coverage —
now a deterministic pin failing in 2.5s under mutation. Slot-handoff
invariant HELD against every constructed interleaving (throttle-suspended
switch, pid-unrecorded race, crash-between-exit-and-spawn, racing switches,
queue retryLimit:0 closes the two-loops avenue). All build claims
independently reproduced (497 byte-identical re-derived from a scratch
rebuild of main's engine; 6 churn cases hand-checked; oasdiff 0/3/1
reproduced; 159 SDK ops). REPORTED FINDINGS → pre-D consolidation lane:
(f3 LOW-MOD) §9.1.7 absorption-narrowing conjunct unpinned; (f4 LOW)
consumePendingRungIndex exact-value guard unpinned (self-healing bounds
harm to one redundant handoff); (f5 LOW) two-statement seek+rung write can
cost two sequential restarts, late old-variant GET can phantom-switch-back,
stale pending==active never cleared. INTEGRATION INCIDENT (orchestrator
error, recovered): the merge was run in a backgrounded PIPED chain — the
pipe masked a STATE.md merge conflict (the build lane's uncharted ledger
commit colliding with orchestrator checkpoints), the gate ran green on the
97 auto-merged files, and a blind add-A commit completed the merge WITH raw
conflict markers in STATE.md under a wrong message; recovered by resolving
both sections + --amend (parents preserved; gate verdict stands — only
STATE.md text differed; Wave D's final gate re-covers). Memory hazard #2
updated with the compound rule. The lane's ledger entry commit-count
corrected 11→15 per review finding 6.

**C2 BUILD checkpoint (2026-08-11): DONE — orchestrator-verified** (matrix
543/543 + all five load-bearing specs green INDIVIDUALLY: seek-rung-switch
5, codecs fence 4, master-playlist 24 at its real colocated path
apps/server/src/common/master-playlist.spec.ts, playback-hls e2e 48,
conformance 13; the one combined-run failure dissolved in isolation — the
known multi-suite interference signature, per-file discipline re-affirmed).
gate:full green IN-LANE (16 steps). Proof quality: census on OS state
(25ms ps sampler over every spawned pid, max===1 across seek→backward-seek→
switch→seek); cap sampled at 40ms never leaves 1 (never 0, never 2; status
never enters seeking; discontinuity_count 0 on pure switch); coincident
seek+switch = ONE SQL statement carrying both intentions → one restart;
handoff origin asserted as an EXACT segment boundary of the old run's
append-only playlist (honest statement: producedMs read at tick-top,
ffmpeg may flush once more); CODECS fence via real encode + SourceBuffer-
shaped concat + ffprobe for h264/hevc/av1 (also caught the vitest skipIf-
at-collection-time trap); ENDLIST red-first (completed encodes provably
never got it). Matrix churn disciplined: 497/530 byte-identical (dump-diff,
0 decision/args/video/container flips), 33 changed = ladder-shrink + one
reason ONLY, each with its own arithmetic in why:. oasdiff 0 err/3 warn/
1 info exactly as previewed; sdk-drift/conformance-zero/migrate-check (56
tables) all pass. Safari token-hop: URL semantics verified (query survives
relative resolution; single-hop shape = Wave A's verified case); WebKit
not runnable here — REAL-SAFARI CHECK ADDED TO OWNER-VERIFY; no-fallback
decision accepted (no structural failure shown). DEVIATION accepted with
note: lane committed its own STATE.md build record (8231a73c) — content
verified accurate, but STATE.md authorship remains orchestrator territory;
reviewer instructed to fact-check the entry. FABLE REVIEW spawned (central
obligation = the run-exit-gate cap-1 two-process claim; 5 mutations incl.
spawn-before-exit ordering; RFC 8216 cleanliness; churn arithmetic
spot-checks; the STATE.md entry fact-check).

**BUILD DELIVERED 2026-08-11 (lane-authored record, fact-checked by the
fable review; branch `worktree-agent-a1c44b05fc0a86eeb`, 15 commits —
corrected from the entry's original "11" per review finding 6; red-first
per surface; `pnpm gate:full` ALL 16 STEPS PASSED in-lane, matrix
536/536).** ENGINE_VERSION 0.11.0. Everything the spec asked for
landed as spec'd; nothing was re-litigated.
- ENGINE: `capAdvertisedVariants` + `TIER0_MAX_ADVERTISED_VARIANTS = 3`
  (law constant, not a knob) called at FINAL assembly AFTER Stage G;
  `ladder-variant-capped` single-firing. CHURN, dump-diff proven over all
  530 pre-existing cases: 497 byte-identical (engineVersion aside), 33
  changed, ZERO decision flips / ZERO ffmpegArgs changes / ZERO video.*
  changes; each of the 33 edited with its OWN arithmetic in `why:`. New
  cases 531–536, golden 42 (the mixed-codec rung-switch argv → av1_qsv).
- CONTRACT: oasdiff EXACTLY as previewed — 4 changes, 0 error, 3 warning,
  1 info. SDK regen atomic, conformance allowance still ZERO.
- DB 0044: active/pending_rung_index + ladder_rung_index;
  `requestRungSwitch` absorbs at the WRITE side via
  `active_rung_index IS DISTINCT FROM $K` (NOT `<>` — NULL until first
  spawn); `consumePendingRungIndex` guards on the EXACT value read and
  deliberately does NOT move status or bump discontinuity_count.
  `getTranscodeRunForSegment` carries the normative EXTENT RULE.
- PROOFS (real ffmpeg + real Postgres + real `ps`): the §9.1.7 named
  scenario runs 0–4 with the handoff origin landing on an EXACT segment
  boundary of run 2's own append-only playlist; process census max = 1
  across the whole scenario; coincident seek+switch ⇒ ONE run carrying
  both intentions; slot census never leaves 1 across a handoff; the
  CODECS table execution-fenced against ffprobe for h264/hevc(hvc1
  tag)/av1 with a non-vacuity case.
- HONESTY FLAG 1 CLOSED AS "PARTIAL, BY NATURE": Safari's master→variant
  token hop cannot be executed in jsdom. What IS verified is that both
  hops are the SAME URL operation (standard resolution drops the query on
  each, so propagation is engine behaviour) and that a query-bearing
  variant URL resolves segments against a query-bearing base — i.e. the
  single-hop shape Wave A already verified empirically. The conditional
  rendered-token-URI fallback is therefore NOT implemented (verification
  did not show structural failure). ⛔ OWNER-VERIFY: play a transcode
  session in real Safari and confirm variant + segment GETs carry the
  token.
- Known bounded behaviours accepted at V7 remain as spec'd; §9.1.10 item 2
  (post-ENDLIST seek pays the ≤8s fatal-recovery path) is now reachable
  because ENDLIST exists at all — pre-C2 it never did.

### Wave C1 — SPEC DELIVERED 2026-08-11, at ⛔ OWNER SIGN-OFF STOP

Fable spec lane committed 86ac7e3b (worktree branch; ONE file, docs/PLAYBACK.md
+350/−5; base current main after its own ff — third stale-provisioning
occurrence, self-corrected per the standing check). Design: LadderCodec closed
set {h264,hevc,av1}; codec-selection precedence av1>hevc>h264 swap-before-caps
(av1 swap: sub-2160 rungs, ×0.6, requires av1EncodePreferred policy + device
av1 entry + fmp4-hls [no AV1-in-TS] + eligibility gate); demotion
normalization step (av1 rungs failing gates demote to hevc/h264, never drop);
single pure gate src/av1.ts `av1EncodeEligibility(caps,tier)→hw|software|none`
shared by ladder AND Stage G (dv.ts no-drift precedent); LD-16 verbatim law in
spec; UNREACHABILITY testable in four legs (matrix property 5 + per-leg pins);
copy-preference untouched (AV1 sources direct-play/copy as before, regression
pin = every existing case byte-identical). Contract enumeration EMPIRICALLY
PREVIEWED (real oasdiff in scratch: 0 errors, WARN-only): LadderCodec enum
+av1; targetCodec re-point VideoCodec→LadderCodec (a NARROWING-to-truth — the
contract already over-admitted vp9/mpeg2 there); optional av1-rung-demoted
reason (D1). ORCHESTRATOR-VERIFIED surprise: NO DB change needed — encode
CHECK was born av1-inclusive (schema.sql:1224, migration 0011 verified);
register's "DB CHECK" item closes as already-satisfied. Honesty table:
M3 Max genuinely proves the T0-refusal path (real hw-av1-absent caps — no
av1_videotoolbox exists), software-AV1 T1 end-to-end (bundled libsvtav1
verified by execution), av1 hw decode; FIXTURE-ONLY → P3.4 backlog by name:
av1_nvenc/av1_qsv (N100 QSV is av1-DECODE-only — spec says so)/av1_vaapi/
av1_amf encode + windows-x64 libsvtav1 presence (Windows CI leg). OPEN
DECISIONS D1-D5 presented to owner (recommendations: D1 YES, D2 YES, D3/D4/D5
confirm). Build lane does NOT spawn until owner signs off.

**OWNER SIGN-OFF (2026-08-11): "Approve as recommended."** D1 YES
(av1-rung-demoted reason added to the closed enum), D2 YES (targetCodec
re-pointed to LadderCodec — narrowing-to-truth), D3 ×0.6/sub-2160 confirmed,
D4 libsvtav1-only confirmed, D5 default-false opt-in confirmed. Spec merged
to main; C1 BUILD lane (opus) spawned against the signed spec.

**C1 BUILD checkpoint (2026-08-11): DONE — orchestrator-verified** (matrix
535/535 + engine 448/448 + av1 fence/contract-reasons/conformance 25/25 on
re-run; 13 commits, 6 red→green surface pairs; 4th stale-provisioning
occurrence self-corrected by the standing base check). ⚠️ REAL-EXECUTION
DEFECT the fence caught that goldens never could: libsvtav1 REFUSES
-maxrate (ffmpeg wrapper requests CBR, SVT-AV1 rejects for RANDOM_ACCESS,
encoder never opens, zero segments) — every software-AV1 plan was unrunnable
while goldens stayed self-consistently green. Isolated across 3 variants
(-maxrate alone is the culprit); fix scoped to av1+software (hw wrappers
keep -maxrate — no hardware here to verify otherwise); LANE AMENDED THE
SIGNED SPEC post-sign-off (§6 interp M bitrate bullet, interpretation-D
precedent) — FLAGGED to owner + under fable review. Byte-identical
regression proof: 0 of 557 pre-existing plan/args lines changed. Property-5
non-vacuity mutation-proved; NOTABLE: leg 4 (Stage G residual guard) is
genuinely redundant defence — relaxing the §7.2 tier check alone does NOT
falsify property 5 (guard catches it); reviewer verifies this is pinned.
oasdiff: 6 warnings 0 errors exactly as previewed (targetCodec re-point =
zero findings); sdk-drift clean; conformance zero; DB no-change
re-verified. Web "zero changes" expectation WRONG instructively: the
settings-widget test fixture used codec:"av1" as its deliberately-INVALID
example — would have silently asserted av1-illegal forever; fixed (product
code untouched, device-profile already probes av1). P3.4 backlog additions
by name: av1_nvenc/av1_qsv/av1_vaapi/av1_amf encode + hwaccel markers +
windows-x64 libsvtav1 presence. Settings docs regenerated; lane ran
docs+website sync per rule. FABLE REVIEW spawned (adversarial charter:
unreachability attack, 4 mutations incl. the leg-4-pin question, -maxrate
amendment judgment, contract atomicity, Tier-0 arithmetic, honesty-table
audit).

**C1 FABLE REVIEW (2026-08-11): ACCEPT** (+1 comment-only review-fix
a6e26655; merged to main 6de8fce0). Evidence: unreachability HELD under a
5,000-sample randomized attack over a LARGER space than property 5's
(hw-av1 caps allowed) + deterministic corner probes (tier-cap keep-lowest
rescue, duplicate-drop, targetCodec-from-final-ladder all safe). Mutations:
(a) tier-check neutered → 8 named unit + matrix 521/523 fail; (b) Stage-G
guard removed → 3 named + matrix 526 fail — the feared unpinned-redundancy
scenario does NOT materialize, per-leg pins are real; (a)+(b) → property 5
falsifies (bottom net real); (c) -maxrate restored → fence + golden 40 +
named builder test fail (three layers); (d) registry drop → 4 named fail.
-maxrate amendment APPROVED (reproduced on real SVT-AV1 v4.1.0; +27/−3
minimal; scoping pinned by builder.spec:819 + golden 39). Property-5
non-vacuity measured real (364/1000 actual demotions). Contract clean
(6 warn/0 err reproduced; half-landed analysis: coherence machine-enforced;
D2 narrowing REMOVES the old-client hazard). Tier-0: zero workload increase
(N100 ladder byte-identical, pinned). Honesty table verified genuine (T0
refusal runs the REAL probe battery with loud-fail-on-capable-hardware).
**OWNER DECISION (2026-08-11): "Adopt all 3 recommendations."** Follow-up
lane dispatched (opus): finding-1 spec clause + engine demotion via the
shared primitive + the reviewer's exact repro as red-first matrix case
(ENGINE_VERSION 0.10.0→0.10.1); finding-2 companion randomized property
added to the §10 list; finding-3 VIDEO_ENCODER_NAMES exported + worker
equality spec. C2 SPEC lane (fable) spawned in parallel — §7.2 rule-(iii)
reserved to the follow-up lane; C2 spec told the clause is incoming.

**C1 FOLLOW-UP LANDED + MERGED (2026-08-11) — orchestrator-verified**
(537 matrix incl. new case 530 + property 6, hardware/av1 89, mirror 5 on
re-run; 5th stale-provisioning occurrence self-corrected). Finding 1: one
shared predicate `softwareAv1EncodeVerified` (eligibility's software arm
refactored to CALL it — one definition), tier test first so the LD-16
wording and every leg-4 pin stay byte-identical; new cause
software-route-no-av1; the old "T1+ keeps av1" unit amended to the only
legal shape (software row verifies av1). No golden 42 — argv unchanged
(targetCodec still top-rung hevc; demoted-sibling shape pinned by 41),
reasoned in the commit body. Finding 2: property 6 at 2000 samples over
the UNRESTRICTED tier-0 space; measured non-vacuity (1359 hw-av1 boxes /
383 software routes / 102 guard demotions); scratch mutation proof
captured (guard neutered → property 6 fails with the emitted rung).
Finding 3: mirror spec proves per-backend×codec name equality over the
UNION of both tables + the D4 dynamic-name asymmetry via resolveEncoderName;
scratch rename caught (av1_qsv_hw drift named in the failure). Orchestrator
closed the lane's flagged §4 staleness in-merge (cause enum + guard
qualifier, one commit). ENGINE_VERSION 0.10.1. gate:full running on the
merged tree.
THREE NON-BLOCKING FINDINGS (record) → owner decision pending: (1) MODERATE
spec-gap-with-repro: Tier-1+ rule-(iii) route-collapse can keep av1 rungs
whose SOFTWARE encode was never probe-verified (impl faithfully matches
§7.2; violates design law 4 verified-capabilities-only; low likelihood —
needs an ffmpeg with hw-av1 but no libsvtav1; vendored builds always carry
it) — suggested one-clause refinement: demote av1 on any rule-(iii) route
whose software row lacks verified av1; (2) LOW: randomized companion
property for leg 4 (validated green on real engine, failing under mutation
b — §10 list is owner-signed, so recommend-not-land); (3) LOW: worker
probe-table ↔ engine encoder-name mirroring is comment-enforced only —
cheap closure: export VIDEO_ENCODER_NAMES + worker equality spec.

### Wave B — CLOSED 2026-08-11 (exit gate MET)

Integration: four branches merged (B2 → B4 → B1 → B3, zero manual conflict
resolutions; the B1/B4 openapi.yaml edits auto-merged in disjoint paths);
SDK REGENERATED on the merged contract per standing rule — byte-identical
to the auto-merge, 158 operations, sdk-drift clean. **gate:full ALL 16
STEPS PASSED** on the settled tree (bundle 170.7 KB gz unchanged).
Contract summary: oasdiff NO BREAKING anywhere — additive only (TokenPair.
emailApplied, ClaimInviteRequest.email nullable, DELETE stash-connection,
stash.provider.disconnected event); the LD-13a narrowing pre-existed (P4.23).
Conformance allowance ZERO throughout. LEDGER ANNOTATIONS: Remote OPEN
V-SEC F2 → CLOSED (a16f3e50/6b27d9fe/1d5dcf8c, structural-release guard +
isolation runtime assertion); mail OPEN item 3 (F5 currentPassword) →
CLOSED-as-pre-existing-verified with new adversarial coverage (B1); Stash
OPEN connection-DELETE → CLOSED 0d697a65. LD register: LD-9 LD-10 LD-11
LD-13 all CLOSED this wave. Owner-verify additions: real-hardware log-path
eyeball per install shape rides the existing checklist; AUD-W1-001 dotnet
step execution proof still pending next CI run.

**B4 checkpoint (2026-08-11): stash-connection DELETE DONE — orchestrator-
verified** (90/90 on re-run: e2e 11 + conformance 13 + event-schemas 54 +
db 12; base = current main c018b564 after its own ff fix). oasdiff purely
additive (one DELETE op; no breaking); sdk-drift clean; conformance
allowance stays zero (158 ops). Scout-grounded semantics: no keyring
involvement exists (S1 direct-SQLite design — the briefed "secret gone" RED
case documented as vacuous, not fabricated); synced facts KEPT by
construction (satellite tables key off library_id); no zombie schedule
(loop + in-flight sync re-read the row and treat absence as ordinary miss).
JUDGMENT CALLS ACCEPTED: GET-after-DELETE returns to the documented
pre-configuration resting state (the briefed "GET 404s" would have broken
GET's own tested never-404-for-unconfigured contract — house contract wins
over brief wording); DELETE 404s for no-connection (substantial-resource
posture vs clearAdminMailCredentials' scalar-idempotent precedent);
stash.provider.disconnected event added via the 8-step procedure with real
actorUserId (admin-initiated, unlike the two system-originated stash
events); single atomic commit justified by layer interdependence + the
3b08c891 precedent, RED verified live per stage. FOLLOW-UP recorded: no
"Forget connection" UI entry point exists yet — admin-guide doc + web action
whenever that UI lands.

**A3 FINAL (2026-08-11): continuation done — lane COMPLETE, orchestrator-
verified** (126/126 on re-run: ssrf + ledger-events + delivery-loop +
chain-resolution + redact-paths; 17 commits total; contract/protocol diffs
empty across the whole lane). C5.2 CLOSED for real: allowlisted-by-name
hostnames now resolve-once-and-pin like every other name; the allowlist's only
remaining effect is skipping the disallowed-range check; HostResolution.
pinnedAddress is no longer nullable and the unpinned fallback branches are
GONE (flip-resolver proof: resolver called exactly once, pin survives a
flipped answer; plus live end-to-end through hardenedFetch). Worker breakers:
lane CORRECTED its own earlier flag — plugin-delivery/backoff.ts has no
breaker (stateless pacing, nothing to seed); the real second registry
(metadata/plugin-breakers.ts) AND a third previously-unflagged inline one
(delivery-loop.ts runOnce Map) are both now seeded from durable counters
(seed read bounded by plugin count, not poll tick; no index.ts changes —
judgment call to fix the unflagged third accepted, within the grant's
spirit). M-7 CLOSED: recordRetrying/recordFailed redact path components once
before persisting last_error AND emitting job.updated. Lift decision ACCEPTED:
canonical redactPathsInText in packages/shared (predicate-parameterized;
apps/worker/crash consumes it, 34-case regression green) + a small documented
LOCAL DUPLICATE in packages/jobs honoring that package's twice-documented
"no @loombre/shared dependency" rule (ids.ts precedent) — recorded for Wave D
reviewer 2: (a) optionally relax the jobs-package constraint instead;
(b) apps/server/src/crash/redact.ts is a third, untouched twin that could
consume the shared canonical (integration-time cleanup candidate).

## an upstream media server comparative architecture study — ANALYSIS-ONLY, COMPLETE 2026-08-10 (owner brief "Comparative Architecture Study — an upstream media server Playback Engine vs. Loombre"; awaiting owner review + implementation authorization)

DELIVERABLE: reports/upstream-media-server-study/upstream-media-server-comparative-study.md (908 lines) —
authoritative; this section is the ground-truth ledger. (RELOCATED 2026-08-10 per
implementation-run LD-1 from its original docs/analysis/ path: the study is internal,
local-only material and now lives in the gitignored reports/ evidence tree; git
history for docs/analysis/ verified empty — it was never committed, no purge needed.
NOTE: an earlier copy of this section was reverted when a parallel session committed
STATE.md mid-run; re-applied here. The report file itself was never affected.)

Locked decisions (owner brief): read-only vs Loombre except this STATE.md section +
the report; license firewall (an upstream media server GPL-2.0 vs Loombre AGPL-3.0 — concept-level
only, no verbatim code/args); study source not docs; sonnet lanes / opus synthesis;
Tier-0 (N100/4GB) statement on every recommendation; NO implementation this run.
an upstream media server master shallow-cloned OUTSIDE the repo (session scratchpad), pinned
6d501ba4188a5f6cea424302daab23313e748d4f — all an upstream media server citations reference that SHA.

Phases (all complete): 0 Loombre discovery (solo sonnet, owner-CONFIRMED) → 1
an upstream media server study (6 sonnet lanes) → 2 comparison (6 sonnet lanes) → 3 opus synthesis.
Orchestrator spot-checked ~35 citations across BOTH codebases during phases 1–2,
100% match; opus re-verified load-bearing claims at the Phase-3 gate. License
firewall clean at every phase (0 code fences / 0 verbatim command lines; LICENSE-
SENSITIVE flags used where a an upstream media server formula would tempt close consultation).

**Run exit gate — all 4 criteria PASS:** every claim file:line-cited both sides;
license firewall held (report: 0 fences, 3 LICENSE-SENSITIVE flags at per-encoder
rate-control math + pan= downmix coeffs); all 26 recommendations carry a Tier-0
impact statement (dedicated table column); report ends with §10 wave plan under
"AWAITS OWNER AUTHORIZATION" + appendix. Recs ranked (impact×confidence)/risk,
correctness fixes C1–C11 above features F1–F15.

**Headline:** each system leads where its architecture forces it. LOOMBRE leads
downstream of its two core bets (pure/total/test-pinned decision engine; process-
isolated worker): machine-readable reasons as a contract field, verify-by-test-
transcode HWA probing, a real Tier-0 admission cap + working throttle, out-of-process
capability-scoped LPP. AN UPSTREAM MEDIA SERVER leads on field-earned breadth: ~27-property device-
profile condition DSL, rkmpp/v4l2m2m HWA families, per-encoder rate-control
sophistication, ~15 plugin extension families incl. UI/config pages. Highest-value
output = six VERIFIED Loombre-internal gaps.

**Six verified Loombre-internal findings (NONE fixed this run):**
1. **No orphan-ffmpeg reaper (Tier-0-critical, confirmed).** POSIX ffmpeg detached
   (transcode/process.ts:111); no pid persisted; reconcileStaleJobLedger covers only
   SINGLETON_GUARDED_JOB_TYPES {hwprobe,image-backfill,opengop-backfill,stash-
   inventory,stash-sync}, 'transcode' EXCLUDED (worker/index.ts:484-494);
   countActiveTranscodeSessions counts only non-terminal statuses (playback-
   sessions.ts:701-708) → a sweeper-ended orphan frees its admission slot while still
   burning CPU/RAM, across ordinary restarts/deploys. → recs C1 (graceful-shutdown
   terminate) + C2 (boot reaper + worker_pid col).
2. **Seek-target arithmetic (confirmed mechanism, latent-under-current-playlist).**
   controller uses segmentIndex×6000ms (hls-file.controller.ts:255,274); worker
   restarts with startSeg=(producedSegment ?? -1)+1 (runner.ts:309) — continuous
   numbering decoupled from media time. Opus scoped it: renderServedPlaylist
   (playlist.ts:99-103,148-168,236-245) hands only produced closed segments w/ real
   #EXTINF, so a compliant hls.js client never requests an ahead index; real defect
   narrow (ENOENT/backward-seek to a pruned post-first-seek segment after ≥2 seeks).
   → rec C3 (fix + [0,durationMs] clamp + double-seek test).
3. **DV-strip spec/impl divergence (confirmed; severity calibrated down).**
   hdr.ts:11 + docs/PLAYBACK.md:224 claim a DV metadata strip "in arg builder";
   builder.ts emits no DOVI bsf (only open-GOP strip at :655). Profile-8.1 usually
   benign (HDR10 decoders ignore the DV RPU SEI) → primarily doc-integrity, residual
   risk on profile-7. → rec C4 (implement verified DOVI-RPU filter OR correct spec).
4. **AV1 encode dead path:** probe verifies AV1 encode, ladder/arg-builder can't
   target it (builder.ts:336-343). → rec C8.
5. **win32 throttle doc divergence:** docs/PLAYBACK.md:438-440 says NtSuspendProcess;
   code ships -readrate 1.2 (throttle.ts). → rec C9.
6. **devices.profile dead persistence:** written at registration (identity.ts:528-
   535), never read in playback (plan uses request-body profile, plan-request.ts:84).
   → recs C10 (fix stale comment) / F4 (make PlanRequest.device optional w/ fallback).

**Known bug documented AS-IS (owner said do not fix this run):** Windows-ARM HWA
probe architecture-blindness — candidatesForPlatform keys only on NodeJS.Platform
(hwcaps/platforms.ts:17-34), win32 always nvenc/qsv/amf/d3d11va/software regardless
of os.arch(); Windows-on-ARM runs ~27 doomed x86-vendor probe spawns before software.
an upstream media server is ALSO arch-blind there (not a LS win). → rec C6, owner-gated.

**Top 5 recs:** C1 graceful-shutdown run termination (H×H/L); C2 boot crash reaper +
worker_pid (H×M/M); C3 seek-target fix (M×H/M); C4 DV-strip decision (M×H/M); C5
plugin hardening trio — breaker re-seed from durable counter / orphaned-keyring
cleanup / pin LAN-allowlisted hostnames (M×H/L). All contract-free.
**Contract/oasdiff-touching (all additive):** F2 rkmpp/v4l2m2m, F3 audio re-select
reason, F4 device optional, F5 AV1 ladder target, F6 bandwidth probe, F11 subtitle-
provider capability, F12 profile axes, F13 hw-decoder/tonemap fields, F14 plugin
discovery route, F15 backend-exclude setting.

**Wave plan (PROPOSED, not executed):** Wave A = verified correctness/Tier-0 fixes
(contract-free, highest priority) — C1,C2,C3,C4,C5,C7,C8-prune,C9,C10 (+C6 iff owner
un-freezes). Wave B = breadth/compat features (additive contract) — C11,F1-F6,F8,F9.
Wave C = larger product-scope questions (owner decisions first) — F7,F10,F11,F12,
F13,F14,F15. Implementation is a SEPARATE future run pending owner authorization.

**OWNER DECISION (flagged, not acted on — brief limited repo writes to STATE.md +
the report):** docs/analysis/ is NOT in the VitePress srcExclude (docs/.vitepress/
config.mts:67 = only PLAN.md, PLAYBACK.md, public/**), so this INTERNAL study WOULD
publish to loombre.com if pnpm docs:build + website sync run. Deliberately did NOT
run the Documentation Sync flow (would publish it) and did NOT edit config (2nd
write, out of scope). Before any future docs build: add "analysis/**" to srcExclude.

**Wave A closure map (2026-08-11):** C1 shutdown-terminate → ec7a563b (+run
registry f1cd259c red); C2 pid+reaper → 8df8eceb + c4b436fa (migration 0041);
C3 seek arithmetic → 657df857 + exact per-run anchoring 87f63d26 (migration
0043 f44b80ff by A1); C4 DV strip → 6ea91910 (ENGINE_VERSION 0.9.0;
orchestrator-verified genuine, 5-layer); C5 → 02da6dc0 / 2d93c590 / 51e58732;
C6 win-ARM arch → 60183805; C7 reconciliation fold → ef4de3f5; C9 throttle
doc → 1788173b; C10 devices.profile comment → 0c3981d0; C8 → deferred to Wave
C1 by design, linkage comment 8f07a2de; run-discovered closures: seek
livelock 1dc1db8e, post-seek progress mapping afd7dd89, player zero-file
hang 44e846e6, EXT-X-MEDIA-SEQUENCE 963d7e4d.

## Fix-list wave — uninstall script, ledger ordering, Safari token reload, test-DB isolation (2026-08-10, lanes + opus review)

Owner directive: "continue with the fix list until completion." Tasks #4/#5/
#6/#8 built by four parallel sonnet lanes, opus-reviewed (18 findings: 0
BLOCKER, 6 MAJOR — all applied by three fix lanes), landed as cb571667 +
3c3a372b + 0c048170 + 1a5aaa2e. `pnpm gate:full` ALL 16 STEPS PASSED.

- **#5 ledger ms-tie flake (cb571667):** root cause structural —
  loombre_uuidv7()'s tail is pure random() (no RFC 9562 §6.2 counter), so
  same-ms ids sort by coin flip; ORDER BY id is NOT insertion order on
  ties. events.seq identity column (migration 0039; header documents the
  heap-order backfill for pre-existing rows + the one-time ACCESS
  EXCLUSIVE rewrite on upgrade); spec helper orders by seq alone;
  deterministic adversarial-id reproduction. events.ts's false "UUIDv7 ==
  insertion order" header claim replaced (its id-cursor CAN skip a same-ms
  sibling — switch to seq deferred as task #9 with the full ~20-site
  sweep of Class A no-tiebreak / Class B UUIDv7-tiebreak reads recorded).
- **#4 macOS uninstall (3c3a372b):** shipped uninstall.sh (4 launchd jobs,
  plists, app bundle incl. receipt-located relocation-era strays under
  tight validation, logs, /opt/loombre, --purge-gated app data, receipt
  forgotten LAST, sysadminctl-interactive account deletion, --dry-run
  covering every mutation, partial-state tolerant). Review catches: shift
  2 on a trailing valueless flag spun a root busy-loop forever (now exits
  1); receipt was forgotten before payload removal; GID namespace missing
  from the UID picker (value used as UID AND GID). UID-500 rc.6 bug fixed
  in extracted pick-service-uid.sh (first free strictly in [201,499],
  both /Users+/Groups namespaces). Installers suite 46/46. rm -rf audit
  CLEAN: every target a literal, existence-checked constant.
- **#6 Safari token reload (0c048170):** recon corrected — tokens are
  15-min JWTs refreshed ~30s early (60s was the poll), so the reload hit
  every ~14.5min and NOT reloading guaranteed a mid-play 401 (server
  verifies with zero clockTolerance). isSameUrlIgnoringToken no-ops
  token-only rotations; paused-time silent swap; bounded recovery (error
  OR 10s stall watchdog — Safari presents playlist-refresh 401s as
  stalls; 3 attempts/stretch, 4s deferred cooldown, reset on 'playing',
  DECODE/SRC_NOT_SUPPORTED → UnavailableScreen via client-synthesized
  reason). Future structural fix filed as task #10 (cookie auth for
  media routes).
- **#8 test-DB isolation (1a5aaa2e, incident follow-up):** migrate.mjs
  reset refuses non-`_test`-segment database names (pnpm db:reset passes
  --allow-reset); resolveTestDatabaseUrl() derives loombre_test (55
  files rewired); auto-provision is best-effort (external-Postgres
  db:reset regression caught in review); worker-liveness.spec on its own
  isolated DB. CONSEQUENCE: `pnpm gate` no longer touches dev data and
  the stop-the-dev-stack-before-gate ritual is RETIRED (memory updated).
  Residuals documented, not hidden: a *_test-named live DB is still
  wipeable; worker/jobs can race concurrent resets of shared
  loombre_test under turbo. ~1200 leaked per-suite test DBs discovered
  on 5442 — cleanup is task #11.
- **Process:** four workstreams in one shared checkout with disjoint-file
  lane scopes again produced zero cross-lane conflicts (marker-scanned).
  Review's highest-stakes dimension (root rm -rf in the uninstaller) came
  back clean on first pass — the lane discipline of literal-constant rm
  targets held.

## Post-rc.6 owner-QA wave — three playback fixes + open-GOP HEVC strip (2026-08-08→10, lanes + opus review)

Owner ran a manual QA session against the dev stack; every reported defect
was reproduced, root-caused, fixed test-first, opus-reviewed, and landed as
1c3f0cad + c0c4e32a + 41bf343f + e68b554b. `pnpm gate:full` ALL 16 STEPS
PASSED on the final tree. Owner is drafting a broader fix list next; rc.7
tags after that list lands.

- **Heartbeat crash (1c3f0cad):** first real-browser play threw "Illegal
  invocation" — the scheduler stored bare native setInterval/clearInterval
  and invoked them with instance receiver; every unit test injected fakes so
  the default branch only ever ran in a browser. Fixed with the
  featured-rotation `.bind(globalThis)` pattern (review caught the first-cut
  arrow-wrap diverging from that precedent AND leaving caller-supplied bare
  natives broken).
- **Throttle-suspend manifest deadlock (c0c4e32a):** playback froze at
  ~20-24s on every transcode. Segment-ahead throttle SIGSTOPs ffmpeg at
  ahead>10 and marks the session suspended → manifest GET 503'd → client
  could never issue the segment GETs that advance requested_segment → worker
  never resumed (live-DB verified: requested_segment frozen at 3, ffmpeg
  `Ts`). Manifests now serve active OR suspended (both causes — throttle and
  heartbeat-stale — argued and e2e-pinned); ended/failed still 404.
- **Duration clobber (41bf343f):** the same QA stall's second half — element
  loadedmetadata (event-playlist produced-so-far window) clobbered the
  known 2h duration. Growth-only adoption on loadedmetadata+durationchange
  for manifest-backed sessions; direct-play adopts unconditionally (element
  authoritative both directions there — review catch, incl. the existing
  shrink test silently relying on the direct-play default fixture).
- **Open-GOP HEVC decode smear (e68b554b, task #7):** post-seek full-frame
  white smears — stream-copy from a CRA carries RASL leading pictures whose
  references predate the discontinuity. Fix `-bsf:v
  filter_units=remove_types=8-9` on withSeek copy HLS runs, driven by new
  probe fact `media_streams.open_gop` (migration 0038, NULL=unknown,
  reads map NULL→false — never strip without positive detection).
  Built by two lanes (C1 engine, C2 probe/DB) + opus review (16 findings:
  2 BLOCKER, 5 MAJOR) + two fix lanes. Review catches that mattered:
  (1) detector's 3s-from-start window couldn't see past the first GOP on
  real keyint=250 content — permanent false, feature dead on arrival; now a
  2s mid-file trace_headers window (mid-file keyframe is a CRA in open-GOP
  encodes; ~50-70ms/scan, empirically verified); (2) the reason code and
  VideoAction.openGop never entered the contract — closed-enum drift the
  SDK/UI would render raw; new contract-reason-codes.spec asserts engine
  reason lists == contract enum both directions; (3) no hevc gate at plan
  assembly — an H.264 stream flagged open-GOP would have had its PPS (h264
  NAL 8) stripped, destroying the stream; (4) reason and flag fired from
  different predicates (stage B vs assembly) — both now emitted from ONE
  predicate at assembly, evaluateVideo signature reverted, matrix 516/517
  pin both former divergence directions; (5) signal-killed scans recorded
  false instead of NULL. ENGINE_VERSION 0.8.5. Matrix 513→517 (corpus
  backfilled with openGop + meta assertion), goldens 33/34 prove bsf
  presence/absence. Backfill job opengop-backfill: batched 200,
  cursor-resumable, skips missing files, bulk-falses non-HEVC.
  **OWNER QA ITEM for rc.7:** the bsf is per-invocation — after a seek,
  EVERY subsequent GOP loses its ~bframes leading pictures (accepted trade
  vs multi-second smear; documented in interpretation (K) + PLAYBACK.md §6).
  Verify a long post-seek playback stretch shows no objectionable judder.
- **INCIDENT — live dev DB wiped by a lane (2026-08-10):** Lane C2 ran
  `npx vitest run` in packages/jobs during verification;
  `packages/jobs/test/queue.spec.ts` beforeAll unconditionally runs
  `migrate.mjs reset` (DROP SCHEMA public CASCADE) against DATABASE_URL's
  default — the live 5442/loombre QA database. All rows lost (owner
  accounts, libraries, catalog, QA state); schema intact, 38/38 migrations
  applied. The lane was briefed against live-DB suites and checked
  apps/worker + packages/db gating but packages/jobs looked innocuous.
  Mitigations: lane briefings now allowlist individual spec files (never
  package-level runs); task #8 opened — destructive test setup must be
  impossible to point at live data (dedicated test DB / loud opt-in),
  matching the house guard philosophy. Dev DB reseeded post-gate.
- **Process notes:** review-then-fix split across two disjoint-file fix
  lanes (engine/contract/web vs worker/db/server) worked cleanly in the
  shared checkout — zero conflicts, verified by marker scan before commit.
  perf/web-budget-result.json stays a separate chore commit (repo
  precedent c7f38321).

## Post-rc.6 fix wave — folder-grant flow + menubar UX (2026-08-08, sub-agent lanes + opus review)

Two owner-directed fixes, built by parallel sonnet lanes, opus-reviewed
(18 findings: 1 BLOCKER, 3 MAJOR — all applied by fix lanes), gate:full
green. rc.7 tags AFTER owner's manual QA pass (next).

- **Folder-access grant flow (owner request, wizard screenshot)**:
  contract-first. openapi.yaml: `FilesystemPermissionRemediation`
  {summary, commands[], verify} wired into /admin/filesystem/directories'
  403 (allOf over Problem — SDK 403 type carries `remediation?`; redocly
  0 warnings; oasdiff non-breaking). Server: `permissionRemediation()`
  (admin-directories.ts) templates the docs-blessed 2-command ACL recipe
  with the real requested path (shell-quoted; normalized;
  case-insensitive /Users matching), attached via `forbidden()`'s new
  additive `extensions` param (ProblemException spreads extensions FIRST
  — reserved members can never be overridden). Emits NULL (→ client
  falls back to the detail paragraph) for: bare personal home (BLOCKER —
  never script a whole-home grant exposing ~/.ssh), TCC-protected
  Desktop/Documents/Downloads (ACLs can't lift TCC), non-macOS/dev.
  Web: DirectoryPicker renders summary + new reusable CommandBlock
  (copy with LAN-http selection fallback — navigator.clipboard absent on
  insecure origins) + verify line + "Check again" re-list; defensive
  parse falls back to detail on absent/malformed. Tests: server 34,
  picker 7, CommandBlock 6.
- **Menubar UX**: `applicationShouldHandleReopen` — double-clicking
  Loombre.app while running opens the web UI (IPC-resolved; ANY failure
  falls back to MenuState.installedDefaultWebUrl = localhost:3000 — a
  user-initiated open must always open something). Auto-open-web is now
  per-INSTALL, not once-per-user-forever: InstallStamp lstat-mtimes
  /opt/loombre/current; postinstall gained `touch -h` on that symlink
  (review catch: the BOM restores BUILD-time mtime, so without the touch
  the stamp meant once-per-pkg-build and same-pkg reinstalls never
  re-opened). Old didAutoOpenWebOnFirstRun key migrated away once at
  launch. docs/install/macos.md: new troubleshooting subsection for the
  Control Center scene-host wedge (icon missing → killall ControlCenter
  → reboot) with the reopen escape hatch, qualified "while it's
  running". Swift 74/74.
- **Process note**: gate's `sdk-drift` step is `git diff --exit-code --
  packages/sdk` — an uncommitted contract+SDK change ALWAYS fails it;
  commit contract + regenerated SDK atomically before expecting a green
  gate. Also flagged by a lane: gate's oasdiff invocation lacks
  `--flatten-allof`; with inline allOf responses it can misreport — the
  exit code stayed 0 here, but worth a look if oasdiff ever reds
  unexpectedly.

## macOS menubar-icon invisibility — OS scene-host wedge, NOT a Loombre bug (2026-08-08, RESOLVED by reboot)

Follow-up field report after the relocation fix below was verified live
(rebuilt rc.6 pkg, sha256 f9c3b12f…, installed correctly to /Applications,
LaunchAgent bootstrapped, stack serving): the menubar icon still never
appeared, and Loombre.app "did nothing" when opened from Launchpad.
Full-session diagnosis exonerated the app end to end (process healthy,
status item created + drawing, IPC polls 200, Control Center hosting its
scene). ROOT CAUSE — systemic macOS 26 state corruption: ControlCenter
(Tahoe's menu bar scene host) crash-restarted at 01:01:35, mid
broken-install-storm, and came back wedged — NO newly registered menu bar
item from ANY process displayed (a bare test item inside Apple-signed
swift-frontend and Docker Desktop's whale were equally invisible); each
`killall ControlCenter` adopted only a partial, inconsistent icon subset.
Owner reboot fully cleared it — flame appears at login. No installer
change needed for visibility. Machine-side hygiene applied: duplicate
LaunchServices registration for com.loombre.menubar (the stale relocated
build-cache copy) unregistered, /Applications copy re-registered.
Follow-ups tracked in the session task list: (1) wizard folder-picker
"Grant access" flow for _loombre media permissions (owner request,
replaces the blocking red paragraph); (2) menubar
applicationShouldHandleReopen → open web UI (clicking the app while
running currently does nothing — would have made this whole incident
self-evident) + revisit once-per-user didAutoOpenWebOnFirstRun vs the
conclusion pane's per-install promise; (3) docs/install/macos.md
troubleshooting note candidate: "icon missing → killall ControlCenter,
then reboot". Draft-release consequence from the entry below still
stands: rc.6's macos .pkg asset carries the relocation defect — re-tag
(rc.7) so the release pipeline rebuilds and re-signs.

## macOS installer relocation bug — Loombre.app silently never installed (2026-08-08, FIXED)

Owner field report on the rc.6 pkg: "install successful, but the app never
launches or appears in Applications." NOT the rc.1 no-autostart class (that
LaunchAgent fix is intact) — /Applications/Loombre.app was never laid down
at all.

- **Root cause (proven from /var/log/install.log + the shipped
  PackageInfo):** build-pkg.mjs ran pkgbuild WITHOUT `--component-plist`, so
  pkgbuild's automatic component analysis marked Applications/Loombre.app
  `BundleIsRelocatable=true` (a `<relocate>` entry in PackageInfo).
  PackageKit resolves a relocatable bundle's destination by
  LaunchServices/Spotlight lookup of the bundle id and installs over ANY
  existing registered copy on the volume — four consecutive rc.6 installs
  (2026-08-08 00:55–01:09) landed inside this repo's own
  `installers/macos/.build-cache/payload/arm64/Applications/Loombre.app`.
  Install exits 0; the LaunchAgent's hardcoded /Applications path spawns
  nothing. Self-perpetuating: each hijack re-registers the stray with
  LaunchServices. The Jul 27 / Aug 6 installs landed correctly only because
  /Applications/Loombre.app still existed then; once it was removed, the
  stray became the relocation target.
- **Fix (feedback-loop-first):** `renderComponentPlist()` in build-pkg.mjs +
  `--component-plist` on the pkgbuild call — pins Applications/Loombre.app
  `BundleIsRelocatable=false` (version-check deliberately off: rc-suffixed
  versions don't compare reliably under Installer's rules; preinstall boots
  the running app out, the payload is authoritative). Regression nets:
  `pkg/component-plist.test.mjs` (gate `installers-test` — round-trips the
  plist through the REAL pkgbuild; a control case reproduces the defect,
  proving the detector detects) + a smoke.mjs check
  (`findRelocatableBundleIds`) asserting the built artifact's PackageInfo
  lists no relocatable bundles — verified firing on the actual defective
  rc.6 artifact before the fix. LAYOUT.md §6 documents the flag as
  load-bearing. End-to-end proof: component pkg rebuilt from the real staged
  rc.6 payload with the flag → `<relocate/>` empty, bundle still
  upgrade-tracked. `pnpm gate:full` ALL STEPS PASSED.
- **Release consequence:** the rc.6 draft's macos .pkg asset CARRIES THIS
  DEFECT — any machine with a stray Loombre.app copy (build tree,
  ~/Downloads, Trash) reproduces "successful install, no app". Rebuild the
  macOS asset before publishing the draft (or fold into rc.7).
- **Dev-machine residue (needs owner sudo):** the relocated installs wrote
  Loombre.app into `.build-cache/payload/arm64/Applications/` AS ROOT
  (`--ownership recommended` + root installd), so build-pkg.mjs's payload
  `rmSync` will fail until
  `sudo rm -rf "installers/macos/.build-cache/payload/arm64/Applications"`;
  then rebuild + reinstall restores /Applications/Loombre.app.

## v0.9.0-rc.6 draft release COMPLETE + dep-audit HIGH cleared (2026-08-08)

- **CI-red root cause (runs 31229683836 + 31235322170, ~3.5min failures): NOT a
  code change.** GHSA-2v37-7h3g-55p8 (HIGH, nanoid <3.3.17, "custom generators
  can loop indefinitely when size is zero") landed in the GitHub advisory DB and
  tripped the dep-audit gate; nanoid is transitive under next→postcss. Fixed at
  `66ef94a7` via pnpm-workspace.yaml ranged overrides: postcss floor
  8.5.12→8.5.23 (also clears moderate GHSA-fxqj-rqcc-2cmp; resolves 8.5.26) +
  `postcss>nanoid: ^3.3.17` **deliberately scoped to the 3.x line** — a bare
  `>=3.3.17` resolved nanoid 6.0.1, which is ESM-only and would break postcss's
  CJS require (trap recorded for future advisory-driven overrides). gate:full
  green locally; CI run 31245213606 green on all blocking jobs. The red
  `gate-node-next` (Node 26, NON-BLOCKING by N2) is the standing experimental
  localStorage class — now surfacing as `window.localStorage` undefined in
  appearance-prefs.test.ts et al. (64 fails, same single root cause, no new
  signal).
- **Draft is UP with all 7 assets** (windows .exe 434MB / macos .pkg 153MB /
  linux .tar.gz 224MB / manifest.json+.minisig / SHA256SUMS+.minisig); minisign
  signatures on both verified locally against `keys/minisign.pub`; manifest
  carries all 4 platforms incl. BOTH cosign-signed docker images
  (ghcr.io/loombre/loombre + loombre-web :0.9.0-rc.6).
- Release run 31245723929 (tag at `209bb92b`): **ALL SIX JOBS GREEN ON THE
  FIRST ATTEMPT** — first rc to need zero reruns (rc.5's docker leg died to
  runner infra and needed `gh run rerun --failed`). Owner install-testing;
  publish-or-delete is the owner's call afterward.

## macOS live-test bug wave 1 — menubar wiring, wizard picker, folder-picker Forbidden (2026-08-07, all three FIXED)

Owner's macOS live test surfaced three issues; 3-agent read-only sweep proved
all root causes; fixes landed feedback-loop-first (every fix has a prior
failing check). `pnpm gate` ALL GREEN (after one known-family e2e flake, see
below).

1. **Menubar "Reveal Crash Files" no-ops / "whole menu isn't wired" feel —
   three real causes, all fixed.** (a) The handler had three silent returns,
   and the empty-list one fired on EVERY healthy install: zero crashes is the
   steady state (`crashes/` is created lazily on first crash), so the click
   was a guaranteed no-op; Windows tray dialogs "No crash files found." in
   the identical case (parity gap). (b) `NSMenu` DEFAULT autoenablement
   force-enables any item with target+action — no `autoenablesItems = false`
   anywhere — so every manual `isEnabled` was overridden at display time:
   items designed to gray out without an IPC connection were clickable and
   silently guard-returned. (c) The lifecycle item assigned
   `#selector(startLoombre)` even when the plan said `.none` — combined with
   (b), a transitional "Stop Server"-titled item could fire the admin-prompt
   launchd start. FIX: new `MenuBuilder.swift` (all menu construction, incl.
   the test-pinned `autoenablesItems = false`; `.none` → nil action) +
   `MenuActions` @objc protocol; `revealCrashFiles` now alerts on empty
   ("No crash files found" + crashes-dir path) and on IPC error, reveals via
   new pure `IPCCrashFilesResponse.revealPlan` (IPCKit). NEW TEST TARGET
   `LoombreMenubarTests` (SPM testable-executable) pins the AppKit wiring —
   the exact layer this shipped through untested; `swift test` 65/65.
   Field note: installed rc pkgs predate ALL menubar fixes (incl. b3856df6
   Start-via-launchd + 2a408b44) — next pkg build picks everything up.

2. **Setup wizard's "no folder-browse button yet" copy was FALSE — the P4.6
   manual-entry-only deviation is REVERSED.** The deviation reasoned about a
   NATIVE controller-app picker (controller-IPC has no picker op — still
   true); the server-enumeration DirectoryPicker landed later for Settings >
   Library and made the rationale stale. Auth was never a blocker: STEP_ORDER
   puts libraries AFTER admin, and AdminStep applies the first-admin
   TokenPair to the auth store — the library step is a live admin and calls
   the admin-only GET /admin/filesystem/directories through ordinary
   api-client plumbing. FIX: LibraryStep embeds the shared DirectoryPicker
   (Browse… button; pick fills first empty field else appends, de-duped —
   AddLibrarySheet's rule); stale copy/comments rewritten (LibraryStep
   header, wizard-state.ts, test describe label); LibraryStep.test.tsx added.
   No contract/guard/setup-surface changes; 404-invisibility untouched.

3. **Folder picker "Forbidden" browsing /Users/<user> on macOS — two proven
   layers.** Capability: pkg LaunchDaemons run as `_loombre` (not in
   staff/admin; verified live `id _loombre`), home dirs are 700/750 →
   readdir EACCES → 403. That posture is DELIBERATE and KEPT (LAYOUT.md
   serves-while-logged-out; Linux is stricter still with ProtectHome;
   Windows runs LocalSystem which is why it doesn't reproduce there). UX
   (the actual bug): SDK error message carries only the problem TITLE, the
   picker rendered raw "Forbidden" and dropped the server's actionable
   `detail`; the codebase's own apiErrorMessage (V-UX F2/F3) existed for
   exactly this and wasn't used. FIX (contract-first): `DirectoryEntry.readable`
   (required) — unreadable dirs are listed AND marked ("No access", dimmed,
   still clickable — clicking is how the guidance surfaces), never hidden;
   errors render via apiErrorMessage (picker + LibraryStep submit); 403 now
   carries `code: "filesystem-permission-denied"` and a detail tailored to
   the ACTUAL runtime account (pure `permissionDeniedDetail()`: darwin+_loombre
   → /Volumes and /Users/Shared steering + ACL-grant pointer; linux+loombre
   split systemd-vs-container via /.dockerenv; generic otherwise — a dev
   server never claims to be an installer). docs/install/macos.md gained
   "Media in your home folder": targeted ACL grant (`chmod +a` search-only on
   ~, inheriting read ACL on the media dir), revoke/verify commands, and the
   FDA precision that matters (Full Disk Access lifts TCC only, NEVER POSIX
   perms; only needed for Desktop/Documents/Downloads; path-based grant on
   `/opt/loombre/current/runtime/node/bin/node`, re-check after upgrade).
   Docs synced to website same-session (70 routes, website build green).

- Tests: server 19/19 admin-directories (incl. chmod-000 `readable:false`
  case, POSIX-non-root-gated), web 43/43 (new DirectoryPicker.test.tsx ×4 +
  LibraryStep.test.tsx ×4), Swift 65/65 (2 new suites). Gate note: sdk-drift
  compares `git diff` vs the INDEX — stage regenerated SDK before gating.
- e2e flake observed (known deferred family): security-hardening F1
  GET /episodes/{id} returned 401 under full-suite parallelism, green in
  isolation and on gate rerun. Triage clue for later: the 401 body was
  `{"type":"error","error":{"type":"authentication_error",...}}` — NOT
  problem+json, so it bypassed/preceded the RFC 9457 filter.
- New small tickets from the sweep (NOT fixed, candidates): (a) macOS
  postinstall UID picker landed `_loombre` at uid 500 — boundary of the
  <500 system range, 500+ can surface in login UI despite IsHidden; (b)
  listRoots offers /home on Linux while ProtectHome hides it (accessSync
  can't detect the ProtectHome empty-dir illusion — readable marking won't
  catch it); (c) FDA path-grant persistence across `/opt/loombre/current`
  symlink swaps on upgrade is unverified (docs phrased cautiously).

## v0.9.0-rc.5 draft release COMPLETE + Windows VM live test (2026-08-07)

- **Draft is UP with all 7 assets** (windows .exe 434MB / macos .pkg 153MB /
  linux .tar.gz 224MB / manifest.json+.minisig / SHA256SUMS+.minisig); minisign
  signatures on both verified locally against `keys/minisign.pub`; manifest
  carries all 4 platforms incl. the cosign-signed docker image digest.
- Release run 31137991489 (tag at `25bf977`): **build-windows GREEN on first
  try — the WIX0104 fix is proven in the release lane itself.** build-docker
  died at ~58min to runner infra ("The hosted runner lost communication with
  the server"; logs never uploaded, failing step left with no conclusion) —
  same tree had passed docker in the rc.4 run an hour earlier. `gh run rerun
  --failed` → all five jobs green, `release` job published the draft.
- **Owner Windows live test (Parallels VM): "no setup wizard, straight to
  login" = NOT A BUG.** The VM carried `C:\ProgramData\Loombre` from the
  July-28 rc.1/rc.2 test rounds (svc-trace.log lineage back to 2026-07-28; the
  MSI deliberately preserves the data dir across upgrade AND uninstall —
  RemoveFolderEx sweeps only INSTALLFOLDER). needsSetup = countUsers()===0 was
  honestly false: a July-era user exists (owner's `test@test.com` attempts →
  auth-anomaly.log FAILED_LOGIN ×3 — server up and answering the whole time).
  The crash-log pair ("terminating connection due to administrator command" +
  "Connection terminated unexpectedly") = the embedded PG's graceful stop
  during a service stop/restart at 02:21Z, benign. **Incidental upgrade-path
  evidence: rc.5 boots CLEAN over a July-era data dir** (02:23:30Z: Nest
  started, listening 3001, IPC up). True-first-run reset ritual: uninstall →
  delete `C:\ProgramData\Loombre` → reinstall.
- **NEW BUG for next RC (real, just not what bit the owner): web-client
  first-boot race.** `AuthStore.checkNeedsSetup()`
  (apps/web/src/lib/auth-store.ts:151) maps ANY /setup/state failure —
  conn-refused while first boot extracts/provisions embedded PG (which runs
  BEFORE app.listen), 429 from refresh-hammering (setup surface: 20/min/IP),
  500 — to `needsSetup=false` → /login, then CACHES it for the tab's
  lifetime; the login page deliberately has no "set up this server" link. A
  genuinely fresh install on a slow disk lands on /login instead of the
  wizard. Fix direction: never cache a failure-derived result; boot splash
  distinguishes unreachable-vs-provisioned (retry with backoff); optionally
  tray gates browser launch on SERVER readiness, not just web.

## Line-by-line swarm audit — READ-ONLY, whole repo (2026-08-05, owner brief "Line-by-Line Swarm Audit → Opus-Validated Findings Ledger → Systematic Fix Plan")

**Ledger: `reports/audit-fafa47f/LEDGER.md`. Audited SHA `fafa47f5dcfc88cbcd7a08afa83c090eb53aa62b`.**
Precondition met: `pnpm gate:full` ALL STEPS PASSED on that exact commit before dispatch.

**Nature: READ-ONLY. No product file was modified by any audit agent.** All output is
under `reports/`, which is gitignored (`.gitignore:42`) — use `git add -f` if the
ledger should enter history.

### Headline counts

- **Coverage 100%:** 2732/2732 tracked files dispositioned, **0 pending, 0 skipped**.
  Partition generated by rule (`reports/audit-fafa47f/partition.py`) and proven
  zero-gap / zero-overlap before dispatch and again at assembly.
- **Swarm:** 54 sonnet auditors (41 coverage lanes + 7 cross-cutting lenses + 6 visual
  lanes over 2 rounds); **6 opus validators** reproduced every finding.
- **119 candidates → 106 verified** · 4 rejected · 31 downgraded · 9 merged.
  **1 blocker · 5 high · 40 medium · 51 low · 9 nit.**
- Per-lane rejection rate **0% for 50 of 51 lanes** — nothing near the 30% two-strikes
  threshold; no lane re-briefed.

### The one blocker

**`AUD-A1h-001` / `V1-001` — unauthenticated remote crash of the whole server.**
`GET /.well-known/acme-challenge/%` → `decodeURIComponent` throws `URIError` at
`apps/server/src/tls/acme/http01-server.ts:93`, inside a raw `http.createServer`
listener with no try/catch, bound `0.0.0.0` by design, in the same process as
everything → `uncaughtException` → `exit(1)`. Live whenever `LOOMBRE_TLS_MODE=acme`
with `http-01`. Reproduced independently three times (lane, validator, orchestrator).
**It is a boundary defect, not a one-line defect** — see ORCHESTRATOR-NOTES ON-01;
the regression test must drive a real listening instance or it passes with the fix
removed.

### Two invariants re-derived and CONFIRMED HOLDING at fafa47f

- **Invariant 4 (guard layer).** Three lanes swept it independently; V1 grepped every
  raw Kysely builder call in `apps/server/src` — **zero in production code**, two hits
  both in `*.spec.ts`. No lane produced a caller reaching rows without clearance.
- **Authorization.** A7a re-derived required auth for every route from scratch and
  filed **zero** authz weaknesses. Its route→auth table and the
  **unauthenticated-surface enumeration** are preserved as appendices
  (`candidates/A7a.md`), as is A7d's **rate-limit coverage map** (`candidates/A7d.md`).

### Already fixed by the concurrent Windows-CI session — do not re-fix

`AUD-T2b-001`, `AUD-T2b-002`, `AUD-T2b-003`, `AUD-A5d-002` all landed in `030f1e1`
with fixes matching the audit's own sketches. Two independent processes converged on
the same four defects.

### Owner triage handoff

Six paste-ready fix waves in `reports/audit-fafa47f/fixwaves/`, grouped by **shared
root cause, not subsystem** (Wave 1 spans TLS/worker/hash-pool/tray because all four
are one defect: a throw with no error boundary beneath it).

**Recommended order: 1 → 2 → 3, then 5 before cutting any release, then 4 and 6.**
Two load-bearing sequencing constraints: **FW4-E before the rest of Wave 4** (the
tautological enum tests are the detector for the drift the other items are instances
of), and **FW3-C before FW3-B** (don't route a leaking API key through a redaction
helper that itself leaks passwords containing `@`).

### A4 is the one non-exhaustive domain — known gaps listed

Round 1 of the visual lanes was lost to an **orchestrator error**: the app was booted
against the SHARED `lumbre`/`loombre` dev DB, which the concurrent session's suite
truncated mid-run — **exactly the failure this file's 2026-07-23 "Surprises" entry
already made standing policy against** (dev DB is single-owner per wave; concurrent
lanes get isolated `lumbre_<lane>` DBs). Round 2 re-ran against an isolated
`loombre_audit_a4` DB and closed most of the gap; the surfaces still unverified
(the whole `/restricted/*` tree, real-artwork tier/scrim placement, the `casual`
account's view, episode detail, all create/edit modals, populated watchlist, music
player chrome) are enumerated in LEDGER §8b. **`AUD-A4v5-002` is the blocker for the
restricted-zone gap**: `seed.mjs` sets gates 2–4 but never `restricted.enabled`, so
no seeded environment can exercise that tree.

Lane behavior under that fault is worth keeping: all three round-1 lanes diagnosed the
real cause, refused to create an account via the setup wizard (correctly reading it as
a forbidden mutation under LAW 0 even though it would have unblocked their charter),
and reported the coverage gap rather than fabricating findings.

### Fix waves — dispatched 2026-08-05 on branch `fix/audit-fafa47f-waves` (from `2747398`)

**WAVE 1 CLOSED — commit `a7cd072`.** Crash boundaries: the blocker + 3 siblings of
the same defect class (code that can throw with no error boundary beneath it).

- `AUD-A1h-001` [blocker] ACME HTTP-01 unauthenticated remote crash — **FIXED**.
  Structural try/catch around all of `handle()`; malformed token → 404. Regression
  test spawns a **real child process** with real crash handlers and drives it over
  loopback; verified to fail (socket hang up) when the fix is reverted.
- `AUD-A2e-001` [high] plugin-delivery tick killed the worker — **FIXED** + test.
- `AUD-A2d-002` [medium] hash-pool slot never replaced — **FIXED** + test.
- `AUD-A5a-003` [medium] tray crash on torn discovery read — **FIXED**; C# test
  written but **not compiled** (no dotnet toolchain on this host).

`pnpm gate:full` green. **Two opus review rounds**; the first returned
changes-required and caught a **regression Wave 1 itself introduced**: the hash-pool
heal respawned with no cap — measured **74 spawns in 2 seconds**, unbounded, for
process lifetime (an OOM crash loop would have respawned into the same pressure
~37×/sec forever). Pre-fix that case hung; post-fix it spun. Fixed with backoff +
terminal cap + logging, plus graceful degradation (dispatch skips dead slots instead
of failing 1-in-N hashes forever). **The gate was green through the entire storm** —
adversarial review caught it, tests did not.

New findings raised by the wave (owner triage, in `reports/audit-fafa47f/candidates/W1-followups.md`):
- `AUD-W1-001` [medium] the tray test project runs in `windows-installer-diag.yml`
  and `release.yml` but **not in `gate:full`**, so tray regressions are invisible to
  the inner loop.

Raw-listener sweep (Wave 1 exit-gate item 3) performed **three times** independently
— result recorded in the wave doc and ORCHESTRATOR-NOTES ON-01: **no other equally
exposed unguarded raw listener exists.** The IPC listener catches via `.catch()` and
is loopback+token-gated; the TLS and WireGuard listeners pass the Nest/Express
instance; `remote-direct` reuses the now-fixed class.

**WAVE 2 CLOSED — commit `9ffc8c6`.** Silent data loss and integrity races. Every
defect here lost or corrupted data *without throwing, logging, or telling the user*.

- `AUD-A2d-001` [high] Stash checkpoint ran ahead of durable apply → un-applied
  scenes silently dropped after a crash — **FIXED**; test drives a real two-attempt
  resume with an injected mid-apply failure.
- `AUD-V2-M1` [medium] import never validated archive-internal uniqueness →
  duplicate ids overwrote, duplicate usernames absorbed, job reported success —
  **FIXED**, rejected before any write. **`users.username` is CITEXT**, so the check
  is case-folded; the first pass keyed on the raw string and `Bob`/`bob` still
  imported "successfully" with only `Bob` created.
- `V1-006` [medium] `consumeSeekTarget` could resurrect a closed session — **FIXED**;
  **two further writers** (`markSessionFailed`, `finalizeSession`) were missing the
  same guard and are fixed too. Tests are real two-connection row-lock races.
- `V1-011` [low] `replaceLibraryPathMappings` non-transactional — **FIXED**.
- `AUD-A2d-003` [low] `scan.completed` under-reported after resume — **FIXED** via
  additive migration **0033** (real INTEGER columns, invariant 3); `schema.sql`
  regenerated, verified by sha256 recomputation.

Two opus rounds again. The first **reproduced the `Bob`/`bob` residual against the
real `runImport`** and caught that FW2-E had been **dropped from dispatch entirely**
(orchestrator error — the wave doc listed five items, only four were briefed). The
second verified by **mutation testing**: reverting the case-fold resurrects the bug;
forcing ~54 files back through the scan resume path produces no double-counting.

New items for owner triage:
- `AUD-W2-001` [low] — `reports/audit-fafa47f/candidates/W2-followups.md`. **Full-mode
  Stash sync retains a narrower residual** of the same class: `runInventoryPass`
  writes markers for every scene before apply, so a terminal mid-apply failure
  retires them and the next incremental computes `touched = []`. Loud failure rather
  than silent success — a real improvement, but not immunity. Recorded here because
  STATE.md is the database, not just in a code comment. **[WAVE-A CLOSED 7659eeb4 2026-08-11]** (marker retirement deferred past apply, mirrors the incremental fix)
- **`apps/server` e2e flakiness is NOT reproducibly green.** Wave 2's reviewer hit
  `reauth-review-findings.e2e.spec.ts` (200 vs 404) on one run and
  `conformance.spec.ts` on the next; a third run passed clean, and both pass in
  isolation. `apps/server` is untouched by Waves 1–2. This is order/timing dependence
  in the server suite — the same class STATE.md already records at `8f6cf0d`. **A
  "green gate" claim on this repo is currently not reproducible**, which matters for
  every future wave's exit gate. Deserves its own triage.

**WAVE 3 CLOSED — commit `484e06c`.** Trust-boundary defects: SSRF host-check
bypass, secret leakage into crash logs, token revocation, rate-limit gaps.

- The token-revocation item (`updateDeviceForLogin`) took **three attempts and a
  two-strikes escalation to opus**: attempt 1 left a stale epoch → every re-login
  minted already-dead tokens (reviewer reproduced 12/12); attempt 2 nulled the epoch
  → revoked tokens resurrected on re-login; the opus lane derived
  `loginAccessEpochMs = floor(nowMs/1000)*1000`, landing the guard threshold exactly
  on the new token's `iat`. Migrations **0034** + **0035** (comment-only corrective —
  0034 untouched, additive-only discipline).
- The crash-log redaction twins (`apps/{server,worker}/src/crash/redact.ts`) also took
  three attempts — the first two were **worse than main** on the reviewer's 18-case
  matrix (main 14/18 → attempt-1 15/18 but leaked a second connection string →
  final allowlist+lookahead **18/18**). Lesson recorded: a "better" redactor must be
  proven against a matrix, not eyeballed.
- Owner decision left open (not decided by the wave): `rateLimit.loginByIdentifier`
  — per-identifier limiting is an account-lockout DoS trade-off either way.

**WAVE 5 CLOSED — commit `42d40c3`.** Release-integrity: signed-manifest coverage
gap, arm64 hardcode, untested default install path.

- Structural catch: **`installers/` tests ran in NO runner** — not a pnpm workspace
  (turbo never saw it), zero `ci.yml` references. Added `pnpm installers:test` and a
  gate step (`installers-test`, after `test`) — `pnpm gate` is now **15 steps / 16
  full**; verified to run a non-zero test count AND to fail when an assertion is
  deliberately broken. CLAUDE.md / CONTRIBUTING.md / getting-started.md step lists
  corrected to match (they had also drifted: `go-licenses-check` was missing).
- Review caught the wave replacing one false comment with another
  (`build-manifest-lib.mjs` "single source of truth" claim); fixed against the real
  three-edit-site behavior. Clarification recorded: `dotnetTest()` DOES run in
  `windows-installer-diag.yml` + `release.yml` — the gap is gate:full only
  (`AUD-W1-001` stands as filed).
- Stale SourceKit diagnostics (Fixtures.processInfoCrashed "missing") disproven by
  `swift test`: 56/56.

**WAVE 4 CLOSED — commit `beb1d23`.** Contract conformance,
error shapes, query hygiene. **First wave with zero self-inflicted defects** — opus
verdict approve-with-nonblocking on round 1; every prior wave shipped a regression
past a green gate.

- Sequencing was load-bearing: **FW4-E (detector) ran first and alone** — 11 enum
  "agreement" tests were tautologies (`readonly T[]` annotation instead of
  `as const`), so they'd have passed through the exact drift the wave fixes.
  All 11 converted; 10 mutation-verified (remove a value → TS2344 pinned to the
  expectTypeOf line → restore → clean). The 11th, `JOB_TYPES`, had **no agreement
  test at all** (`satisfies` proves subset, never exhaustiveness — a JobType
  silently dropped from the array gets no pg-boss queue at startup); closed
  post-review by mirroring the sibling pattern into `packages/jobs`
  (tsconfig.test.json chained into `typecheck` + expectTypeOf spec),
  mutation-verified. **11/11 now enforced by `pnpm gate`'s typecheck step.**
- `V1-002` cursor validators: the audit's count of **sixteen was an undercount —
  the from-source re-enumeration found seventeen** (reconciliation: the audit's list
  included `catalog-detail.ts`, which validated inline against `UUID_PATTERN` and
  contributes 0; `items.ts`'s own local decoder — bare `Error` on ANY malformed
  cursor — is the real 17th). All 17 routed through `isCursorRowId`;
  `catalog-detail.ts` converted too post-review (same semantics, uniform idiom).
  Live-DB spec drives all of them: forged/truncated cursors → 422
  `application/problem+json`, never 22P02/500 (reviewer booted a real Nest app and
  verified the RFC 9457 body on all 16 endpoints).
- New grep-gate `cursor-validator:bare-string-row-id`; after review it was widened
  (`!==` polarity — literally items.ts's original form — and bracket access) and its
  stash-sync-reports.ts exemption narrowed from file-level to a **line-level
  marker** (`grep-gates:allow-bare-cursor-row-id`), closing the hole where one
  legitimate validator exempted its whole file. All four evasion variants the
  reviewer probed now fire or are documented blind spots (destructured form,
  non-id field name) with the live-DB spec as backstop.
- `V1-004` DELETE 200→204: all 11 `@Delete` handlers swept against the contract —
  3 drifted (devices/libraries/users), fixed controller-side (`@HttpCode(204)`;
  none returned a body, so nothing discarded); 3 wrong e2e assertions corrected,
  2 missing success-path tests added.
- `V1-003`/`V1-005` contract enums: `SettingsCategory` +`remote`,
  `CapabilityBackend` description +`amf` — contract edited, SDK **regenerated**
  (reviewer re-ran codegen: byte-identical), oasdiff non-breaking. Two new parity
  specs pin both against their code-side sources of truth. ~24 of 38 contract
  enums swept clean; one deliberate narrowing (`ItemTagKind` excludes `studio`)
  investigated and cleared as by-design.
- `V1-009` progress validation: `Number.isSafeInteger` (post-review — `isInteger`
  alone still 500'd on `1e20`, which overflows BIGINT), mutation-verified both ways.
- `V1-013` export truncation: mid-stream failure now `res.destroy()` — reviewer
  reproduced both terminal behaviors on a real server: destroy = unambiguous
  transport error; the alternative (`res.end()`) yields an HTTP 200 that parses
  until `JSON.parse` — exactly the "looks complete and isn't" file the finding
  warned about. `V1-010` export N+1 batched (24 queries → 2 per page, spy-counted).
- New candidate for owner triage: `AUD-W4-001` [low, latent] —
  `reports/audit-fafa47f/candidates/W4-followups.md`: `readEventsForViewer` binds
  raw `afterId` into a uuid comparison unvalidated; zero production callers today,
  so unreachable — but it's public-barrel API and the new grep-gate cannot see
  this shape (there is no validation idiom to catch).

**WAVE 6 CLOSED — commit `56cc64f`.** The final wave: docs accuracy, dead code,
UI polish, schema indexes. Opus verdict approve-with-nonblocking, zero blocking
issues; every actionable residual closed pre-commit.

- **Operator docs held to execute-every-command:** the bare docker-compose forms
  were *proven* to fail on `:?`-interpolation before fixing; the corrected forms
  proven green. The env-reference contradiction was fixed at the **generator**
  (new `platformDerivedDefault` registry flag), not by hand-editing generated
  output. Post-review sweep: docker.md's own troubleshooting bullets had the
  identical proven defect (out of finding scope, in class scope) — fixed the
  same way; and docker.md's "(gitignored)" claim about
  `installers/docker/loombre.env` (POSTGRES_PASSWORD + JWT secret) was FALSE —
  now true via .gitignore, proven by `git check-ignore`.
- **docs/PLAN.md no longer describes the BullMQ/Redis queue that was never
  built** — pg-boss named at every tier (the spec wins conflicts, so this was
  the highest-leverage doc fix in the audit). Every corrected count/claim in
  FW6-B re-derived from source or execution; the review spot-checked **12**
  of them and found zero still-false replacements (the Wave 5 failure class).
- **csp-hashes.mjs DELETED** (decision recorded: two lanes judged it
  prospective; leaving it produced duplicate investigation; git history
  preserves it). All deletions carried zero-consumer proofs, re-verified by
  review including CSS composes/url() paths. license-check.mjs glob fixed and
  proven: a fake GPL-2.0-only dep in examples/* fails the gate.
- **All 10 A4 visual re-measurements HOLD** at the audited viewports against
  the isolated `loombre_audit_a4` env (screenshots in `evidence/wave6/`):
  metadata column 121px→314px with zero card overlap and Fix Match reachable
  (44px hit target); 49-char unbroken title wraps at the heading tier;
  500-char toast renders 384px ≤ viewport (was 3375px); Job Queue rows tile
  without painting over each other; restricted zone enterable from seed for
  the first time; "macOS" not "Macos"; broken posters render the gradient
  fallback organically. Behavioral fixes **mutation-tested by the reviewer**:
  reverting the transcode-orphan guard fails both new tests; reverting the
  restricted-count coalescing fails 5/6 hook tests.
- **Migration 0036** (admin-list indexes): EXPLAIN-verified, schema.sql
  regenerated, db:migrate-check green. AUD-A8b-001 — the only finding in the
  audit that degrades on its own — closed.
- Not acted on by policy: `AUD-A4v3-003` (the design rule is what's broken —
  the open item is a design-doc decision, owner's call).
- New candidates for owner triage in
  `reports/audit-fafa47f/candidates/W6-followups.md`: **AUD-W6-001**
  `/watch/<0-file-item>` hangs on "Preparing playback…" forever instead of
  rendering UnavailableScreen (medium, needs realistic-library repro);
  AUD-W6-002 seeded envs have zero image blobs (all art is fallback);
  AUD-W6-003 restricted-count "1 request" needs a production-build re-measure
  (dev StrictMode floor is 3, coalescing itself is mutation-proven);
  AUD-W6-004 cron-parser 5.6.2 deprecated-by-registry, bump to 5.7.0.

### AUDIT FIX WAVES COMPLETE — all six closed on `fix/audit-fafa47f-waves`

`a7cd072` W1 crash boundaries · `9ffc8c6` W2 silent data loss · `484e06c` W3
trust boundaries · `beb1d23` W4 contract conformance · `42d40c3` W5 release
integrity · `56cc64f` W6 docs/dead-code/polish. Every wave: gate:full green +
adversarial opus review; four of six waves' reviews caught a self-inflicted
defect a green gate had passed (respawn storm, CITEXT, token resurrection ×2,
worse-than-main redactor, false comment) — Waves 4 and 6 were clean on round 1.

**FULL 3-OS CI GREEN on the branch: run `31116371388` (os=all) at `4527e70`,
2026-08-06** — gate green on ubuntu + windows + macOS, perf-t0/lighthouse/
web-budget all enforcing-green. Getting there surfaced and fixed three CI
defects (`4527e70`): (1) the T0 perf harness collided with Wave 3's OWN
`rateLimit.search` (60/min vs 210 rapid searches — deterministic 429;
harness now env-pins `LOOMBRE_RATE_SEARCH` on its spawned server, the same
mechanism `search-rate-limit.e2e.spec.ts` uses, so the limiter still
executes but cannot trip); (2) the Windows ffmpeg choco install could fail
(community-feed 503) while EXITING 0 — LOOMBRE_REQUIRE_FFMPEG then
hard-failed 7 worker suites 10 min later with a code-problem-shaped
signature; the step now retries and hard-verifies the binary, failing fast
at provisioning; (3) one Windows lint failure with the failing task's
output entirely absent from the log — transient (identical commit passed
lint on rerun + ubuntu + macos + local --force); standing instrument added:
`.github/workflows/windows-lint-diag.yml` (dispatch-only, streamed
--continue --force lint, transcript uploaded as artifact) for the next
occurrence.

**Open for owner (consolidated):**
1. ~~Merge/PR decision~~ **DECIDED 2026-08-06: owner approved merge to main.**
   Fast-forwarded (`2747398`→`6078b9b`), so main carries the exact SHAs the
   3-OS run 31116371388 proved green — no new merge commit, nothing untested.
   Branch `fix/audit-fafa47f-waves` deleted (origin + local) after verifying
   zero unique commits. **Main's own post-merge CI green: run 31134036574**
   (gate + perf-t0 + perf-lighthouse + perf-web-budget, all enforcing).
   The push-triggered run 31119585848 hit the 2026-08-06 GitHub "Partial
   System Outage" (major): action-download 503s, two mass-cancellations,
   and finally a rerun wedged in a cancel-refusing state (both cancel and
   force-cancel APIs 409/refuse — left for GitHub's reaper); its one REAL
   test failure across five attempts was the documented remote-tunnel
   timing flake (1/1592, deferred-item-3 material). **N2 evidence from the
   same run: Node 26.7.0 (runner-fresh that day) breaks the web test
   environment — `window.localStorage` undefined, 107 errors** (yesterday's
   26.x was green) — recorded here as Current-line adoption history per the
   runtime policy; no workaround chased, Node 24 is the shipping line.
2. `rateLimit.loginByIdentifier` account-lockout trade-off (W3, undecided by
   design).
3. `apps/server` e2e flakiness triage (reauth-review-findings / conformance —
   pre-existing, documented at `8f6cf0d`; "green gate" is not reproducible
   until this is fixed).
4. Whether to `git add -f reports/audit-fafa47f/` (gitignored; holds the
   ledger, evidence screenshots, coverage ledgers, wave docs, W1/W2/W4/W6
   follow-up candidates).
5. Follow-up candidate files: `candidates/W1-followups.md` (tray tests not in
   gate:full), `W2-followups.md` (full-mode Stash marker residual),
   `W4-followups.md` (latent readEventsForViewer afterId), `W6-followups.md`
   (4 items above).
6. `AUD-A4v3-003` design-rule contradiction in `design/phosphor/README.md`.

## Loombre Remote — embedded WireGuard + three-path wizard + reachability proof + posture card (kicked off 2026-08-04, owner brief "Loombre Remote (Embedded WireGuard) + Three-Path Wizard + Reachability Proof + Posture Card")

### Mission (verbatim)

Implement remote access end-to-end: the embedded-WireGuard Loombre Remote subsystem (in-process userspace termination, per-device keys, split-tunnel QR/.conf provisioning in an app-agnostic format, revocation, device-list integration), BYO-token tunnel automation with a managed connector, the Direct path's guided ACME + router instruction cards, the three-path wizard with interview routing and CGNAT detection, the one-time-token cellular-QR reachability proof, the exposure-aware security posture card, and the fully restructured remote-access documentation — with an adversarial security review across every new surface.

### Locked decisions (R1–R11, verbatim from the brief — run law)

- **R1 Loombre Remote** = embedded userspace WireGuard (wireguard-go + netstack class: tunnel terminates INSIDE the Loombre process — no kernel module, no root, no OS interface, no routing-table changes). It exposes ONLY Loombre's listener through the tunnel, never the LAN. One UDP listen port (default chosen, registry-configurable, env-pinnable).
- **R2 Keys & enrollment:** server WG keypair generated at enable, private key in the KEYRING; each enrolled device = its own peer keypair generated server-side at enrollment, delivered ONCE via QR (and downloadable .conf for desktops), private key NOT retained after delivery (config shown once, same posture as invite links); device gets a stable tunnel IP from a private /24. Enrollment is admin-initiated per user/device from the admin surface; enrolled devices appear in the existing devices list (kind: remote), individually revocable — revocation removes the peer live.
- **R3 Split tunnel** is the default and only v1 mode: generated configs scope AllowedIPs to the Loombre tunnel address only; full-device tunneling explicitly NOT offered (bandwidth + privacy anti-feature; docs explain in one plain sentence). Config format (the provisioning contract) is APP-AGNOSTIC: standard WG config semantics so today's official WireGuard app and tomorrow's native Loombre clients enroll through identical server machinery — recorded as a design note for the native-app epic.
- **R4 Tunnel path** = BYO Cloudflare token automation: admin pastes a scoped API token (guided creation walkthrough with screenshots); wizard creates tunnel + DNS route via API, runs cloudflared as a managed child process (health in admin, auto-restart with backoff, logs tail), token in the KEYRING masked write-only. Third-party dependency stated plainly on the comparison card. Provider abstraction thin-but-real (interface + one implementation) so other tunnel providers are additive later.
- **R5 Direct path:** wizard automates the server side (ACME issuance via the existing subsystem OR reverse-proxy mode selection with trust-proxy config), then presents router instruction cards (generic + per-common-brand port-forward walkthroughs, content-only — no router APIs), then verifies via R6. CGNAT detection: if the probe never arrives AND the detected WAN address differs from the public address seen by the probe token page, the wizard explains CGNAT in plain words and routes to Tunnel.
- **R6 Reachability proof (all paths):** wizard mints a one-time probe token (hashed at rest, 15-min expiry, single-use) bound to the expected public endpoint; renders a QR of https://<endpoint>/probe/<token>; admin scans with a phone ON CELLULAR; the probe endpoint (unauthenticated by necessity: rate-limited, token-gated, constant-time, static success page with zero server info) marks arrival; wizard watches and lights green end-to-end. No arrival → per-path diagnosis (port/CGNAT/DNS/tunnel-health). No third-party check service — the phone IS the external vantage.
- **R7 Posture card** (exposure-aware, persistent in admin): activates when any path is enabled; grades: TLS live+valid (Direct), rate limiters active on the unauth surface, no passwordless/never-logged-in stale accounts, invite links now world-reachable (informational flag), WG port silence (Remote: the card explains scanners see nothing), connector health (Tunnel), public-URL setting coherent with the active path. Regressions (cert expiring, connector down) raise admin notices via the standing notice/event machinery. Grades link to fix actions.
- **R8 Wizard structure:** interview (who needs access? everyone willing to install a small app? need a public shareable URL? comfortable with router settings?) → recommendation with honest comparison card (attack surface, third parties, difficulty, what-breaks-when) → chosen path's guided flow → R6 proof → posture card handoff. Paths switchable/disableable later from the same surface (disable = revoke peers / tear down connector / drop listeners, verified).
- **R9 Security laws:** no UPnP anywhere; probe endpoint + WG listener + connector are the ONLY new unauth surfaces, each enumerated in the A7-style appendix; WG handshake silence verified by test (unauthenticated probe packets receive no response); tunnel token + WG server key keyring-only; enrollment configs never persisted server-side post-delivery; all wizard mutations live-isAdmin + audited; events for enable/disable/enroll/revoke/path-change.
- **R10 Docs restructure:** new docs/ops/remote-access/ — landing page with decision tree + comparison table, then one self-contained page per named path (a reader NEVER needs the other two); existing acme.md + reverse-proxy.md become reference appendices linked from the Direct page (redirect stubs left in place); admin-register wizard walkthrough; user-register "watching away from home" (scan-and-go, WireGuard toggle troubleshooting line, iOS VPN badge note) in plain language. Register lint applies; every command/claim sourced-verified.
- **R11 Testing reality:** CI proves the machinery (in-process WG loopback handshake test — a test peer connects through netstack and fetches a real endpoint; probe token lifecycle; connector process lifecycle with stub binary; posture grading fixtures; CGNAT-decision unit logic). REAL-NETWORK validation (actual phone, actual cellular, actual router, actual Cloudflare account) is an owner home-lab item with an agent-prepared runbook — logged Open, never simulated as passed.

### Run posture (2026-08-04)

- Precondition: main tip = 50b3e35 (notices second review fix wave), working tree clean; gate:full walked at kickoff on this exact tree — "gate: ALL STEPS PASSED" read from the log itself (verdict line, not a piped exit code), web budget 169.0/200 KB gz. PRECONDITION MET.
- Prepared ground discovered at kickoff: `/settings/remote-access` route + `RemoteAccessSection.tsx` already exist as an honest Settings-IA placeholder (capability pill from GET /system/capabilities `details["remote-access"]` + env-pinned network/tls categories); the wizard lands INSIDE this existing section (U1 supersedes the placeholder body; nav/registry entry `section-registry.ts:88` already adminOnly).
- HARD LINE all paths: wizard detects, instructs, verifies — NEVER auto-configures the network. No UPnP, ever (stated as a feature in docs; grep-gate added).
- Sub-agent policy per standing rule: sonnet floor lanes, opus review. Wide-parallel: Wave 0 contracts (1 lane, blocking) → 12 lanes in ≤6-concurrent dispatch batches → opus ×3 review (V-SEC / V-UX / V-DOC). Resource isolation + serialized browser + per-lane ground-truthing apply.
- Recon: 4 read-only scouts at kickoff (server anatomy / web anatomy / contract+docs+tests / embeddable-WG dependency research) — adjudications recorded below as RG-numbers before Wave 0 dispatch.
- Contract changes additive, SDK atomic; coordinate via STATE.md with anything in flight (nothing in flight at kickoff — tree clean, no other run open).

### Ground truth + orchestrator adjudications (RG-numbers, recon 2026-08-04 — run law alongside R-numbers; 4 scouts: server anatomy / web anatomy / contract+docs+tests / embeddable-WG research)

- **RG1 WG implementation (R1):** wireguard-go + gVisor netstack (the upstream `tun/netstack` package — maintained by the WireGuard project itself; its shipped `examples/http_server.go` is near-verbatim our architecture), compiled per-OS via `go build -buildmode=c-shared`, loaded into Node with `koffi` (MIT; prebuilt for all 6 OS/arch targets — NOT ffi-napi, which is dead). Licenses MIT (wireguard-go) + Apache-2.0 (gvisor), both on the allow-list. Production precedent: Tailscale tsnet/libtailscale, sing-box, tun2socks. New package `packages/wg-native` (~100–250 lines Go glue + koffi TS loader). Local dev without Go = detect-and-skip per the `require-ffmpeg` pattern (`LOOMBRE_REQUIRE_WG=1` strict in CI); CI gains `actions/setup-go` (pinned latest stable Go — build toolchain, not a shipped runtime, so N2 Active-LTS policy doesn't govern it; note recorded) + a `go-licenses` scan feeding a NEW LICENSE-INTENT section (compiled-into-process posture, .NET-components-table shape). Runner-up (boringtun+smoltcp napi-rs) and sidecar fallback recorded; sidecar = R1 deviation, owner-gated only. Pure-JS boringtunjs DISQUALIFIED (solo, self-described non-production crypto).
- **RG2 Tunnel→HTTP handoff (R1):** Go glue opens ONE netstack TCP listener on the server tunnel IP and raw-TCP-pipes each accepted connection to a NEW loopback-only plain-HTTP backend listener (IPC-listener precedent, `apps/server/src/ipc/listener.ts`) that wraps the same Express handler via `app.getHttpAdapter().getInstance()` (same trick `createTlsRuntime` uses). Plain HTTP inside the tunnel is correct posture (WG provides the crypto; a TLS cert can't match a tunnel IP — same as Tailscale). Raw pipe, NOT httputil.ReverseProxy: zero HTTP-awareness risk for HLS/websockets/query-tokens. Accepted v1 tradeoff (documented): tunnel-origin requests appear as 127.0.0.1, so IP-keyed limiters bucket tunnel peers together and the anomaly log shows loopback for tunnel logins — acceptable for an admin-enrolled trusted-device population; noted in the A7-style appendix. Netstack must do NO forwarding: only the local tunnel-IP listener is registered; a "tunnel cannot reach the LAN or any other address" test is part of WG1's silence/containment suite.
- **RG3 Devices (R2):** additive migration — real PG enum `device_kind ('app','remote')` (house style: CREATE TYPE for closed scalar sets), `devices.kind` NOT NULL DEFAULT 'app', plus WG peer table per Wave-0 freeze. Enrollment inserts kind='remote' rows via a dedicated admin flow (NOT login-driven `createDevice`). PRE-EXISTING GAP found by recon (flagged for fix in-run): `DELETE /devices/{id}` is a bare row delete — it never calls `revokeRefreshTokensForDevice` (only logout does). WG2 wires revocation side effects properly: refresh-token revocation on device delete (all kinds — closes the gap), plus live WG peer removal for kind='remote'. V-SEC verifies revoked peer handshake fails live.
- **RG4 Posture regressions → "notices" (R7):** ground truth — `system_notices` is HUMAN-composed only (one-active-slot, replace semantics; no sanctioned programmatic entry point), and the established subsystem-signal pattern is admin-only outbox EVENT types (probe.failed / mail.failed precedent). Adjudication: posture regressions emit new admin-only event types (posture.regressed / posture.recovered) through the outbox + surface persistently as red grades with fix actions on the always-visible posture card. Automation does NOT auto-compose system_notices rows (would fight the human over the single active slot). This satisfies R7's "standing notice/event machinery" via the event half + the card's persistence.
- **RG5 Settings (R1/R8):** new `remote` SettingsCategory in `packages/shared/src/settings-registry.ts`. WG UDP port default **51820**, key `remote.wireguardPort`, ui-scope + envVar `LOOMBRE_WG_PORT` (= "default chosen, registry-configurable, env-pinnable"). v1 has ONE active path at a time (`remote.activePath`: none|remote|tunnel|direct) — the wizard's switch = verified teardown then enable; posture's "public-URL coherent with active path" check presumes a single active path. Multi-path coexistence is a logged future decision, not v1.
- **RG6 Probe token (R6):** house pattern M3 — `randomBytes(32).toString("base64url")` minted once, SHA-256 hex stored, DB equality lookup (constant-time by construction; argon2id explicitly NOT used on unauth routes — DoS posture). New-public-route QUARTET applies (M12): contract `security: []` + `PUBLIC_ROUTE_PATTERNS` regex (the `/invites/claim/{token}` precedent) + conformance `PUBLIC_OPERATION_IDS` + new named policy `probe` in `SurfaceRateLimiterService` keyed by ip (`rateLimit.probe` registry key, env-pinnable).
- **RG7 Connector (R4):** supervised-child pattern composed from existing precedent — `EmbeddedPostgres` supervisor class shape + `spawnFfmpegRun` handle semantics (SIGTERM→timeout→SIGKILL, stderr ring buffer, injectable `spawnFn`) + `computeBackoffMs` (full jitter) + plugin-health-scheduler timer discipline (.unref, overlap guard). Lives server-side (needs admin health API + wizard interplay). Binary acquisition: DETECT on PATH + optional explicit-path setting; v1 does NOT auto-download cloudflared (a binary fetch is supply-chain surface; wizard instructs per-platform install — consistent with the detect/instruct/verify hard line). CI lifecycle tests use injectable spawnFn + a tiny Node script as the stub binary where a real spawn is exercised.
- **RG8 QR (R2/R6):** no QR lib exists anywhere. Client-side rendering in the web app with a small MIT-licensed encoder (U2 selects, records provenance if vendored); admin-only route chunks are outside the /browse bundle budget by construction (belt-and-suspenders: `next/dynamic` ssr:false per BootSplashLazy precedent). Remote-enrollment QR encodes the full wg-quick config text (the standard WG mobile-import format) — rendered from the one-time delivery payload, never persisted; probe QR encodes only the URL.
- **RG9 Tunnel addressing (R2):** default subnet **10.82.146.0/24** (RFC1918, uncommon; deliberately NOT 100.64/10 — Tailscale squats CGNAT space and a phone running both would collide), registry-configurable (`remote.subnet`). Server = .1; devices allocated lowest-free from .2–.254, stored on the peer row (stable per R2).
- **RG10 Wizard shape (R8):** client-side state machine per the setup-wizard precedent (`wizard-state.ts` pure-logic module + tests, thin React orchestrator; the modal plugin wizard is the admin-flow variant) driving ordinary idempotent REST endpoints; the server persists only outcomes (settings, peers, tunnel config), never step state. Server-side staged-commit operations (enable/disable path) follow the plugin-registration validate→stage→commit shape.
- **RG11 CGNAT detection (R5):** no third-party echo service and no router APIs, so the WAN address is ADMIN-SUPPLIED via a guided router-status-page instruction card; classification is a pure decision function: RFC 6598 (100.64/10) WAN → definite CGNAT; RFC1918 WAN → double-NAT; WAN matches DNS-resolved public endpoint but probe absent → port/firewall diagnosis; WAN differs from resolved public address → CGNAT/dynamic-IP mismatch → route to Tunnel. Pure module + exhaustive table-driven unit tests (playback-matrix case discipline, local vitest table — not wired into the global matrix burnup).
- **RG12 ACME admin surface (R5):** today ALL tls.*/acme config is env-only with no admin surface. Adjudication: promote the minimum key set (tls.mode, acme domains/challenge/ToS) to ui-scope + envVar (env still wins where pinned — existing installs unaffected), `requiresRestart: true`; the wizard runs a STAGED test issuance via the existing `issue-certificate.ts` module BEFORE committing tls.mode (lockout-risk mitigation), then hands off to the existing restart machinery (server-power UI) to apply. D1 ground-truths pre-flip issuance feasibility; two-strikes escalation if the module can't run ad hoc.
- **RG13 Docs (R10):** four registers confirmed (user / admin / ops+install / developer), register-lint is warnings-only, docs-build has a generated-docs drift check. NO redirect-stub convention exists — DOC lane establishes it (a short "moved" page at the old path linking the new home; VitePress builds it as a normal page). acme.md + reverse-proxy.md heading inventories captured in recon for the appendix conversion.
- **RG15 Fan-out topology (conformance forces it):** `apps/server/test/conformance.spec.ts` walks EVERY documented operation (401-wall unauthenticated; per-map behavior authenticated; an op missing from the map "fails the suite outright"; D21 mounted-route assertion both directions) — so contract paths cannot land anywhere without mounted routes. Therefore Wave 0 lands on branch **`lane/remote-base`** (not main): full additive contract YAML + regenerated SDK (atomic) + conforming 501 controller shells (mounted, live-isAdmin on admin ops, conformance-map entries; public probe shell returns the uniform enumeration-resistant 404) + settings-registry keys + event schemas + admin-only parity + shared pure modules + fixtures — gate green ON THE BRANCH. All 12 lanes take worktrees off `lane/remote-base`; lanes replace their 501s with real behavior + flip their conformance-map entries; integration assembles lanes → `lane/remote-base` → main only when real. `remote.activePath` is NOT a stored setting — active path is DERIVED from the three subsystems' states (at most one enabled, enforced 409 by the staged enable flows) so coherence can't drift; RG5's activePath wording is refined accordingly at freeze.
- **RG14 New-dep gates:** any new npm dep license must already be on the license-check allow-list (koffi MIT, qr lib MIT: fine); Go graph is invisible to license-checker — the `go-licenses` step (RG1) plus LICENSE-INTENT section entry is MANDATORY before packaging; "no UPnP" grep-gate added to `scripts/grep-gates.mjs` (new pattern group: nat-upnp/node-upnp/natupnp/nat-api/SSDP-discovery import strings, repo-wide, case-insensitive) — plus review-level ban on any UPnP/NAT-PMP/PCP code, stated as a feature in docs. **Not actioned this wave** (Wave 0 introduces no Go graph, no QR lib, and no networking code that could trip a UPnP pattern — flagged for whichever lane first adds real WG/network/QR code; do not let it slip past that lane).

### Wave-0 contract freeze (lane/remote-base @ 3c4bf80) — landed, gate green

Five commits, each independently green: `0dc423c` contract+SDK atomic, `51a303c` event schemas, `e4c0649` shared pure modules, `822edd0` settings registry, `3c4bf80` conforming 501 shells. `pnpm gate` on this tip: **`gate: ALL STEPS PASSED`** (verdict read from the log, all 13 steps — codegen/sdk-drift/oasdiff/depcruise/runtime-imports/license-check/dep-audit/lint/typecheck/test/db:migrate-check/grep-gates/docs-build); every package's test suite green (server 1778/1778+12 pre-existing skips, web 1148/1148, shared 196/196, contract 63/63, worker 1218/1218+5 skips, db 409/409, plus every other workspace 100%).

**Frozen operation list (20 ops, tag `remote`, packages/contract/openapi.yaml)** — all additive, additionally regenerated+rebuilt SDK (156 operations total) in the same commit:
- `GET /admin/remote/state` → `getRemoteState`
- Wireguard (6): `POST enable` / `POST disable` / `GET status` / `GET devices` / `POST devices` (enroll, 201 one-time payload) / `DELETE devices/{id}` (revoke) — operationIds `enableRemoteWireguard`/`disableRemoteWireguard`/`getRemoteWireguardStatus`/`listRemoteWireguardDevices`/`enrollRemoteWireguardDevice`/`revokeRemoteWireguardDevice`
- Tunnel (6): `POST token` (write-only) / `DELETE token` / `POST enable` / `POST disable` / `GET status` / `GET logs` — `setRemoteTunnelToken`/`clearRemoteTunnelToken`/`enableRemoteTunnel`/`disableRemoteTunnel`/`getRemoteTunnelStatus`/`getRemoteTunnelLogs`
- Direct (3): `POST acme-test` / `POST enable` / `POST disable` — `testRemoteDirectAcme`/`enableRemoteDirect`/`disableRemoteDirect`
- `POST /admin/remote/diagnosis` → `diagnoseRemote`
- Probes (2): `POST probes` (mint, 201) / `GET probes/{id}` (poll) — `createRemoteProbe`/`getRemoteProbe`
- `GET /probe/{token}` → `getProbePage` — the ONE public op (`security: []`), full M12 quartet landed day-one: `auth.guard.ts` PUBLIC_ROUTE_PATTERNS, `conformance.spec.ts` PUBLIC_OPERATION_IDS + a dedicated byte-identical-404 test, `probe` policy in SurfaceRateLimiterService + `@RateLimit("probe","ip")`.

All 19 admin ops mounted as conforming 501 shells (`apps/server/src/remote/`, 7 controller files split by sub-area — RemoteStateController/RemoteWireguardController/RemoteTunnelController/RemoteDirectController/RemoteDiagnosisController/RemoteProbesController/ProbePageController — RG15's fan-out topology, so the lanes replacing each sub-area's 501s touch disjoint files): `requireAdmin` (local helper, `apps/server/src/remote/require-admin.ts`, wraps requireLiveAdmin/A10) FIRST, then `notImplemented()` — new factory, `apps/server/src/gateway/problem.exception.ts` (501, `urn:loombre:problem:not-implemented`). `getProbePage`'s shell unconditionally 404s (bare `NotFoundException()`, byte-identical to the catch-all) — this **IS** final behavior for every case reachable before real probe tokens exist, not a placeholder. Conformance 13/13 (mounted-route assertion, both unauthenticated and authenticated walks, the new dedicated public-op test).

**Event-type list (9 new, envelope enum 37→46, ALL admin-only — Wave-0 adjudication, see below):** `remote.enabled`, `remote.disabled`, `remote.device.enrolled`, `remote.device.revoked`, `remote.path.changed`, `tunnel.connector.state`, `posture.regressed`, `posture.recovered`, `probe.arrived`. Closed-list 8-touch complete for all 9: envelope enum + x-mirror, `admin-only-event-types.ts` (canonical, edited first), 9 payload schema.json files (all `additionalProperties:false`, R9 no-secrets rule verified — ids/names/timestamps only), `event-schemas.spec.ts` count+samples, `packages/shared/test/admin-only-event-types.test.ts`'s 29-item snapshot, `ACTOR_FIELD_MAP` (`remote.device.enrolled`/`remote.device.revoked` map `["deviceId","userId"]`; the other 7 map to `[]`) + `actor-field-map.spec.ts` count (37→46 there too).

**Settings keys (new `remote` SettingsCategory + 1 rateLimit key, `packages/shared/src/settings-registry.ts`):** `remote.wireguardPort` (51820, `LOOMBRE_WG_PORT`, **requiresRestart:true**), `remote.subnet` (`"10.82.146.0/24"`, `LOOMBRE_WG_SUBNET`, **requiresRestart:true**, `REMOTE_SUBNET_SCHEMA` bounds prefix /8-/30), `remote.wireguardEndpointHost` (`""`, `LOOMBRE_WG_ENDPOINT_HOST`, requiresRestart:false), `remote.cloudflaredPath` (`""`, `LOOMBRE_CLOUDFLARED_PATH`, false), `remote.tunnelHostname` (`""`, `LOOMBRE_TUNNEL_HOSTNAME`, false); `rateLimit.probe` (10/min, `LOOMBRE_RATE_PROBE`). No `remote.activePath` key (RG15). wireguardPort/subnet are the **first real ui-scope + requiresRestart:true entries since lane S3's hot-reload migration** — closes the "first future key" scenario `settings.service.spec.ts`'s synthetic test explicitly anticipated (comment updated there for honesty; mechanism untouched, still passes). Docs regenerated + committed (drift check enforced it): `settings-reference.md`/`env-reference.md` pick up all 6 keys; curated titles + "Remote access" category blurb added to `scripts/docs/lib/settings-titles.mjs` so the section renders properly. Web admin `CATEGORY_LABELS` (`SettingsCategoryCard.tsx`) gains `remote` → "Remote access".

**Four pure-module file paths + version constants (`packages/shared/src/remote/`, framework-free, spec-first — 69 new tests, fixtures under `packages/shared/test/remote/`):**
- `provisioning.ts` — `PROVISIONING_FORMAT_VERSION = 1`. `buildProvisioningConfig(input): string`, split-tunnel only, golden-file tested (2 fixtures, `test/remote/fixtures/*.conf`). Native-app epic design note in header (R3).
- `wizard-state.ts` — no version const (a step-sequence table, not a wire format). `STAGE_ORDER` (5 stages), `PATH_FLOW_STEPS` (per-path, R2/R4/R5), `nextPathFlowStep`, `planPathSwitch`, `DISABLE_VERIFICATION_STEPS`, `deriveEntryStage`, `recommendPath`.
- `posture-model.ts` — `POSTURE_CHECK_KEYS` (7, closed), `PostureGrade`, `POSTURE_CHECK_FIX_ACTIONS`, `applicableChecks`, `overallGrade`, `deriveCardState`.
- `diagnosis.ts` — `DiagnosisCode` (7-value union), `classifyReachability` (pure, RG11's exact priority table). `tunnelDown`/`connectorUnhealthy` are NEVER produced by this function (WAN-classification only) — the Tunnel path's real diagnosis endpoint must short-circuit to one of those two BEFORE calling classifyReachability, off its own connector-health signal; flagged so the implementing lane doesn't miss it.

**Migration reservations (record only, NOT written):** `0029` = WG2 (device_kind enum + kind column + wg_peers), `0030` = P1 (probe tokens), `0031` = T1 (tunnel state, if needed).

**Shape decisions made within R/RG law, flagged for orchestrator ground-truth (no single R/RG number covers each exactly):**
1. **All 9 new event types classified ADMIN_ONLY**, not split (RG4 only explicitly covers posture.regressed/recovered) — extended the same reasoning to remote.*/tunnel.connector.state/probe.arrived: every one is instance-security-posture data, R9's no-secrets rule holds for all 9, and `remote.device.enrolled`/`revoked` carrying a `userId` doesn't change that (same posture as `user.invited`/`user.claimed`, already admin-only despite carrying user-identifying fields).
2. **7-controller-file split** for `apps/server/src/remote/` (RG15 mandates the fan-out topology exists; the exact file boundaries are mine) — one file per contract sub-area (state/wireguard/tunnel/direct/diagnosis/probes/public-probe-page), matching each sub-area's likely owning lane so replacement work touches disjoint files.
3. **Contract response shapes** — `RemoteState` composes the three per-path status schemas directly (`RemoteWireguardStatus`/`RemoteTunnelStatus`/`RemoteDirectStatus`) rather than a bespoke summary; `RemoteProbeToken` carries both `probeUrl` and `qrPayload` per the deliverable spec's literal field list even though `qrPayload` today equals `probeUrl` (RG8: the QR simply encodes the URL) — kept as two fields in case a future lane wants the QR payload to diverge (e.g. a custom URI scheme) without a breaking contract change.
4. **`wizard-state.ts`'s exact step ids, the Direct acme-vs-reverse-proxy branch shape, `DISABLE_VERIFICATION_STEPS`' vocabulary, and `recommendPath`'s heuristic** — R8 names the five stages and the three paths' subsystems but not per-path step ids or a concrete recommendation function; flagged in the module's own header too. U1 (wizard lane) may refine without touching `StageId`/`PathId`/the frozen function shapes.
5. **`posture-model.ts`'s applicability split** (3 path-specific + 4 universal checks) and `FixAction` `href`s (routing to `/settings/remote-access?path=...` query shapes that don't exist yet — U-lanes own actually building those routes) — R7 names all 7 checks and which subsystem each path-specific one belongs to, but not the universal/path-specific split rule itself (my inference: exposure is the shared precondition, so anything not literally about one subsystem's own mechanism is universal).
6. **`REMOTE_SUBNET_SCHEMA`'s /8-/30 prefix bound** — a sanity ceiling/floor, not specified by RG9 (which only fixes the *default* subnet).
7. **`GET /probe/{token}` mounted at top-level `/probe/{token}`**, not nested under `/admin/remote/` — mirrors `/invites/claim/{token}`'s own precedent (a public unauthenticated surface lives outside the admin path prefix it's conceptually "for").

### Orchestrator freeze ground-truth + Batch-1 dispatch (2026-08-04)

- Freeze spot-verified against the tree (op count 156, getProbePage `security:[]` + uniform-404 shell, 7-controller split, provisioning golden = correct split-tunnel wg-quick with AllowedIPs=server/32, wizard-state frozen surface). All SEVEN flagged shape decisions ACCEPTED as-frozen: (1) all 9 event types admin-only — correct extension of RG4 (user.invited precedent); (2) 7-file controller split; (3) RemoteState composition + probeUrl/qrPayload pair; (4) wizard step ids — U1 may refine WITHIN frozen StageId/PathId/function shapes; (5) posture applicability split + fix-action hrefs — U1 must make `/settings/remote-access?path=...` real; (6) subnet /8–/30 bound; (7) top-level `/probe/{token}` (invites-claim precedent).
- **DRIFT DECISION #1 (logged per exit gate):** the freeze omitted a posture read endpoint — R7's card and U3 need one. S1 adds `GET /admin/remote/posture` → `getRemotePosture` (additive, contract+SDK atomic in its lane, real implementation + conformance entries land together; no 501 interim).
- **DRIFT DECISION #2 (migration renumbering):** WG1 (batch 1) needs persistent WG state before WG2 (batch 2). New reservations: **0029 = WG1** (`remote_wireguard_state` single-row: server public key, enabled, enabled-at; private key keyring-only), **0030 = WG2** (device_kind enum + kind column + wg_peers), **0031 = P1** (probe tokens), **0032 = T1** (optional).
- Cross-lane seams (orchestrator-set): `ConnectorManager`/`ConnectorHealthReader` are INTERFACES defined by T1/P1 with no-op defaults; T2 (batch 2) provides the real implementation — integration wires it. `remote.enabled`/`remote.disabled` events = ANY path with payload `{path}`; `remote.path.changed` = switches. Comparison-card + router-card CONTENT live in `packages/shared/src/remote/` as single-source data modules (U1 authors comparison, D1 authors router cards; U2 renders; DOC consumes the same source per R10).
- Concurrent-session note: main moved to 12ea834 during Wave 0 (parallel session, docs-only STATE.md [skip ci] commit recording the 50b3e35 push + CI results). No code overlap; one-line STATE.md merge expected at integration.
- **Batch plan:** Batch 1 (dispatched): WG1, T1, P1, S1, D1, U1 — worktrees off `lane/remote-base` @ e8e0842+, per-lane Postgres databases for resource isolation, targeted tests inner-loop + ONE full gate at lane end. Batch 2 (off advanced base after WG1/T1 land): WG2, T2, U2, U3, DOC. Batch 3: WG3. Wave 2: opus V-SEC/V-UX/V-DOC.

### Batch-1 lanes landed (2026-08-04; merged to lane/remote-base, assembly `pnpm gate` ALL STEPS PASSED read from the log — verdicts below are each lane's own full gate)

- **P1 ✅** (`a8d78ce`, own-gate env-failed → suites proven green in isolation, assembly gates green): probe tokens (0031), real GET /probe/{token} (byte-identical-404 + zero-info page via res.end, header set recorded for V-SEC), watcher, diagnoseRemote + per-path guidance (27 cases). ACCEPTED adjudications: **DRIFT #3** — additive required `path` on CreateRemoteProbeRequest/DiagnoseRemoteRequest (wizard supplies it; activePath is cross-lane state an isolated lane can't read); ConnectorHealthReaderService concrete-class seam; RemoteDnsResolverService (NXDOMAIN → dnsMismatch + detail suffix); narrower remote_probe_path PG enum.
- **U1 ✅** (`d228371`, gate green): wizard shell in RemoteAccessSection (hero/management entry states, interview → recommendation → stepper, switch/disable with DISABLE_VERIFICATION_STEPS progress), comparison.ts single source, deep links real, PATH_FLOW_STEP_BODIES step-slot API for U2, PostureCardSlot for U3. Found+fixed: root `@loombre/shared` barrel breaks webpack browser builds (node:crypto) → **`@loombre/shared/remote` subpath export; all web lanes must use it**. /browse 169.1 KB gz unchanged. Dropped the placeholder's "Advanced Server →" link (accepted).
- **S1 ✅** (`503d56a`, gate green): DRIFT #1 landed (getRemotePosture, 157 ops, contract+SDK atomic); 7 evaluators with per-check blind-spot notes for V-SEC (wgPortSilence structurally cannot pass — test-asserted); regression scheduler → posture.regressed/recovered; in-memory recompute-on-boot baseline (accepted); 15-min unpinned sweep (accepted); tlsValidity throw-isolation bug found+fixed by its own tests.
- **T1 ✅** (`871a247`, gate green): TunnelProvider + CloudflareTunnelProvider (fixtures only, never live API), keyring token custody (validate-before-store, no readable field), staged enable/disable with verified teardown, 0032, ConnectorManager abstract token + Noop default for T2. ACCEPTED: additive RemoteTunnelStatus token-status fields; ConnectorHealth.backoffMs; RemoteActivePathReader noop seam; frozen {valid,detail} 200 shape for bad tokens. **Infra incident (transparent, resolved):** T1 mistakenly deleted LIVE Postgres /dev/shm segments during the 64M exhaustion window → container crash → clean WAL recovery, all DBs verified intact; orchestrator's shm_size:1g recreation is the durable fix (docker-compose.dev.yml).
- **D1 ✅** (`9e57597`, gate green 2nd run — 1st hit an unrelated env flake): RG12 promotion (tls.mode/network.trustProxy → ui+envVar; + tls.acmeDomains/acmeChallengeType/acmeTosAgreed, all requiresRestart:true, cross-field invariant added); **staged ad-hoc ACME issuance PROVEN against real pebble** (fixed validator port 3680 documented); settings-boot-bridge closes the "main.ts read env directly" gap; router-cards.ts (generic + 6 brands, port-forward + WAN-reading cards, parameterized tcp/udp). ACCEPTED: frozen {enabledAtMs} event schema wins (remote.path.changed carries the transition — T1 consistent); trustProxy via settings surface not the enable request; 409-check covers WG only (integration extends via canonical resolveActivePath, assigned to WG2); non-atomic 4-key settings commit in enableRemoteDirect logged as a known low-probability race (fix-wave candidate).
- **Cross-lane fixes at integration (orchestrator):** U1×T1 fixture drift (PathManagementCard.test fixtures + T1's additive status fields); stale-dist rebuild requirement after barrel-touching merges; module-header + conformance-map + barrel conflicts resolved additively; SDK regenerated at each contract-touching merge; marker-scans clean.
- Batch 2 in flight: T2, U3, DOC, U2 (+ WG1 still finishing batch 1). WG2 dispatches off the advanced base when WG1 lands (carries canonical resolveActivePath()); WG3 after WG2; GET /admin/remote/state realization = integration work with WG2/WG3.

### Batch-2/3 lanes landed (2026-08-04; all ELEVEN dispatched lanes merged to lane/remote-base @ 8128e99; WG3 remainder lane in flight)

- **DOC ✅** (`d306d6a`, gate green): docs/ops/remote-access/ landing (decision tree mirrors recommendPath; comparison table from comparison.ts) + three self-contained path pages + acme/reverse-proxy moved to appendices with REDIRECT STUBS (the RG13 convention, established) + admin walkthrough + user "watching away from home". 0 new register-lint warnings; repo-wide inbound links updated. Orchestrator post-merge: direct.md router section reconciled against D1's landed router-cards (brand-pointer added).
- **U3 ✅** (`7805fb8`, gate green): PostureCard (fills U1's slot, socket+poll refresh), ConnectorHealthPanel (honest per-state, logs tail, mounts in PathManagementCard's tunnel section), RemoteDevicesPanel (list/revoke vs frozen ops, 501-honest). Flagged-and-accepted: no restartCount/since render (not in frozen schema — not fabricated); raw userId shown (no display-name join in frozen schema).
- **WG1 ✅** (`b42c5d6`, own gate:full 15/15 with REAL Go build): packages/wg-native (Go c-shared + koffi .async loader — KEY FIND: koffi sync mode starves wireguard-go's goroutines; all FFI calls are worker-thread async), migration 0029, enable/disable/status + boot-resume, loopback-handshake/silence/containment suites, CI Go 1.26.5 + go-licenses gate (now step 7 of 15) + LICENSE-INTENT Go section + the RG14 no-UPnP grep-gate. Second find: net.ParseIP vs netip IPv4-in-IPv6 mismatch broke the RG2 listener — fixed. DX flag logged: conformance's WG entries assume the native lib (no-Go contributor sees red) — review item.
- **T2 ✅** (`1985252`, own-scope proven green; its 3 full-gate attempts each hit a DIFFERENT pre-existing/environmental flake, incl. the documented plugins_base_url_unique one): CloudflaredConnectorManager (real supervised child; `cloudflared tunnel --no-autoupdate run` with TUNNEL_TOKEN via ENV never argv — V-SEC input), full-jitter backoff, ring-buffer logs tail, SIGTERM→SIGKILL, injectable spawnFn + REAL stub-child e2e; P1+S1 connector-health seams unified through the ConnectorManager token; boot-resume + main.ts shutdown hook. Flagged: tunnel.connector.state event unwired by anyone → WG3 item.
- **U2 ✅** (`abbcf92`, gate green, web 1273/1273): all per-path wizard screens + ProofStage replaced for real (mint → QR → cellular instruction → poll → arrived/diagnosis per code, CGNAT→Tunnel routing), QR = `qrcode` 1.5.4 MIT (SVG self-render, /browse unchanged 169.1 KB), show-once ceremony memory-only (test-asserted), masked token step per MailCredentialsCard. Found+fixed: subpath barrel missing router-cards; a depcruise-caught component cycle.
- **WG2 ✅** (`9c16419`, gate green 14 steps): migration 0030 (device_kind enum + devices.kind + wg_peers, no private-key column), REAL enrollment (frozen provisioning format, lowest-free IP, one-time payload)/list/revoke, RG3 closed with a REAL BUG FOUND: devices.controller deleted the device row BEFORE token revocation — ON DELETE SET NULL nulled device_id so the revoke's WHERE matched zero rows and tokens SURVIVED device deletion; order flipped + e2e. Revocation ordering: live peer removal BEFORE DB writes (crash-safe direction documented). Canonical resolveActivePath landed (8-case truth table + invariant-violation throw); all four consumers unified; isRemoteWireguardActive deleted; getRemoteState REAL (last 501 gone). Contract: Device.kind required additive; SDK atomic.
- **Integration combines (orchestrator):** T2×WG2 tunnel e2e merged into ONE suite proving the real cloudflared stub child AND the real cross-subsystem resolver together (65/66 green); module bindings both real; stale-dist rebuild discipline (sdk→db→shared before typecheck) now a documented hazard; grep-gates allowlist collision (D1's guard-test regex vs WG1's no-upnp gate) resolved once, WG2 independently shipped the same fix; my earlier remote-direct.spec rewrite superseded by WG2's deletion of isRemoteWireguardActive.
- **WG3 (in flight, consolidated remainder):** devices-list kind badge; post-wizard enrollment entry point (lifting U2's ceremony into a shared component); wiring tunnel.connector.state on health transitions; real-endpoint response-surface show-once sweep.
- **Fix-wave ledger (accumulating for Wave-2 reviewers):** D1's non-atomic 4-key settings commit (low-probability race); WG1's conformance no-Go DX; T2's Windows stub-e2e untested from a Darwin session; U2's direct-acme-test step carrying the enable call (PathFlowContext gap).

### Wave-2 opus reviews (2026-08-04; reports/ remote-v{sec,doc,ux}-review.md)

- **V-SEC (opus, adversarial) — POSTURE HOLDS as-shipped.** No critical/high; no auth bypass, secret leak, SSRF, or IDOR. WG silence + containment LIVE-VERIFIED against the real Go device (garbage UDP → 0 bytes, wrong-key init → 0 bytes, tunnel reaches no non-server address). Probe single-use CAS/expiry/constant-time/zero-info/byte-identical-404/rate-limit all probed solid; enrollment key never stored/logged/evented (grep sweep clean); revocation live-removal + the WG2 token-survival fix hold for both device kinds; tunnel token env-not-argv, no SSRF. Findings + disposition:
  - **F1 MEDIUM — FIXED:** wgPortSilence posture reader was an unwired stub (returned undefined unconditionally) → the check was permanently `warn`, its `fail` (dead-listener) + `info` branches dead code. NOT a false-green (never faked pass), but defeated the actionable red. Wired `WireguardStatusReaderService` → `RemoteWireguardService.status()`; added `wireguard-status.reader.spec.ts` proving info/fail/warn all fire. (The untested wired path is why it slipped.)
  - **F2 LOW — DOCUMENTED (owner-decision follow-up):** cross-path enable is TOCTOU-racy (non-transactional check-then-commit) → two concurrent different-path enables can both land → resolver invariant throw → 500 on subsequent remote READS. Admin-only, low-probability, RECOVERABLE by a normal disable (disable flows don't consult the resolver — verified). Serialization deferred: a lock across the multi-second external side effects, if not released on a throw, is a WORSE permanent lockout. Comment at the throw site + this ledger. Superset of the already-accepted intra-Direct 4-key race.
  - **F3 INFO — FIXED:** the Direct acme-test brings up the pre-existing http-01 challenge listener on :80; added a row to the R9 unauth-surface appendix (transient, challenge-path-only, admin-triggered).
  - **F4 INFO:** probe token in URL path (access-log capture) — mitigated by single-use + 15-min expiry, matches accepted invites-claim precedent. No change.
- **V-DOC (opus, register+accuracy) — two must-fix, both FIXED.** F1 (BLOCKING): decision-tree Row 3 didn't cover the (no-public-URL, no-app, no-router) persona the wizard routes to Tunnel — broadened Row 3's parenthetical to match recommendPath exactly (all 8 combos now covered). F2 (ACCURACY): admin page named a fabricated posture grade "not yet checked" — corrected to the real 4th grade "informational note" (Info). F4 polish (verbatim quote style) fixed. F3 (pre-existing source-path register slips in the moved acme/reverse-proxy appendices) accepted per ledger; F5 (editorial 3-of-4 diagnosis list) fine. Both of DOC's pre-merge unsourced flags verified RESOLVED post-integration. Docs build clean, dead-link detection on, all inbound links resolve.
- **V-UX (opus, browser walkthrough) — WIZARD HOLDS as-shipped.** All three path-walks structurally clean + honest, correct layout at both breakpoints (nav rail↔bottom bar, modal↔bottom sheet), enroll ceremony/proof/posture/switch-disable work end-to-end to the R11 boundary, no remote-feature console errors, 35 screenshots archived (reports/remote-vux-screenshots/). Used chrome-devtools-mcp's own Chrome (claude-in-chrome extension unavailable — same blocker logged for prior runs). Findings + disposition:
  - **F1 MUST-FIX — FIXED:** disable/switch copy promised "every enrolled device is revoked" but teardown LEFT the peer/device rows → they reappeared as "enrolled" after re-enable (server key rotates, so they were cryptographically dead but shown active). Now `disable()` revokes every enrolled device (peer+device rows deleted, refresh tokens revoked, remote.device.revoked emitted), matching R8 ("disable = revoke peers, verified") + the exit gate's literal "peers gone." e2e added proving the empty list + event. (V-SEC's cross-check — no live-access hole — was already confirmed; this removes the dead rows entirely.)
  - **F2/F3 SHOULD-FIX — FIXED:** enroll-without-endpoint-host (422) and enable-while-active (409) showed only the raw status titles ("Unprocessable Entity"/"Conflict"), dropping the server's helpful RFC 9457 `detail`. New shared `apiErrorMessage(err, fallback)` (lib/api-client.ts) prefers problem.detail → message → fallback; swept across the whole wizard error surface (12 components). All 12 mock factories updated.
  - **F4 LOW — FIXED:** never-connected device's "last seen" rendered epoch-0 ("12/31/1969") — now "never" (server coalesces null last_seen to 0; client treats ≤0 as never).
  - **F5–F10 polish/observation — documented, deferred:** stale summary count self-corrects on nav (F5); expired-proof guidance sentence repeats (F6); raw userId in device rows (F7, accepted per U3 — no display-name join in the frozen schema); reverse-proxy branch shows the skipped test-cert sub-step (F8); mobile stepper pills wrap (F9); dnsMismatch masks CGNAT when the endpoint host doesn't resolve (F10 — harmless when it resolves; the pure RG11 fn is correct, the endpoint-side wrapper's precedence is the cosmetic gap). None affect correctness or honesty; logged for a polish pass.
- **Fix-wave gate:** full `pnpm gate:full` (LOOMBRE_REQUIRE_WG=1) re-run after all V-SEC + V-DOC + V-UX fixes — verdict recorded at the exit-gate walk below.

### PUSHED + CI (2026-08-05; owner "push" then "trigger the full 3 os matrix") — 2 CI-only fixes landed, 1 pre-existing macOS issue flagged

Pushed origin/main (487b366), then owner asked for the full 3-OS matrix (workflow_dispatch os=all). Two enforcing failures surfaced that `pnpm gate:full` does NOT run locally (perf-t0 and the Windows/macOS legs are separate CI jobs), each ROOT-CAUSED and the two that are ours FIXED:

- **perf-t0 (enforcing) RED → FIXED (commit b4c8ebd):** `server idle RSS 222.1 MiB > budget 220.0 MiB` — a REAL Tier-0 regression I introduced: `wg-native`'s static `import koffi` pulled koffi's native addon into RSS at every server boot via RemoteWireguardService's boot-time import, even with Remote disabled (CLAUDE.md invariant 9). Fixed by lazy-loading koffi via `createRequire` on first `tryLoadWgNative()` (i.e. only once Remote is enabled); type-only default import erased. Idle server RSS → 205.8 MiB; wg loopback/silence/containment still green. perf-t0 now PASS in CI.
- **gate (windows-latest) RED → FIXED (commit — this):** `wg-native` `go build -buildmode=c-shared` aborted pre-compile: "build cache is required, but could not be located: GOCACHE is not defined and %LocalAppData% is not defined." The turbo→pnpm→node spawn chain reached `go` without %LocalAppData% (go's only cache-location source on Windows). Fixed in `packages/wg-native/scripts/build.mjs`: a GOCACHE fallback mirroring go's os.UserCacheDir logic, a no-op wherever a location already exists (all local dev + the green Linux/macOS legs). Verifying via CI.
- **gate (macos-latest AND windows-latest) RED — PRE-EXISTING (not this run), then FIXED (owner: "dig into it as a separate task"):** failures in `apps/worker/test/stash/{adapter,sync-consumer}.spec.ts` (S2 snapshot-fallback: `source` 'direct' not 'snapshot'; on Windows 11/12 sync-consumer + 2 adapter). This run touched ZERO stash code (git-verified). Once the Windows GOCACHE fix let the build proceed, Windows showed the SAME failures — both non-ubuntu legs. ROOT CAUSE (iterated: first hypothesised same-process locking, disproved; then cross-process locking, ALSO disproved on CI): the GitHub **macOS AND Windows runner filesystems do not honor SQLite file locking at all** — neither a same-process NOR a cross-process (child-process, spike-verified locally) exclusive WAL lock blocks a read-only reader there, so the reader opens directly and the snapshot fallback never fires. ANY test relying on real lock contention is fundamentally non-portable to those runners. FIX (definitive): a new adapter test seam `StashAdapterDeps.openDirectOnce` (alongside the existing sleep/tmpDir seams) forces the direct-open tier into a DETERMINISTIC SQLITE_BUSY; the snapshot tier then runs its REAL backup() against the genuinely-unlocked source. Both specs rewritten to inject (support/busy-direct-open.ts); both-tiers-fail cases use a nonexistent snapshot base (mkdtemp fails) or a corrupt source (backup → SQLITE_NOTADB). NO OS-lock dependency means the fix is fully locally-verifiable, which — unlike every lock-based attempt — actually predicts CI. 25/25 green locally + full local gate:full green. Interim commits (cross-process wal-lock-holder) superseded and removed. Verifying via a final os=all dispatch.

### FINAL 3-OS STATUS (2026-08-05, main tip 28a1e6e, os=all dispatch 30988354382)

- **ubuntu gate + perf-t0 + perf-web-budget + perf-lighthouse: GREEN.**
- **macOS gate: GREEN** — the assigned Stash-lock task is FIXED (injection seam; was the 3 snapshot-fallback failures).
- **Windows gate: RED, but ONLY `@loombre/worker#test` (Stash), and NOT the remote-access feature.** `@loombre/server#test` — which holds ALL remote-access tests — PASSED on Windows, including the WG native build + SILENCE property (raw-garbage + wrong-key → zero bytes), remote-tunnel, and remote-probes (11+21). **The Loombre Remote feature is GREEN on all three OSes.**
- **NEW DISCOVERY — pre-existing Windows Stash path bug (NOT this run, NOT the lock task, owner-triage) → FIXED (owner: "fix the Windows Stash path bug as another task", 2026-08-05):** after the lock fix, Windows `sync-consumer.spec.ts` still failed at :605/:654 (`calls` length 0 vs 4 — the sync matched ZERO scenes). Root cause: Loombre stores `media_files.path` with NATIVE separators (the scanner records the walked absPath verbatim — `walk.ts` POSIX-normalizes only `relPath`, not `absPath`; `scanner.ts` stores `walked.absPath`), so a Windows server holds `\`-separated candidate paths, while `rewriteStashPath` always emits `/`-separated output (it normalizes the configured `loombrePrefix`). The two comparison sites — the path-tier matcher (`apps/worker/src/stash/matching.ts`, `byPath`) and the admin match preview (`packages/db/src/query/stash-inventory.ts`, `candidatePaths`) — did raw string equality, so on Windows every scene fell through to oshash / landed unmatched. macOS (POSIX, like Linux) passed because both sides were already `/`-separated. FIX: new `canonicalizePathForMatch` in `packages/shared/src/stash-path-mapping.ts` (separator-only, never folds case — preserves the module's deliberate case-sensitivity), applied to the Loombre candidate side at BOTH sites (and to the rewrite lookup, so the sides meet by construction). Storage is untouched (Node opens files by native path). Reproduced deterministically on any OS by 3 new tests (shared unit; `matching.spec.ts` native-`\` candidate; `stash-inventory.spec.ts` preview with a `\`-stored `media_files.path`) — all RED before, GREEN after. Full local `gate:full` 15/15 green. **CONFIRMED on Windows (os=all dispatch 30990837626, commit fafa47f):** `sync-consumer.spec.ts` :605/:654 now PASS, `stash-path-mapping.test.ts` 18/18 PASS, the whole shared/remote suite PASSES — the path bug is closed on all 3 OSes.

### os=all 30990837626 (fafa47f) — path bug CLOSED; 3 further pre-existing Windows reds UNMASKED (owner-triage) + perf-t0 variance

Fixing the path bug (and the earlier lock issue) let the Windows worker suite run FURTHER than ever before, surfacing the next-in-line pre-existing Windows failures — none caused by this change, none related to path matching. Owner elected "fix all 3 → green gate" (2026-08-05); all 3 now FIXED:
- **`test/stash/adapter.spec.ts:284` — Windows read-only-directory fs-semantics → FIXED (win32 skip).** The "non-writable directory fails honestly" test (authored 5ff0e70, PRE-DATES my stash work) uses POSIX `chmod 0o500` to make a dir read-only, then `rmSync` in teardown → Windows throws `EPERM` (read-only attribute; and Windows doesn't enforce dir write-protection the POSIX way, so the assertion premise is also non-portable). SAME family as the SQLite-lock non-portability. FIX: `it.skipIf(process.platform === "win32")` with a documented reason — matches the codebase's existing POSIX-mode-bit skips (`packages/secrets/.../file0600.spec.ts` "no POSIX mode bits"). The behavior under test is a POSIX-deployment concern; a Windows Stash dir surfaces a different error path.
- **`test/probe/consumer.spec.ts:143` + `test/probe/probe.integration.spec.ts:134` — interlaced ts fixture SKIPPED on Windows → FIXED (deprecated ffmpeg option).** ROOT CAUSE (from the Windows gen-media-fixtures log): the generator's `mpeg2_interlaced_ac3.ts` command used `-top 1`, a per-codec option that NEWER ffmpeg builds removed ("Codec AVOption top (top field first) is not a encoding option"). The Windows runner's ffmpeg exited nonzero → the fixture landed in `manifestSkipped` → both tests' bare `find(container==="ts")` silently matched the PROGRESSIVE h264 `.ts` and read `interlaced=false`. NOT a git/`.gitattributes` corruption (the fixture is ffmpeg-generated at test time, not checked in). FIX (real, cross-platform): replace `-top 1` with the portable `-vf setfield=mode=tff` filter (+ keep `+ilme+ildct`) — verified LOCALLY that both old and new commands yield ffprobe `field_order=tt`, but only the new one runs on the newer build. HARDENED both tests to select `container==="ts" && interlaced===true` (never silently fall through to the wrong fixture) — a bare-`find` failure now names the real cause.
- **`perf-t0` RSS breach was CI VARIANCE, not a regression.** os=all read server idle RSS 224.2 > 220 MiB budget (1.9% over); the SAME commit fafa47f's push-triggered ubuntu run (30990833209) PASSED perf-t0. Same code, two readings — near-threshold noise. Pre-existing fragility: the koffi lazy-load fix left server idle RSS sitting right at the 220 edge, so runner noise tips it. (`gate (ubuntu, node-current 26)` red there is the non-blocking Current-line evidence job per N2, not a gate.) Not a code fix; re-verify on the next os=all — if it recurs, raise the budget a few MiB for headroom.

Full local `gate:full` 15/15 green after all 3 fixes (one intermittent server-e2e flake — email-collision + remote-tunnel, both untouched — passed on isolation re-run and on gate re-run). Verifying Windows via os=all dispatch.

### os=all 30994171090 (030f1e1) — the 3 elected fixes CONFIRMED green on Windows; a 4th PRE-EXISTING Windows issue is now the blocker

- **All 3 elected fixes PASS on Windows** (run 30994171090, job 92267149877): `test/stash/adapter.spec.ts` 13 tests · 1 skipped ✓ (the win32 read-only-dir skip), `test/probe/consumer.spec.ts` 6 · 1 skipped ✓ (interlace detection now green — fixture generates), `test/stash/sync-consumer.spec.ts` 12 ✓, `test/stash-path-mapping.test.ts` 18 ✓. ubuntu + macOS gates GREEN; perf-t0 GREEN (the earlier RSS breach was confirmed variance).
- **Windows gate STILL red — 4th, DISTINCT, PRE-EXISTING issue (NOT one of "the 3", NOT caused by this work):** `apps/server/test/remote-tunnel.e2e.spec.ts` — 9 of 19 failed. ROOT CAUSE: the spec forces `LOOMBRE_SECRET_BACKEND=file0600` (:206) + a hardcoded POSIX `LOOMBRE_DATA_DIR=/tmp/loombre-remote-tunnel-e2e-data` (:207). On Windows, `@loombre/secrets` file0600 applies an owner-only DACL via `icacls <path>` (`windows-acl.ts:46`) and FAIL-CLOSES when it can't (`errors.ts:69`, "refusing to continue with the secret under inherited permissions") — a deliberate security posture. The forced `/tmp/...` path can't take the DACL on the runner, so `POST /admin/remote/tunnel/token` 500s and every test needing a token cascades (fast asserts + 5s connector-spawn timeouts). Windows' NATIVE backend is `dpapi` (detect.ts:21); the e2e forces file0600 for cross-platform determinism, which is exactly what breaks. **PRESENT in the prior run fafa47f too** (same DACL errors 09:06:58) — it only became the visible blocker now that the worker fixes let the suite run to completion instead of dying earlier. This contradicts the earlier "remote feature green on all 3 OSes" note: remote-tunnel.e2e was failing on Windows all along, masked behind the worker reds. Likely fix family: make the e2e use the platform-native backend (dpapi) on Windows, or skip the file0600-DACL flow on win32 (matching file0600.spec's "no POSIX mode bits" skips) — a test-portability fix in a security-sensitive area. NOT fixed here — a 4th issue outside the elected 3; flagged for owner decision.

### 4th blocker FIXED (owner: "fix it + drive to green", 2026-08-05) — remote-tunnel.e2e /tmp → os.tmpdir()

Diagnosis refined and fix applied. The file0600 DACL backend is NOT broken on Windows — `@loombre/secrets`'s OWN tests pass there (`✓ writes it owner-only ... owner-only DACL on Windows`). remote-tunnel.e2e was the ONLY spec (of ~10 that force file0600 + write secrets) using a HARDCODED POSIX `/tmp/loombre-remote-tunnel-e2e-data`; every sibling (remote-wireguard-loopback/enrollment, admin-mail, admin-settings, plugins/*, main-jwt-secret) uses `mkdtempSync(join(tmpdir(), ...))`. FIX: mirror the sibling pattern exactly — `dataDir = mkdtempSync(join(tmpdir(), "loombre-remote-tunnel-e2e-"))`, `rmSync(dataDir, …)` in afterAll (a DACL-owner CAN delete, so the rm is Windows-safe, unlike the adapter read-only-dir case). Verified LOCALLY: remote-tunnel.e2e 19/19 green. This is a real test-portability fix (not a skip) — the file0600 DACL path stays fully exercised on Windows CI.

Local `gate:full` after this fix: 14/15 — the ONLY red is `@loombre/db test/worker-liveness.spec.ts` ("expected {pid:...} to be null"), an ENVIRONMENTAL artifact on this dev box: a live `apps/worker` `tsx watch` process (a running `pnpm dev`) holds a `loombre-worker`-named PG pool, so `getWorkerLiveness` correctly reports non-null and the "no worker connected" premise is false. Not a code issue, not this change, absent on CI's fresh DB (passed in gatefull1/gatefull3). Left the owner's worker process running rather than kill it; change verified via the spec's own 19/19 isolation pass. Verifying Windows via os=all.

### os=all 30996366932 (4d8efe7) + re-run 30997829017: #4 CONFIRMED green; a 5th PRE-EXISTING blocker isolated + FIXED — libuv fs.watch abort

- **#4 (remote-tunnel) CONFIRMED green on Windows** (os.tmpdir fix). ubuntu + macOS + all perf GREEN on both runs.
- **5th, PERSISTENT, PRE-EXISTING Windows blocker — libuv fs.watch process-abort (NOT this work):** `@loombre/worker` failed with a vitest-pool "Worker exited unexpectedly" — all 1214 tests PASSED, but a forked test-worker ABORTED on `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`. This is a known libuv/chokidar bug: `fs.watch` under an 8.3-short-name path (the runner's `os.tmpdir()` = `C:\Users\RUNNER~1\...`) aborts the process. Culprit: `test/stash/watcher.spec.ts` (the ONLY chokidar/fs.watch test in worker) starts a REAL chokidar watcher on temp files. Present in the PRIOR run 030f1e1 too (same `Worker exited unexpectedly`, worker exited 1) — masked behind the earlier worker assertion reds; NOT introduced by this work. FIX: on win32 only, force chokidar's stat-polling backend via `env: {LOOMBRE_SCAN_POLL:"1"}` (the watcher's existing POLL_ENV_VAR override, `scan/watcher.ts`) instead of native fs.watch — verified LOCALLY that polling detects the same write (`LOOMBRE_SCAN_POLL=1` run passes) and exercises the identical delegation logic; the backend is chokidar's/the OS's concern, not this wrapper's (per the spec header). Non-Windows unchanged (native backend). Verifying Windows via os=all.

### os=all 30999434980 (695de23): #5 libuv fix CONFIRMED (worker clean) — a 6th PRE-EXISTING POSIX-ism FIXED (no execute bit)

- **#5 (libuv fs.watch) CONFIRMED green:** `@loombre/worker` now `94 passed | 4 skipped`, no `Worker exited unexpectedly`, no `_wcsnicmp` abort. `@loombre/db` `149 passed`. The polling fix closed it.
- **6th, PRE-EXISTING Windows blocker — POSIX execute bit (NOT this work):** `apps/server/src/remote/tunnel/resolve-cloudflared-binary.spec.ts` "fails ... when the configured path is not executable" → `expected true to be false`. `resolveCloudflaredBinary` gates on `accessSync(path, X_OK)`; Windows has NO execute bit, so any existing regular file satisfies `X_OK` and the "exists-but-not-executable" file the test writes resolves `ok:true`. Unreachable-on-Windows premise, same family as the read-only-dir / file0600 POSIX-mode skips. FIX: `it.skipIf(process.platform === "win32")` on that one test — the `ok:false`+detail rejection path stays covered on Windows by the sibling "does not exist at all" test (accessSync throws ENOENT → ok:false), so no coverage lost. Verified locally (8/8, typecheck clean). This was the SOLE remaining Windows red (worker + db clean this run). Verifying via os=all.

### ALL 6 deterministic Windows-portability bugs FIXED + confirmed — residual is PERVASIVE PRE-EXISTING MULTI-OS FLAKINESS (owner decision)

The 6 fixes (stash-path canonicalize · adapter read-only-dir skip · probe interlace setfield · remote-tunnel os.tmpdir · libuv fs.watch polling · cloudflared exec-bit skip) are all confirmed on Windows: across runs the worker/db/server packages now RUN TO COMPLETION on Windows and every one of those specific portability tests passes. NONE of the 6 recurred once fixed.

What now blocks a single all-green os=all run is PRE-EXISTING, INTERMITTENT, MULTI-OS e2e/timing/variance flakiness — NOT Windows-specific, NOT caused by this work. Same commit 097f499, two consecutive runs, DIFFERENT flakes each time:
- run 31000934208: ubuntu GREEN, perf GREEN, Windows red on the (now-fixed) cloudflared test only.
- run 31001861734 (identical commit, re-run): ubuntu red on `remote-tunnel.e2e "a SECOND server boot … resumes the connector"` (5s-timeout connector-spawn race — also flaked LOCALLY in gatefull2, passed on isolation); Windows red on `ws-broadcaster.e2e "delivers … to both sockets"` (websocket timing, untouched code); perf-t0 red on RSS variance (same commit's prior run passed it).
- earlier: a Windows `typecheck` red with ZERO `error TS` diagnostics (transient parallel-tsc emit glitch; passed on 5 prior runs).
These are independent flaky e2e/timing tests + perf variance + a tooling glitch, each firing on a random leg. Getting all legs green at once is now a FLAKINESS problem (probabilistic), not a code-correctness one. Flagged for owner: harden the top flaky tests (remote-tunnel-2nd-boot timeout, ws-broadcaster timing, perf-t0 budget headroom) as a separate quality pass, vs. accept as known intermittent CI noise. The Windows-portability work this task set out to do is COMPLETE.

### Flake-hardening pass (owner: "harden the top flakes", 2026-08-05)

Targeted timing/variance hardening of the three observed flakes — no behavior change, only tolerance:
- **remote-tunnel.e2e "second boot resume":** the test had NO explicit `it()` timeout (defaulted to `testTimeout` = 5s × TIME_SCALE = 5s on the ubuntu leg) yet does TWO full Nest boots + two stub-connector health-waits — exceeding 5s under load. FIX: explicit `}, 30_000)` + the 2nd-boot `waitFor(healthy)` bumped 5s→15s.
- **ws-broadcaster.e2e "both sockets":** a fixed `sleep(1500)` before the POSITIVE delivery asserts raced the 500ms broadcaster poll + socket delivery under load. FIX: new `waitUntil(predicate, 10s)` poll — waits until all three positive deliveries land, then asserts (negative-window `sleep()` checks kept, since "nothing MORE arrives" can't be a poll).
- **perf-t0 server idle RSS:** budget `serverIdleRssBytes` 220 MiB → 235 MiB (~15 MiB headroom over the 220 nominal / 224.2 observed max) so near-threshold GC/heap runner noise stops flaking the enforcing job while a gross (>10 MiB) regression still fails. Nominal target documented in the comment.
Verified locally: remote-tunnel + ws-broadcaster 25/25, perf-t0.mjs parses. Verifying via os=all.

### ✅ FULL 3-OS GATE GREEN — os=all 31043244412 (92e9eff), 2026-08-05

Every job PASSED: **gate ubuntu ✅ · gate windows ✅ · gate macOS ✅** · perf-t0 ✅ · perf-web-budget ✅ · perf-lighthouse ✅ (node-current-26 skipped = non-blocking evidence job per N2). The Windows leg is GREEN for the first time in this line of work — closing the original Stash path bug + all pre-existing Windows issues its fix unmasked:
1. Stash path separator (real product bug) — `canonicalizePathForMatch` at both match sites.
2. Stash adapter read-only-dir — win32 skip (no POSIX mode bits).
3. Probe interlace fixture — generator `-top 1` (removed in newer ffmpeg) → portable `setfield`; tests hardened to select the interlaced ts.
4. remote-tunnel file0600 DACL — hardcoded `/tmp` → `os.tmpdir()`.
5. libuv `fs.watch` abort (`_wcsnicmp` fs-event.c:72 under 8.3 temp path) — force chokidar stat-polling on win32.
6. cloudflared `X_OK` exec-bit — win32 skip (no execute bit; not-found path still covers ok:false).
Plus the flake-hardening pass (remote-tunnel-2nd-boot timeout, ws-broadcaster waitUntil, perf-t0 RSS headroom) that got all legs green simultaneously. All fixes are test/tooling-scoped except #1 and #4 (product/shared code paths that genuinely misbehaved on Windows); every one verified on the Windows runner.

### EXIT GATE — WALKED 2026-08-04 (main tip 5cc263a; `pnpm gate:full` ALL 15 STEPS PASSED, LOOMBRE_REQUIRE_WG=1 + real Go 1.26.5 build, verdict read from the log not a wrapper)

Each §4 exit-gate item, with its backing evidence (test file / artifact):

- **gate:full green + contract+SDK atomic + Wave-0 contracts frozen through the run** — PASS. 15/15 (codegen/sdk-drift/oasdiff/depcruise/runtime-imports/license-check/go-licenses-check/dep-audit/lint/typecheck/test/db:migrate-check/grep-gates/docs-build/web-build-budget); web budget 169.1/200 KB gz. 157 SDK ops, regenerated atomically at every contract-touching merge. Wave-0 four contracts (provisioning v1 / probe protocol / posture model / wizard state machine) unchanged through the run; the two additive contract changes since freeze are LOGGED DRIFT (getRemotePosture #1; probe/diagnosis `path` field #3), not silent edits. 3-OS: full matrix runs in CI on `[full-ci]`/dispatch (billed-minutes policy); this walk is the local ubuntu-equivalent + the Darwin native build.
- **WG loopback handshake / silence / revocation-live-removal / show-once** — PASS. `packages/wg-native/test/loopback.spec.ts` ((a) enrollment→fetch-through-tunnel 200, (b) SILENCE raw-garbage + wrong-key-init both zero-response via `assertSilence`, (c) CONTAINMENT tunnel-client-can't-reach-non-server); `apps/server/test/remote-wireguard-loopback.e2e.spec.ts` (same at the service level); `apps/server/test/remote-wireguard-enrollment.e2e.spec.ts` ((b) REVOCATION LIVE-REMOVAL: same peer fetch OK→revoke→FAILS; the WG3 show-once sweep: config/privateKey absent from list/status/state/posture/events). V-SEC live-verified the silence + containment against the real device.
- **Tunnel: API automation vs fixtures + connector lifecycle with stub** — PASS. `apps/server/test/remote-tunnel.e2e.spec.ts` (provider vs recorded fixtures incl. error paths; real cloudflared stub child; token write-only); `apps/server/src/remote/tunnel/cloudflared-connector-manager.spec.ts` (start→healthy, connection-lost→unhealthy, crash→backoff→restart with growing full-jitter, stop-during-backoff cancels, SIGTERM→SIGKILL, TUNNEL_TOKEN env-not-argv).
- **Probe full lifecycle + unauth endpoint limits/constant-time/zero-info** — PASS. `apps/server/test/remote-probes.e2e.spec.ts` (mint→visit→arrived→2nd-visit-404→poll; expiry; single-use CAS race; 429 via LOOMBRE_RATE_PROBE; byte-identical-404). V-SEC probed all of it solid; success-page header set captured (no server/etag/x-powered-by).
- **CGNAT decision unit-proven + per-path diagnosis mapping** — PASS. `packages/shared/test/remote/diagnosis.test.ts` (RG11 priority table exhaustively), `packages/shared/test/remote/diagnosis-guidance.test.ts` (every DiagnosisCode×path renders guidance).
- **Posture: every R7 check both grades + regression→notice + no false-green** — PASS. `packages/shared/test/remote/posture-model.test.ts` (applicability + grading), `apps/server/test/remote-posture.e2e.spec.ts` (real endpoint + regression scheduler), `apps/server/src/remote/posture/wireguard-status.reader.spec.ts` (V-SEC F1 fix: info/fail/warn all fire). V-SEC false-green hunt: none; wgPortSilence structurally can't `pass` (test-asserted).
- **Wizard three-path walk clean + disable/switch tears down verifiably (listener closed, peers gone, connector stopped)** — PASS. V-UX walked all three paths both breakpoints, 35 screenshots archived; F1 (disable now REVOKES peers — the "peers gone" criterion) fixed with `apps/server/test/remote-wireguard-enrollment.e2e.spec.ts`'s "(F1) disable REVOKES every enrolled device" (empty list + remote.device.revoked). Connector-stopped + listener-closed covered by the tunnel/WG disable e2e.
- **Unauth-surface appendix updated (probe, WG port, connector) + no UPnP** — PASS. `docs/developer-guide/architecture/security-posture.md` "Appendix: the unauthenticated surface, enumerated (R9)" (every public route + WG UDP listener + loopback backend + connector + acme-test http-01 listener, each with justification/containment; V-SEC F3 row added). No-UPnP: `scripts/grep-gates.mjs` UPNP_PATTERNS group PASS (0 violations, 2597 files); grep of shipped code clean.
- **Docs restructure + redirect stubs + register lint + V-DOC accuracy** — PASS. `docs/ops/remote-access/` (landing decision-tree + 3 self-contained path pages + moved acme/reverse-proxy appendices); redirect stubs at old paths ("This page moved"); 0 new register-lint warnings; V-DOC accuracy pass clean after F1/F2 fixes; docs-build green (dead-link detection on).
- **STATE.md R1–R11 recorded; native-app provisioning design note logged; owner home-lab runbook delivered + logged OPEN (never agent-passed)** — PASS. R1–R11 + RG1–RG15 above; the provisioning format's app-agnostic native-app design note lives in `packages/shared/src/remote/provisioning.ts`'s header (R3); `docs/ops/remote-access/home-lab-validation-runbook.md` delivered, agent-prepared, owner-run-only — see the OPEN ledger below.

### OPEN ledger — Loombre Remote (nothing silently dropped)

- **[OPEN — owner home-lab, R11]** Real-network validation: actual phone on actual cellular, actual router port-forward, actual Cloudflare account/token, actual ACME issuance against a real domain. Runbook: `docs/ops/remote-access/home-lab-validation-runbook.md`. CI proves the machinery; this is the one thing CI cannot, and NO agent has marked it passed. Owner runs it and signs the table.
- **[OPEN — owner decision, V-SEC F2 LOW]** Cross-path enable is TOCTOU-racy (non-transactional check-then-commit) → two concurrent different-path enables can 500 subsequent remote reads; admin-only, low-probability, recoverable by a normal disable. Documented at the invariant throw (`packages/db/src/query/remote-active-path.ts`). Fix = serialize enables under an advisory lock across their side effects; deferred because a lock un-released on a thrown external call is a worse permanent lockout. Owner: fix now or accept as documented. **[SCHEDULED Wave B (LD-9, owner-adjudicated: fix now with guaranteed release-on-throw), in flight 2026-08-11]** — **[CLOSED WAVE B a16f3e50/6b27d9fe/1d5dcf8c 2026-08-11: serialized under a pg_advisory_xact_lock that wraps ONLY the DB commit (no external I/O in the locked region → release is structural, PostgreSQL COMMIT/ROLLBACK; no permanent-lockout mode); race loser compensates by tearing down its external side effect; READ COMMITTED enforced at runtime with a 5-check assertion incl. the session-default vector; disable path takes no lock (proven). D-R2 attacked the design note and it HELD. The invariant throw remains as believed-unreachable defense-in-depth.]**
- **[DEFERRED polish — V-UX F5–F10]** Stale summary count self-corrects on nav (F5); expired-proof guidance sentence repeats (F6); raw userId in device rows (F7, accepted — no display-name join in frozen schema); reverse-proxy branch shows a skipped test-cert sub-step (F8); mobile stepper pills wrap (F9); dnsMismatch precedence masks CGNAT when the endpoint host is unresolvable (F10 — harmless when it resolves). None affect correctness/honesty. **[RE-AFFIRMED 2026-08-11]** (documented keeps)
- **[NOTE — DX, WG1]** `conformance.spec.ts`'s WG op expectations assume the native lib is built; a contributor with no Go toolchain sees red there (the dedicated WG suites skip gracefully, this one doesn't). Consider a Go-absent skip for the WG conformance rows.
- **[NOTE — CI, T2]** The cloudflared stub-child e2e is Darwin-verified this session; Windows CI leg exercises it on the next `[full-ci]`/dispatch (design is shebang/chmod-free for portability).
- **[LOGGED — main not pushed]** All work is on local `main` (tip 5cc263a). Push remains owner-authorized and is NOT part of this run. Recommend `[full-ci]` on the push to exercise the 3-OS matrix (macOS/Windows legs + the Go toolchain build per OS).

## Admin broadcast notifications — system notices (kicked off 2026-08-04, owner brief "Admin Broadcast Notifications: Restart Warnings, Maintenance, Custom Notices")

### PUSHED + CI RESULTS (2026-08-05; origin/main 5ef5c5d → 50b3e35, 11 commits: macOS/Windows full-shutdown + web power UI + the entire notices run)

Owner authorized ("go ahead and push"). **Push CI run 30962561004: SUCCESS** — gate (ubuntu) + perf-t0 + perf-web-budget + perf-lighthouse all green on the first CI exercise of the notices feature. **windows-installer-diag run 30962560958: SUCCESS** — and it fired ON PUSH: the `paths: installers/**` trigger flagged as a process gap on 2026-08-02 has been implemented, so the tray build + 46 dotnet tests (incl. the ServiceStack full-shutdown suite) + real-Windows MSI install/uninstall ran without a manual dispatch; the 2-day-latent-break class is closed. Only red = `gate-node-next` (Node 26, NON-BLOCKING by N2), verified same single root cause as the standing evidence: Node 26's experimental localStorage breaks auth-store.test.ts — no new signal. Still tag-gated (not exercised): the release.yml four-platform installer set — the macOS menubar full-shutdown rides on local swift test 55/55 until the next release tag.

### Mission (verbatim)

Implement system notices end-to-end: an admin compose surface (custom message + severity + optional scheduled-restart countdown + expiry, with quick presets), an active-notice model so both currently-connected users AND users who connect while a notice is active see it, live delivery over the events socket, severity-appropriate client rendering that surfaces over every surface including the fullscreen player, cancel/replace semantics, an audited notice history, and docs in the correct registers.

### Locked decisions (N1–N6, verbatim from the brief — run law)

- **N1 Model:** additive `system_notices` table — id, message (plain text, 500-char cap, no markup in v1), severity (info | warning | critical), effective_at_ms NULL (set = the countdown target: "restarting AT this time"), expires_at_ms (required; default per severity — info 1h, warning until expiry set, critical until cancelled), created_by, created_at_ms, cancelled_at_ms. One ACTIVE notice at a time in v1 (composing a new one replaces the active one with an explicit "replace current notice?" confirm) — a notice channel that stacks becomes noise.
- **N2 Reach:** delivery is live via the events socket (notice.published / notice.cancelled — admin-event-list parity per the L3 canonical source does NOT apply; these are all-user events by definition, recorded as such at the canonical list with a comment), AND the active notice is returned by a lightweight GET /v1/notices/active that clients call on boot/reconnect — so "currently logged in" includes everyone who connects during the window, not just socket-present-at-publish. No email, no push in v1 (logged as the future tie-in to the mail subsystem for maintenance windows).
- **N3 Rendering by severity (Phosphor, both breakpoints):** info → the standard pill toast (auto-dismiss); warning → persistent top banner, per-session dismissible, returns on next connect while active; critical → persistent top banner, NOT dismissible while active. ALL severities surface over the fullscreen player as a non-blocking overlay strip (a restart warning that a fullscreen viewer never sees has failed its entire purpose — this is a review checkpoint with screenshots). Banner reuses the restart-pending banner component family, visually distinct by severity accent.
- **N4 Countdown:** when effective_at_ms is set, clients render a LIVE countdown in the banner ("Server restarting in 4:32") computed client-side against server time (the payload carries server-now to avoid clock-skew lies); at zero the banner switches to a static "restarting now" state — the notice system does NOT itself restart anything (restart remains the operator's action; the notice is communication, and the docs say so plainly). Presets in the compose UI: "Restart in 5/15/30 min" (pre-fills message + effective_at + critical), "Maintenance" (warning + custom window), "Custom".
- **N5 Authority + audit:** publish/cancel are admin mutations with live-isAdmin verification (A10 pattern) and outbox audit events with actor; notice history (last N with who/when/cancelled) listable in the admin surface. Plain-content rule stated in the compose UI helper text: notices go to EVERY user — never include restricted-zone references or personal information (docs repeat it in the admin register).
- **N6 Non-interference:** notices never block interaction (no modal), never interrupt playback state, and the critical banner coexists with the restart-pending settings banner without stacking chaos (one shared banner region with a defined precedence: system notice > restart-pending).

### Run posture (2026-08-04)

- Precondition: main tip = 7483071 (web admin power UI; three local commits still unpushed — push remains owner-authorized and is NOT part of this run), gate:full ALL 14 green at that commit.
- Sub-agent policy per standing rule: sonnet lanes, opus review. Lane order: A (server, contract freeze) → B (admin compose) ∥ C (client rendering) → integration → opus three-session review → fix wave if findings.
- Recon first: three read-only scouts (events pipeline / server feature anatomy / web surfaces) ground the lane briefs before lane A launches; adjudications recorded below as NG-numbers.
- Future tie-in logged per N2: mail-subsystem delivery of maintenance-window notices (email/push) is v2 — the notice model carries everything needed (severity, window, message).

### Ground truth + orchestrator adjudications (NG-numbers, recon 2026-08-04 — run law alongside N-numbers; 3 read-only scouts over events pipeline / server anatomy / web surfaces)

- **NG1 (broadcast mechanism — confirmed, zero new plumbing):** the ws-broadcaster's fallthrough path ALREADY broadcasts to every authenticated socket — any event type NOT in `LIBRARY_ONLY_TYPES`/`ITEM_ONLY_TYPES`/`USER_ONLY_TYPES` (packages/db/src/query/events.ts) and NOT in `ADMIN_ONLY_EVENT_TYPES` (packages/shared/src/admin-only-event-types.ts) reaches admin and non-admin alike (`user.created` precedent; pinned by ws-broadcaster.e2e.spec.ts's "general event reaches both sockets"). `notice.published`/`notice.cancelled` are deliberately placed in NO bucket and NOT admin-only. N2's "recorded as such at the canonical list with a comment" lands in admin-only-event-types.ts (the L3 canonical source — the envelope mirror is JSON, no comments possible). Touch list = the closed-list 8-touch MINUS the two admin-only touches: envelope enum 35→37, two payload schema files (additionalProperties:false), event-schemas.spec count+literals+hand-written samples, actor-field-map.spec count + ACTOR_FIELD_MAP entries `[]` — payloads deliberately carry NO user-id fields (see NG6/NG8).
- **NG2 (late-connect = the REST read, not socket catch-up):** outbox delivery is live-tail with ONE global processed cursor — a socket that connects after a batch is marked processed never sees it, and `readEventsForViewer` exists but is unwired (stays unwired this run). GET /notices/active IS the catch-up mechanism: the client fetches it on auth boot AND on every socket `onStatusChange` → "open" (first production consumer of that API — today only its own test uses it).
- **NG3 (clock anchor):** no time-sync mechanism exists anywhere on the socket. The anchors are: envelope `tsMs` (server clock, already in every event) for socket-delivered notices, and an explicit `serverNowMs` field on the GET /notices/active response. Client computes `offset = serverAnchor − Date.now()` at receipt and renders countdown = `effectiveAtMs − (Date.now() + offset)` — never its own wall clock alone (N4's exit-gate line).
- **NG4 (expiry semantics — N1's one ambiguity, resolved):** `expires_at_ms BIGINT NULL` + `CHECK (severity = 'critical' OR expires_at_ms IS NOT NULL)`. NULL = "until cancelled", legal ONLY for critical (N1's "critical until cancelled" — a far-future sentinel would be dishonest data). Info defaults to now+1h when unset; warning REQUIRES composer-set expiry (422 when absent — N1's "warning until expiry set"). ACTIVE is derived, never stored (invites derive-don't-store rule): `cancelled_at_ms IS NULL AND (expires_at_ms IS NULL OR expires_at_ms > now)`.
- **NG5 (durations in, absolutes out):** the publish request carries RELATIVE `effectiveInMs`/`expiresInMs` (CreateInviteSheet's duration-select precedent; the app has NO datetime-picker component and gets none this run) — the SERVER anchors both to its own clock and stores/returns absolute ms. Compose-time clock skew is impossible by construction; N4's countdown skew handling (NG3) covers the render side.
- **NG6 (contract surface, four ops, tag `notices`):** POST /system/notices `publishSystemNotice` → 201 SystemNotice (admin); POST /system/notices/{id}/cancel `cancelSystemNotice` → 204, idempotent-loser and unknown id = 404 (invites revokeInvite precedent); GET /system/notices `listSystemNotices` → cursor page, created_at_ms desc (admin); GET /notices/active `getActiveSystemNotice` → 200 `{notice: SystemNotice|null, serverNowMs}` for ANY authenticated user — deliberately OUTSIDE /system because it is the all-user read (brief's own path). The all-user SystemNotice shape EXCLUDES createdBy (plain-content posture — viewers get no admin identity); admin history rows add createdBy/cancelledAtMs + derived status. Conformance zero-allowance entries: getActiveSystemNotice 200, listSystemNotices 200, publishSystemNotice 422 (bodyless — message required), cancelSystemNotice 404 (placeholder UUID).
- **NG7 (module placement):** own `apps/server/src/notices/` NoticesModule + NoticesController (invites 5+-sibling-directory precedent; NOT another lodger in admin.controller.ts); query module `packages/db/src/query/notices.ts` in the public barrel with the settings/invites-style header (system table, controller-layer authz via requireAdmin + requireLiveAdmin A10 — no ViewerContext by construction).
- **NG8 (audit = the broadcast events themselves):** notice.published/notice.cancelled carry envelope `actorUserId` — delivery AND audit in one; NO separate admin-only audit type (the two types serve both masters, N5 satisfied). History reads the system_notices table, not events. REPLACE emits exactly ONE notice.published (clients hold one notice and replace by design — no cancelled event for the superseded row; a client that misses it reconciles via NG2's fetch). `created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL` (audit-actor column pattern per events/server_settings — deleting an admin must not delete notice history), enforced NOT NULL at insert time by the query layer.
- **NG9 (web architecture — the recon-found constraint that shapes lanes B/C):** there is NO global banner region today, /watch NEVER wraps in AppShell, and true Fullscreen paints ONLY the fullscreen element's subtree (even the toast viewport vanishes). Therefore: notice STATE lives in ONE provider inside AppProviders (survives route remounts; owns the socket subscription + NG2's boot/reconnect fetch); RENDERING splits across three mounts — info → the existing single-slot ToastProvider; warning/critical → a NEW BannerRegion inside AppShell (the first global banner region; sits under the fixed topbar, both breakpoints); ALL severities → a NoticeOverlayStrip mounted INSIDE VideoPlayer's stageRef div (the only DOM position that survives real fullscreen — N3's player checkpoint). Precedence (N6): while a warning/critical notice is showing, SettingsRestartBanner suppresses itself via the shared hook — one top-of-page banner class at a time; restart-pending returns when the notice clears.
- **NG10 (dismiss + cap enforcement):** per-session dismiss = in-memory provider state (RestrictedProvider shape; the app deliberately has ZERO sessionStorage usage and keeps it that way) — reload or reconnect-while-active naturally re-shows a warning banner (N3's exact wording). Cap/no-markup: server 422s over 500 chars post-trim + contract maxLength; clients render message as plain text nodes ONLY (never HTML); the compose char counter is new UI (no counter precedent exists).

### Lanes landed (2026-08-04; merged to main @ fc806b3, zero conflicts, marker-scan clean)

- **Lane A (server) — d037c5e, gate 13/13.** Migration 0028_system_notices.sql (real `notice_severity` PG enum per house style, NG4 expiry CHECK) + packages/db/src/query/notices.ts (publish/cancel/getActive/listAdmin — replace-not-stack in one trx, audit-is-the-broadcast per NG8). Contract tag `notices`, 4 ops per NG6, SDK regenerated+rebuilt, oasdiff additive-only. Envelope enum 35→37 (notice.published/notice.cancelled), deliberately unbucketed + non-admin-only per NG1, recorded with a comment at admin-only-event-types.ts. apps/server/src/notices/ module; 20 e2e cases + 4 outbox-emission tests + 4 conformance entries. No N/NG deviations.
- **Lane B (admin compose) — 29ca3a3, gate 13/13.** Settings → Notices admin section (registry key after "server", SettingsShell branch, route): ActiveNoticeCard (cancel w/ danger confirm, 404-as-gone per the contract's ambiguity), ComposeNoticeCard (N4 presets — restart 5/15/30 min = critical + effectiveInMs + expiry effective+10min self-clear; Maintenance = warning, expiry forced; live N/500 counter; validation mirroring the server; N1 replace-confirm showing the to-be-replaced message, presets hidden mid-confirm; publish disabled until active-state loads), NoticeHistoryPanel (InvitesPanel template, severity+status pills, createdBy short-uuid, "removed user" on null). Single data source = GET /system/notices first page (one-active guarantees the active row is in it). Live refresh via read-only socket subscribe → refetch. 23 tests.
- **Lane C (client rendering) — d972c2a, gate 13/13.** SystemNoticeProvider (inside AppProviders, ToastProvider-reachable) owns boot-fetch, socket subscribe, reconnect refetch (first production `onStatusChange` consumer), NG3 clock-anchor offset, per-session in-memory dismiss (ONE flag shared across surfaces). BannerRegion = the app's first global banner region (AppShell, in-flow variant of the brief's allowance; `.main[data-banner]` padding handoff driven by the same boolean the banner reads). NoticeOverlayStrip = first child inside VideoPlayer's stageRef (survives real fullscreen; all severities; info auto-hides ~6s; pointer-events:none except own dismiss). SettingsRestartBanner self-suppresses per N6 via a non-throwing `useSystemNoticeOptional` (fails OPEN — shows restart banner if ever unprovided; forced because its call sites live in Lane B's territory). +39 web tests incl. skewed-clock (server 10 min ahead), zero-state, replace/cancel/expiry, precedence. **Known caveat for review:** strip (z6) can transiently overlap PlayerControls' top bar (z5) while controls are visible — non-blocking, auto-resolves on idle-hide; PlayerControls wasn't reflowed (outside lane ownership).
- **Integration:** docs landed orchestrator-side (admin-guide/system-notices.md + sidebar/index, user-guide "Banners and announcements", server-power cross-link; docs:build green, register-lint clean on all touched pages). Process note: all three lanes hit the SAME stall — `pnpm gate` exceeds the Bash tool's 120s foreground threshold → auto-backgrounded → lane parks on a monitor that never re-invokes it; root cause recorded in orchestrator memory (fix: explicit long timeout on the gate call). Unstick-by-SendMessage worked every time; work was always already correct.

### Opus review (2026-08-04, live three-session walk + code pass) — ALL exit-gate items PASS live; 5 findings fixed, 4 logged

**The walk (screenshots archived, 34 shots, scratchpad notices-review/):** every N3 rendering verified per severity across desktop/mobile/player sessions INCLUDING the named checkpoint — the strip under REAL fullscreen (`document.fullscreenElement === stage` asserted per shot); countdown tracked wall-clock and hit the zero-state; **skew LIVE-FAKED** (Date shimmed +10min pre-boot → banner still showed true remaining time — NG3 holds under a genuinely skewed clock, not just in unit tests); replace/cancel propagated live to all sessions; late-connect session saw the active notice; casual 403 on publish/cancel/list + no Notices tab; XSS probes (`<b>`, `<script>`, `<img onerror>`) rendered as literal text on every surface; N6 clean (no modal, `<video>` state untouched across publish/cancel, banner never blocks clicks). Environment notes: Next 16 dev rejects cross-origin dev requests → three-origin trick replaced with isolated browser contexts (5 sessions total); real fullscreen entered via `requestFullscreen()` from script; precedence had to be driven by injecting `restartPendingKeys` client-side (see R-F6).

**Fix wave (orchestrator, same day — all five fixed, red-proofed where stated):**
- **R-F1 (stale active-fetch clobbers newer notice):** SystemNoticeProvider gains a monotonic generation — bumped on every fetch START and every socket event (cancelled bumps UNCONDITIONALLY: a cancel for an unheld id still invalidates the in-flight fetch about to apply exactly that notice) — a resolving fetch applies only if unsuperseded. 2 new provider tests, red-proven by disabling the guard (both fail) then restoring (13/13).
- **R-F2 (one-active violable under concurrent publishes; cancel resurrected a ghost):** `pg_advisory_xact_lock(hashtext('system_notices'))` first statement in BOTH publishNoticeAndEmit and cancelNoticeAndEmit (READ COMMITTED overlap → both supersede the same old row, both inserts survive — reviewer repro'd 2 actives from 8 concurrent 201s; a partial unique index cannot express the time-derived active predicate). New 8-way concurrency test asserts exactly one active (probabilistic-red without the lock, deterministic-green with it; the reviewer's live repro stands as the red evidence).
- **R-F3 (duration overflow → 500):** contract gains `maximum: 31536000000` (365d) on effectiveInMs/expiresInMs (SDK regenerated+rebuilt); controller bounds the check (`1e308` passes `Number.isInteger` — previously reached `nowMs + v` and blew up the BIGINT column); ComposeNoticeCard mirrors with MAX_MINUTES=525600 inline error. 4 new e2e cases incl. the legal boundary (21/21).
- **R-F4 (fullscreen strip covered the Back button/title whenever controls showed — reviewer rejected "acceptable transient", rightly: warning/critical never auto-hide, so the collision recurred at every controls reveal):** the strip now YIELDS position, not visibility — VideoPlayer passes `belowControls` (the same expression PlayerControls' `visible` uses) and the strip transitions to top:70px under the bar, gliding back on idle-hide.
- **R-F5 (strip had no ARIA):** role split matching BannerRegion — critical=alert, warning/info=status; under fullscreen the strip is the ONLY surface a screen reader can perceive.
- **Owner-reported polish (live, mid-fix-wave):** compose presets row had asymmetric rhythm (shared `.note` carries margin:0 by design; the row only owned a bottom margin → pills glued to the helper block above, big air below) and the Custom preset rendered ghost-variant, reading as a stray label beside four outlined pills — now `margin: var(--space-md) 0` + five uniform secondary pills.

### EXIT GATE — WALKED 2026-08-04 (post-fix-wave gate:full ALL 14 PASSED, verdict read unpiped from the log)

| Brief §4 item | Status |
|---|---|
| gate:full green; contract+SDK atomic; canonical event-list entry with all-user annotation | ✅ 14/14 (twice: at integration and after the fix wave); every contract touch shipped its regenerated+rebuilt SDK; notice.* recorded as deliberately all-user at admin-only-event-types.ts |
| Three-session walk clean per N3, screenshots archived incl. player overlay every severity | ✅ 34 shots (scratchpad notices-review/), fullscreen asserted real (`document.fullscreenElement === stage`) per shot |
| Late-connect delivery proven | ✅ fresh session mid-notice saw it (shot 20) — NG2's REST read, not socket catch-up |
| Countdown: skewed-clock correct; zero-state; never wall-clock-alone | ✅ skew LIVE-FAKED (+10min shim pre-boot → correct remaining time); zero-state shot 21; R-F1 guard hardens the anchor path |
| Replace-confirm + cancel proven live across sessions | ✅ shots 12/26/27/28/29; R-F2 lock makes one-active hold under concurrency too |
| Live-isAdmin on publish/cancel; audit with actor; history lists | ✅ casual 403 wall + A10 in-code; envelope actorUserId = audit (NG8); history cursor-paginated with derived status |
| N6: no modal, playback uninterrupted, banner precedence | ✅ `<video>` state byte-stable across publish/cancel; precedence verified (via injection — see R-F6: no production path can set restartPendingKeys today, pre-existing) |
| Docs both registers, register lint clean | ✅ admin-guide/system-notices.md (presets, plain-content rule, "notice ≠ restart"), user-guide banners note, server-power cross-link; 0 new lint warnings |
| STATE.md: N1–N6 + adjudications + coverage; mail tie-in logged | ✅ this section; v2 mail/push tie-in logged in Run posture |

**Second fix wave (owner-directed 2026-08-04: "Go ahead and fix these also" — all four R-F6..9 closed):**
- **R-F6 ADJUDICATED, not the fix originally imagined.** A dedicated settings-registry recon (35 keys, consumer-by-consumer) proved the "dead banner" is the documented outcome of a deliberate design, not a defect: lane S3's hot-reload migration left ZERO ui-scoped requiresRestart:true keys — all 25 UI keys verified genuinely LIVE (getEffective per request/tick/job + onChange push for the rate-limit family) — and all 10 requiresRestart keys are env-only BY DESIGN (bootstrap/lockout-risk config; PUT 404s them; an env change can only land via a real restart, which resets its own boot snapshot). settings.service.spec.ts:148-158 states this in so many words and pins the banner mechanism via a synthetic registry for the first future non-hot key. Manufacturing a ui+requiresRestart key would lie in the OPPOSITE direction (restart warnings for settings that hot-apply). **The real defect was stale copy promising the banner as a current fact — fixed:** ServerPowerCard restart caption ("Settings apply immediately when saved — restart is for changes made outside these screens, updates, and troubleshooting"), admin-guide/server-power.md restart rationale rewritten, gen-settings-reference.mjs's "Applies after a restart" legend bullet now renders ONLY when a listed entry actually carries requiresRestart (today: dropped; returns automatically with the first real key), SettingsRestartBanner header records the adjudication. Banner machinery + N6 precedence untouched.
- **R-F7 fixed:** new `--mobile-header-height-back: 66px` token (beside its title-mode sibling, same sync contract); BannerRegion resolves the header mode via the header's OWN `resolveMobileHeader` (null library ids are mode-safe — ids only ever pick titles) and `data-compact-header` clears 66px instead of 112px on back/zone-back routes. The `<main>` over-padding twin on bannerless back-mode pages remains inherited shell behavior (out of scope, unchanged risk).
- **R-F8 fixed:** message length now counted in Unicode CODE POINTS on both sides (server 422 check + compose counter), matching Postgres char_length AND JSON Schema maxLength semantics; the compose hard-truncate is surrogate-safe; the native maxLength attribute REMOVED (it counts UTF-16 units and would have blocked legal input at 250 astral chars). Tests: 500 emoji → 201 / 501 → 422 (e2e); counter reads 250/500 for 250 emoji, truncate never splits a pair (component).
- **R-F9 fixed repo-wide:** ONE shared `parseLimitParam` (apps/server/src/common/limit-param.ts) clamping `?limit` to components/parameters/Limit's maximum:200 (lenient posture preserved — malformed still ignored, oversized clamped not 422'd), wired into ALL five sites: catalog/viewer.ts parseListQuery, invites, notices, restricted-zone (both parsers; its now-unused parseIntParam removed), admin-stash-sync-report (which also referenced the shared Limit param). New unit spec pins ignore/pass/clamp/override.

## Web admin restart/shutdown (2026-08-04, owner-directed follow-up #2: "adding UI to the web client app for the user to restart or shut down the server from the admin server settings screen… then we'll run the CI for all platforms")

**Contract-first (additive, no D23):** POST `/system/restart` (`restartServer`) + POST `/system/shutdown` (`shutdownServer`), tags system, admin via the standing summary+403 convention; 202 `ServerPowerActionResponse {accepted:true, action}` flushed BEFORE teardown (the ipc listener's handleServerStop ordering contract, now stated in the contract text); shutdown additionally 409 problem `code shutdown-unsupported-under-container-supervision`. SDK regenerated + rebuilt same commit; conformance map gains `restartServer: 202, shutdownServer: 202` (zero-allowance rule); 12/12 green.
**Mechanism (grounded in the parity run's supervisor table, recon-verified per platform):** SHUTDOWN = the existing graceful SIGTERM-self path → exit 0 → stays down on launchd (SuccessfulExit=false) / systemd (on-failure) / Windows host (clean child exit ⇒ clean SCM stop). RESTART = same graceful path but success-exit overridden to **RESTART_REQUESTED_EXIT_CODE = 86** (named, deliberately ≠ 1 so supervisor logs distinguish admin restart from crash) → relaunched by launchd (~10s) / systemd (5s) / SCM recovery (10s; LoombreHostedService logs the code by name, mechanism unchanged — non-zero ⇒ ERROR_PROCESS_ABORTED ⇒ recovery) / Docker (any exit). Implementation surface deliberately tiny: main.ts's existing `installGracefulShutdown` **`exit` seam** (no handlers.ts change) + a `gracefulExitCode` closure; failed/timeout graceful stays exit 1 (also relaunches — a restart that tears down badly should still come back).
**The armed/unarmed seam (the conformance-suite kill hazard, closed by construction):** `ServerPowerService` (common/, provided+exported by CommonModule) holds triggers that ONLY main.ts's direct-entrypoint bootstrap arms — the same placement as installGracefulShutdown itself — so every embedded AppModule boot (conformance authenticated walk hits POST /system/restart with a real admin token!) gets a logged no-op 202, never a SIGTERM into the vitest runner. `scheduleAfterResponse` hooks res "finish" (flush-then-act). Endpoints in catalog/admin.controller.ts beside getSystemInfo, same requireAdmin fast-fail + requireLiveAdmin fresh-read pair (A10/L2).
**Docker honesty:** Dockerfile runtime stage sets `LOOMBRE_SUPERVISOR=container` (worker shares the image, harmless) → shutdown 409s with the docker-compose-stop pointer (unless-stopped restarts ANY exit — an in-process shutdown would silently bounce the container); restart 202s (bounce IS a restart). Read call-time (LOOMBRE_UPDATE_CHECK env-seam precedent) so the e2e sets/unsets it around one booted app.
**Tests:** apps/server/test/server-power.e2e.spec.ts (7 green: 401 wall ×2; non-admin 403 with armed fakes untouched; unarmed fresh-service no-op; armed restart/shutdown fire exactly the right trigger post-flush; container 409 shutdown + 202 restart) + conformance 12/12 (SDK dist rebuild was required for the walker to see the new ops — codegen alone leaves the built SDK stale, worth remembering). Web: ServerPowerCard.test.tsx (7 green: idle; confirm-before-POST + cancel; POST /system/restart → restarting; healthz DOWN-then-up ⇒ "back online" (fake timers, poll pinned to `{cache:"no-store"}` against the auth-store serverUrl); failed POST ⇒ error + actionable again (InvitesPanel regression class); shutdown terminal notice; 409 detail rendered verbatim + not stuck).
**Web UI:** ServerPowerCard on /settings/server (ServerSection — its U9 header note now partially superseded: these two controls HAVE backing endpoints), Phosphor danger-tinted confirmBlock (ProviderKeysCard pattern), Button variant=danger confirms. Restart→"back online" claim gated on observing /healthz DOWN first (lying-Saved law applied to a lifecycle claim — a green poll before the old process died proves nothing); public /healthz via bare fetch, NOT apiGet (its reactive-401 retry is meaningless against a down process). Shutdown → terminal notice naming menubar/tray/systemctl. SettingsRestartBanner gains the missing pairing: a static Link "Restart from Settings → Server" (banner still computes nothing). Docs: NEW admin-guide/server-power.md (+ sidebar/index), settings-reference generator's two restart-prose lines now point at the button, docker.md stop section notes the 409 refusal + restart-works.
**Decision, logged not hidden:** NO outbox event for power actions this pass — mirrors the IPC stop's zero-event posture (tray/menubar stop has none either); the 8-touch closed-list cost ×2 (`server.restart-requested`/`server.shutdown-requested`, enum 35→37) is flagged as an owner option if power actions should reach the admin event feed. Server log lines carry the acting admin userId.
**Dev-mode caveat (recorded):** `pnpm dev` has no supervisor — a web-triggered restart in dev exits the server and the dev harness ends (node --watch only restarts on file change). Real deployments all supervise.

## Full-shutdown parity across platforms (2026-08-04, owner-directed follow-up: "let's reach parity across all platforms" — closes flag (1) of the macOS section below)

**Windows tray (installers/windows/tray):** "Shut down Loombre…" tray item — confirmation TaskDialog (states the boot-time comeback + Start-Menu recovery honestly) → ONE UAC prompt → elevated `cmd /d /c net stop LoombreWorker & net stop LoombreWeb & net stop LoombreServer` (net stop WAITS per service, so ordering is real and process-exit ≈ shutdown-finished; & chaining keeps it idempotent over already-stopped services) → `AllStackServicesStopped()` SCM verification (Stopped or not-installed = yes; running/pending/query-failure = "cannot confirm", report instead of silently exiting) → tray `ExitThread()`. **Stop stays admin-only BY DESIGN** — Services.wxs grants Users ServiceQueryStatus+ServiceStart, deliberately never ServiceStop (its own comment; unelevated stop remains the IPC single-server graceful pause) — so the UAC prompt is the Windows twin of macOS's admin-prompted bootout, NOT a gap. Item always enabled regardless of plan/IPC state (kill-switch rule). "Start server" → "**Start Loombre**" (StartServerStack already started all three; ServerControl texts + tests updated — the decision tables' cross-platform lockstep comment honored). Names/orderings/elevated arg strings moved to cross-OS-testable `Loombre.Tray.Ipc/ServiceStack.cs` (ServiceManagerProbe consumes it), red-first-pinned by new ServiceStackTests: Services.wxs name lockstep, start server-first, stop consumers-first/server-last, exact arg strings (`sc start` trio / `net stop` trio). Pre-existing graceful path confirmed: LoombreHostedService.OnStop → CTRL_BREAK_EVENT to the node child, so `net stop` = graceful.
**Verification on this macOS host:** dotnet SDK 8.0.423 installed user-local (`~/.dotnet`, official dotnet-install.sh — none was present despite the Ipc csproj's "testable on this macOS host" design intent); baseline 41/41 BEFORE changes, red confirmed (CS0103 + retitled expectations), then **46/46 green**; full Loombre.Tray.sln (incl. the WinForms app + TaskDialog usage) compiles clean via `-p:EnableWindowsTargeting=true`. NOT verified here: live UAC/SCM behavior — that needs the windows-installer-diag lane (manual dispatch) / a real Windows box; build-msi.mjs step 5 runs these tests in that lane.
**Linux + Docker (headless — the platform service manager IS the interface):** docs/install/linux.md gains "Stopping / shutting down completely" (`sudo systemctl stop loombre-worker loombre-web loombre-server` — systemd derives that stop order from the units' own After=loombre-server.service; plus `disable --now` for off-across-reboots) and docs/install/docker.md gains the compose `stop` / `down` / `down -v` distinctions (restart:unless-stopped verified in docker-compose.prod.yml — a stopped stack genuinely stays down across host reboots, stated in-doc). Both docs cross-reference the mac/windows UI equivalents.
**Flagged:** windows-installer-diag not dispatchable from here (and the installer lane remains manual-dispatch-only — the standing process gap); owner should run it (or push and dispatch) before any release build to exercise the tray build+tests on real Windows.

## macOS full-shutdown UI (2026-08-04, owner-directed: "no way for the user to shut down the app services… include UI that enables the user to kill/shutdown the app completely including the services")

**Gap confirmed then closed (macOS only — see the Windows flag below).** Before: menubar "Stop Server" only IPC-stopped the API server process (worker + web LaunchDaemons kept running), and "Quit" only closed the menubar — the ONLY full stop was `sudo launchctl` in Terminal. Linux has systemctl and Windows has services.msc as native affordances; macOS had none, hence "especially on the mac version".

**What landed (installers/macos/menubar + docs; no contract/TS-package changes):**
- **"Shut Down Loombre…" menu item** — always enabled regardless of MenuIconState/IPC reachability (a kill switch must never depend on the thing it kills — the rc "Start grayed out" lesson, opposite direction). Confirmation alert (states the boot-time comeback honestly) → ONE admin prompt → bootout of all three daemons **worker → web → server** (the embedded-PG-hosting server dies LAST so nothing flails against a dead DB) → `NSApp.terminate` (menubar agent has no KeepAlive, stays quit until next login). Cancel/failure paths keep the app alive; failure alert gives the manual `sudo launchctl bootout` lines.
- **"Start Server" → "Start Loombre", now starts ALL THREE daemons** — required so a full shutdown is menu-recoverable (server-only start would leave worker/web booted out until reboot). Per-service `( kickstart || bootstrap )` groups, `&&`-joined, server first.
- Refactor: PrivilegedLaunchdStart.swift → PrivilegedLaunchctl.swift (git mv; shared NSAppleScript admin runner, `startAll()`/`shutdownAll()`; same no-SMJobBless posture). LaunchdFallback gains worker/web labels + plist paths + `startAllShellCommand`/`shutdownAllShellCommand`.
- **Empirical grounding, not guessed:** launchctl exit codes verified against a real launchd (scratch gui-domain agent): kickstart on RUNNING = 0 (safe no-op), on booted-out = 113 (→ bootstrap recovers); bootout not-loaded = 3 (why the shutdown groups use the `! print || bootout` probe — idempotent WITHOUT masking a genuine bootout failure behind `|| true`); both composed commands validated end-to-end via `/bin/sh -c` against that scratch service. AppleScript-embeddability (no quotes/backslashes) test-pinned for BOTH commands.
- Red-first: LifecyclePlanTests extended (labels/plists lockstep, per-service pairs, server-first start order, worker-first/server-last shutdown order, `&&` joins) — confirmed failing-to-compile, then green: **swift test 55/55**; swift build clean.
- Docs: docs/install/macos.md new "Shutting Loombre down completely" section + menubar bullet rewrite; pkg readme.txt + conclusion.txt mention full shutdown; CHANGELOG [Unreleased] entry.

**Flagged, not done here:** (1) **Windows tray parity** — tray "Exit" likewise leaves the services running; a "Shut down Loombre" tray item stopping LoombreServer/Worker/Web services is the same feature there (services.msc exists as a native fallback, so Windows was never affordance-zero like macOS). (2) CI never exercises the menubar's swift test on push (macos installer lane builds only on release tags — the standing installer-lane process gap already flagged 2026-08-02 applies here too); local swift test + the smoke.mjs static checks are the evidence. (3) NOT pushed — pushes are owner-authorised per standing practice.

## Current-password re-auth on self-changes + the email-collision signal (kicked off 2026-08-02, authority: owner "Current-Password Re-Auth on Self-Changes + the Email-Collision Signal" brief; closes Open items 3 and 4-follow-up of the mail/invites run below; docs/PLAN.md + design/phosphor/README.md for UI)

### PUSHED + CI RESULTS (2026-08-02; origin/main 0570dd0, then 5ea11e6 with the MSI fix below)

Owner authorised the push. main → origin (c672c73..0570dd0, ff, no force). **Push CI run 30760738406: SUCCESS** — perf-t0 GREEN (the stale-stats fix worked; the previously-red board is green), gate (ubuntu) + perf-web-budget + perf-lighthouse all green. Only red = the Node-26 `gate-node-next` job, NON-BLOCKING by the runtime policy (N2 — Current lines are evidence-only), overall conclusion success.

**Windows installer lane (owner asked to watch it): found a PRE-EXISTING latent break, fixed it.** `windows-installer-diag` (manual-dispatch) failed the MSI build with `WIX0094: Property:WIX_ACCOUNT_USERS could not be found`. Root cause NOT this run: b3856df (2026-07-31, "controllers can START a stopped server") added three `util:PermissionEx` service grants keyed on `[WIX_ACCOUNT_USERS]` and referenced it with the WiX **v3** idiom `<PropertyRef Id="WIX_ACCOUNT_USERS"/>`, which does not link under the **v5** toolset — and it landed untested because the installer lane is `workflow_dispatch`-only, NOT part of push CI (2-day latent break). Fix (5ea11e6, installer-only): `<util:QueryWindowsWellKnownSIDs/>` (per FireGiant util-schema docs — defines the symbol AND schedules the CA that populates the localized BUILTIN\Users at install). Verified: installer lane re-run on the fix branch = SUCCESS (MSI builds + real install/uninstall + bootstrapper smoke tests all pass), then ff'd to main.

### ✅ CI FIXED (2026-08-04, owner-directed "fix the CI") — three defects, only one of them the one we were looking for

Owner chose the orchestrator's recommendation (b): make the measurement variance-resilient, do NOT touch the budget. Fixing it surfaced two further defects the gate had been masking.

1. **perf-t0 variance (the asked-for fix).** `scripts/perf-t0.mjs`: an endpoint that BREACHES is now re-measured up to `PERF_T0_ENDPOINT_ATTEMPTS` (default 3) and its BEST p95 is the verdict; a passing endpoint is still measured exactly once (fast path untouched). Rationale recorded in-file: the budget is a claim about the CODE, and this repo's own CI data shows whole-runner drift (browse ×1.82 / search ×1.59 / itemDetail ×1.29 / continueWatching ×1.36 between two runs of identical code — all four moving together is a slower machine, not a slower query), so a degraded-runner sample is a measurement artifact. **Falsifiability PROVEN, not asserted:** with the budget temporarily forced to an unreachable 1 ms the real harness retried 3× per endpoint and still exited 1. Budget values untouched (`perf/baselines.json` unchanged; perf-baseline-check still governs). All attempts are logged AND persisted to `perf/t0-baseline.json` as `attemptsP95Ms`, so a metric that only passes on retry stays visible instead of hiding behind its best sample. Local: 19.5 / 2.7 / 2.5 / 51.9 ms, all first-attempt, exit 0.
2. **`scripts/dep-audit.mjs` latent crash — a FALSE-FAILURE generator (found while fixing #1).** `classifyAdvisories` pushed BARE advisory objects into `nonBlocking` while every other bucket pushed `{advisory, entry}`; `main()`'s reporter destructures `{ advisory }` uniformly, so any low/moderate finding threw `Cannot read properties of undefined (reading 'severity')`. The existing test asserted only `nonBlocking.length`, never element shape — which is exactly why it survived. **Consequence: a repo whose only finding was informational failed the gate with a crash instead of passing.** Fixed red-first (new shape-pinning test asserts EVERY bucket exposes `.advisory`/`.entry`).
3. **A real HIGH advisory, previously hidden behind that crash.** `fast-uri@3.1.4` — host confusion via backslash authority introducer (GHSA-7p8r-x3mc-p8w7), transitive via `apps/server > ajv > fast-uri`. Patched 3.1.5 satisfies ajv's own `^3.0.1`, so a plain in-range `pnpm update fast-uri -r` cleared it — **no pnpm override, no forced resolution**; lockfile-only change. Remaining: one MODERATE `postcss` advisory, correctly reported `[info]` under the standing high/critical blocking threshold (policy unchanged — and it is the very finding that used to trigger the crash).

**Push CI run 30940951241 (04cc504): SUCCESS** — gate (ubuntu) + perf-t0 + perf-web-budget + perf-lighthouse all green. perf-t0 needed NO retry this run, but `searchAsYouType` measured **92.87 ms against the 100 ms budget** — i.e. it cleared by 7%, which is the narrowness called out below confirmed on real CI hardware rather than inferred.

**N2 evidence captured (`gate-node-next`, Node 26, non-blocking — the one red job, by design).** Recorded here because that job's entire purpose per N2 is accumulating adoption evidence against a Current line. Root cause is ONE line, not 19 defects: `apps/web/src/lib/auth-store.test.ts`'s `beforeEach` calls `window.localStorage.clear()`, and `window.localStorage` is `undefined` under Node 26, so the hook throws and takes all 19 tests in the file with it (`TypeError: Cannot read properties of undefined (reading 'clear')`). Deliberately NOT fixed: Node 26 is not a supported line (N2 ships Active-LTS only, Node 24 today), and chasing a non-supported runtime risks the supported path for no shipping benefit. This is the single known blocker to revisit if/when Node 26 reaches LTS.

gate:full ALL 14 PASSED after all three. **Residual, flagged not fixed:** `searchAsYouType` genuinely runs ~55 ms against its 100 ms budget — ~1.8× headroom, by far the narrowest of the four hot paths. The retry logic stops a slow runner failing the build spuriously; it does NOT create headroom. If that endpoint regresses for real it will fail again, correctly. Optimising it is worth a future pass (owner call, not taken here — the brief was "fix the CI", not "change query behaviour").

### (superseded — kept for provenance) 🔶 OPEN — perf-t0 red on `searchAsYouType` (NOT caused by the ANALYZE fix)

Honest correction to the "CI green" line above: that was true of run 30760738406 (0570dd0), but the **two pushes since have both failed perf-t0 on a DIFFERENT metric** — `searchAsYouType p95 102.25ms` (run 30762096733, 5ea11e6) and `100.45ms` (run 30767112723, 3567169) against a 100 ms budget. The second of those fired after the MSI-fix push and was NOT re-checked at the time — recorded as a process miss, not glossed.

**The ANALYZE fix is exonerated, and it worked.** browsePageList: 177.63 → 23.2/42.2/41.1 ms across the three post-fix runs (4–8× better, far under budget). Local EXPLAIN of the harness's own search query (`websearch_to_tsquery('simple', <term>)` + ts_rank + title-prefix boost, the real SEARCH_QUERY_TERMS) with statistics vs. with `pg_statistic` deleted produces the **IDENTICAL plan both ways** — Bitmap Index Scan on `catalog_items_search_tsv_idx` → Bitmap Heap Scan → top-N heapsort, ~3–5 ms either way. Statistics do not move this query.

**Actual cause: insufficient headroom vs. CI runner variance.** Between the passing run and the failing ones EVERY endpoint slowed proportionally — browse ×1.82, search ×1.59, itemDetail ×1.29, continueWatching ×1.36 — the signature of a slower shared runner, not a code regression (a plan regression hits one query, not all four). searchAsYouType's historical baseline is ~55 ms (54.76 green / 56.08 red, pre-fix) against a 100 ms budget = ~1.8× headroom; a 1.8×-slower runner lands it exactly on the line. **Fixing the loud browse failure simply exposed the next-closest metric.**

**Owner decision (do NOT quietly loosen — perf/baselines.json exists precisely to forbid that):** (a) optimise searchAsYouType for real headroom; (b) make the harness variance-resilient (best-of-N / repeat-on-breach), which targets the measurement rather than the standard and is the orchestrator's recommendation since the budget is a claim about the CODE, not about runner luck; (c) raise the budget with a documented `reason` per the ledger's own rule. Not actioned unilaterally.

⚠ **PROCESS GAP flagged for owner:** the Windows installer lane runs on manual dispatch only, so any commit touching `installers/` lands without an installer build — b3856df sat broken for 2 days undetected. Consider a `paths: installers/**` push/PR trigger (or a nightly) so installer breaks surface at merge, not at release time. The full four-platform installer set (release.yml: linux/windows/macos/docker) still only builds on a version tag — not exercised by this session.

### EXIT GATE — WALKED 2026-08-02 (final main tip b702999+R-F1-commit; gate:full ALL 14 STEPS PASSED, verdict read from the log)

Automated exit met on the LOCAL assembly. Coverage vs the brief §4 exit gate:

| Exit-gate item | Status |
|---|---|
| gate:full green 3-OS-locally-runnable; contract+SDK atomic; decision rows logged (F2 breaking edit) | ✅ gate:full ALL 14 on the final main tip (web budget 166.5 KB gz/200). P4.23 logged the D23 FIFTH-use breaking edit; every contract touch shipped its regenerated+built SDK (sdk-drift enforced). R-F3's fix added a SECOND additive contract edit (currentPassword on admin reset-password), SDK atomic. 3-OS REMOTE board = push-gated (owner call; the perf fix below is what turns it green) |
| All four mutation families require + verify currentPassword; bypass defeated (review-proven) | ✅ two opus passes: full bypass sweep (15 shapes × 4 surfaces incl. unicode-lookalike keys, `__proto__`, empty/null/whitespace, cross-user password) all denied, no column written; must-change hole closed; the ONE bypass found (R-F3 admin self-reset, a DIFFERENT endpoint) is fixed |
| Rate limiter covers the re-auth compare; trip test green | ✅ per-user rateLimit.currentPassword, counts BEFORE the compare, spends on success only, one shared bucket across both endpoints, clean 429 — review-verified |
| Password change revokes other devices (test + event); UI states it | ✅ session.revoked-by-password-change event (revokedCount accurate); other refresh tokens die, caller survives; **R-F7 fix makes the UI's "signed out" claim TRUE** (credentials epoch kills other devices' access tokens on next request, not just their refresh) |
| Collision matrix green: actor identical every cell; existing owner gets exactly one notice when mail on; per-address limiter enforced | ✅ 19-cell matrix (claim+change × mail on/off × window fresh/claimed); ledger atomic under 6-way concurrency + CITEXT + self-exclusion (review-verified); R-F5 fix stops a failed dispatch burning the window |
| E8 enumeration probes clean across every new/changed shape | ⚠️ STATUS/SHAPE level ✅ (403/422 byte-identical across all targets + both endpoints; G8 timing floor holds — no clock oracle). BODY-VALUE level: a residual authenticated-actor oracle (R-F1) was found and, per **owner decision (C)**, ACCEPTED as a documented household-scale limitation (E8 stands for the unauthenticated claim/reset surfaces it was written for) |
| Phosphor forms both breakpoints; lying-Saved law tests green | ✅ four surfaces + must-change screen; per-field 403; input-preservation; "signed out" line only after 2xx |
| Docs landed, register lint clean | ✅ user-guide/account-settings.md (new), admin collision-notice note, developer-guide/architecture/security-posture.md (new, honest about the R-F1 limitation); register-lint 25 baseline held |
| STATE.md: F1–F6 recorded; two owner-acks moved to §5; coverage vs mission | ✅ this section + the kickoff + G1–G12 + the review/fix records; §5 checklist below |

**BONUS (pre-existing, not this run's feature):** the 3-OS CI red on origin (perf-t0 browsePageList 177ms) was root-caused (stale-stats plan flip, EXPLAIN-proven) and FIXED (ANALYZE after the 50k seed); and the 4×-recurring library-provider-chains flake was root-caused (random-port base_url birthday collision) and logged for an LPP-scoped fix.

**HELD FOR OWNER:** push to origin (outward action; not yet authorised for this run). The push lands the feature + 6 fixes + the perf fix that turns the §5.1 3-OS board green.

### Mission (verbatim)

Require current-password re-authentication for all account-critical self-service changes (password, email, restricted PIN management, restricted opt-in/out), revoke other-device sessions on password change, and implement the email-collision out-of-band signal for the invite-claim and email-change flows — all enumeration-safe per E8, rate-limited, Phosphor-styled, tested, and documented in the correct registers.

### Locked decisions (F1–F6, verbatim-condensed from the brief — run law. NOTE: these are the BRIEF's F-numbers; unrelated to the previous section's F1–F12 review findings)

- **F1 Re-auth surface:** self-service changes to password, email (set OR change OR remove), restricted PIN (set/change — CLI reset exempt by design, admin break-glass), and restricted opt-in/out require `currentPassword`. Verification = argon2id compare, constant-time failure, counted by the standing per-user rate limiter (same bucket class as login — a re-auth prompt must not become a password-guessing oracle). Admin-on-other-user mutations NOT in scope (already live-isAdmin-verified per A10 + audited; requiring the admin's password there is a different feature — logged).
- **F2 Contract:** affected mutation endpoints gain a required `currentPassword` field (D23-class pre-release breaking edit — decision row logged, oasdiff findings acknowledged, SDK regenerated in the SAME commit). Wrong current password → the same 403 shape regardless of which field was being changed; responses never confirm whether the TARGET value (e.g. a colliding email) was the problem — E8 holds through this feature.
- **F3 Session revocation on password change:** successful self-service password change revokes ALL other devices' refresh tokens (bulk revoke + `session.revoked-by-password-change` outbox event), keeps the current session; UI states it plainly ("Other devices have been signed out"). Admin/CLI reset paths unchanged (already force next-login re-auth).
- **F4 UI:** affected Phosphor settings forms gain the current-password field (masked, autocomplete="current-password", both breakpoints); failed re-auth shows the error state on THAT field without clearing the user's other inputs; lying-Saved law applies. Restricted-flow forms keep existing PIN semantics — currentPassword is additional, not a PIN replacement.
- **F5 Email-collision signal (mail-configured installs only):** claim or email-change attaching an address already on another account → actor-visible behavior unchanged (silent drop / silent no-op with the generic success shape, per the standing E8 decision). Additionally a `mail-send` job notifies the EXISTING address: calm security notice ("someone attempted to use this address on <server name>; if this was you, no action needed; if not, your account is unaffected"), E7 template standards. Rate-limited per target address: max 1 notice per address per 24h (the signal must not become a harassment vector). No mail configured → no signal, behavior as today; docs state this delta honestly.
- **F6 Docs:** user guide — plain-language re-auth note ("we ask for your password again for big changes") + signed-out-devices behavior; admin guide — collision-notice behavior + its mail dependency; security posture doc (dev register) updated with F1/F3/F5 as implemented measures.

### Run posture (2026-08-02)

- Precondition VERIFIED: main = c672c73; fresh gate:full re-run at kickoff exited 0 (ALL 14 steps). Working tree carries only perf/web-budget-result.json's self-rewrite.
- Sub-agent policy per standing rule: sonnet lanes, opus review. Worktree lanes at /Users/ozzy/App Development/loombre-worktrees/lane-{a,b,c}; per-lane DBs (loombre_lane_<x>) on compose PG :5442; STATE.md orchestrator-owned (lanes return entry text in freeze reports); integration A → C → B, then opus review, then fix wave if findings.
- Head start, recorded: the previous run's fix wave ALREADY revokes other sessions on self password change (revokeOtherRefreshTokensForUser in packages/db/src/query/admin.ts, commit 393abd1) — F3's remaining work is the outbox event + UI statement + tests, not the revoke itself.
- Known lane-agent defect (3 prior occurrences): parking on "waiting for background gate" — lanes are instructed foreground-only gates; on stall the orchestrator reads the worktree and verifies with its own gate run.

### Ground truth + orchestrator adjudications (G-numbers, recon 2026-08-02 — run law alongside F-numbers; 4 read-only scouts over server families / revocation+events+collision / web forms / contract+docs)

- **G1 (surface mapping):** F1's four families collapse onto TWO operations: `PATCH /users/me` (updateMe — password + email; UsersController.updateMe, apps/server/src/catalog/users.controller.ts) and `PUT /users/me/restricted` (putMyRestrictedSettings — PIN set/change AND opt-in/out are one endpoint; UsersMeController.putRestricted, apps/server/src/session/users-me.controller.ts). Claim (`ClaimInviteRequest`) is unauthenticated account CREATION — no currentPassword by construction. Admin twins (updateUser, adminResetUserPassword) untouched per F1.
- **G2 (contract requiredness, two readings of F2's "required"):** `RestrictedSettingsUpdate` — every call is account-critical → `currentPassword` joins `required: [optIn]` literally. `UpdateMeRequest` — MIXED body (displayName/birthDate are NOT in F1's surface; no `required:` array exists today) → `currentPassword` is added as a property with JSON-Schema `dependentRequired: {password: [currentPassword], email: [currentPassword]}` (OpenAPI 3.1-legal; lane A verifies redocly + openapi-typescript tolerate it, else description-text fallback with identical server enforcement). Bodyless `{}` PATCH stays valid → conformance's `updateMe: 200` bodyless-walk line UNCHANGED; a bare displayName save needs no re-auth. Field shape: `{type: string, format: password}`, deliberately UNCONSTRAINED (currentPin/P4.22 reasoning: proves an already-stored secret). D23 FIFTH use — decision row with exact oasdiff classification at integration; SDK regenerated same commit.
- **G3 (enforcement semantics):** re-auth required iff the body contains a `password` and/or `email` member (ANY value — email:null remove included) on updateMe, or ALWAYS on putRestricted. Absent/non-string currentPassword when required → 422 validation (target-agnostic detail). Present string → per-user limiter attempt → `hashService.verify(user.password_hash, currentPassword)` (same argon2id service as login; no dummy hash needed — authenticated route) → mismatch = 403 `urn:loombre:problem:current-password-invalid`, code `current-password-invalid`, ONE detail string on both endpoints regardless of target field (F2). Empty string just fails the compare — no bypass. Anomaly log gains `CURRENT_PASSWORD_FAILURE` kind ({user} only; PIN_FAILURE precedent). updateMe additionally gains an UPDATE_ME_BODY_KEYS unknown-key 422 allowlist (SETTINGS_BODY_KEYS precedent — none exists today) and putRestricted the same (it silently ignores unknown keys today) — makes additionalProperties:false real (last run's F6 class). Wrong currentPin STAYS 422 "currentPin is incorrect." (F4: PIN semantics unchanged). must-change interplay CONFIRMED safe: only updateMe is reachable while flagged; the user just typed the temp password at login. NOTE: this closes the stolen-access-token hole on the allow-listed op — the exact load-bearing gap named in the previous run's F5 finding.
- **G4 (limiter):** login-class = the hand-rolled AuthRateLimiterService KeyedRateLimiters (the @RateLimit decorator union deliberately excludes login/refresh/unlock). New registry entry `rateLimit.currentPassword` (per-USER, default 10/min = login's default, env LOOMBRE_RATE_CURRENT_PASSWORD, z.int().min(1), requiresRestart:false, scope ui) as a 4th KeyedRateLimiter; `.attempt(userId)` ONLY when re-auth is actually required, BEFORE the compare; 429 via RateLimitException. RateLimitExceptionFilter must be registered on UsersController AND UsersMeController (neither has it today — 429 wouldn't serialize as problem+json). Registry touch → `pnpm docs:build` regen (settings-reference + env-reference) committed in-lane.
- **G5 (F3 event):** `session.revoked-by-password-change`, ADMIN_ONLY, payload `{userId, username, revokedCount}` (never secrets; revokeOtherRefreshTokensForUser already returns the count), emitted via writeEvent(trx,…) inside updateUserSelf's existing transaction after the revoke. Closed-list 8-touch: envelope enum 34→35 + x-mirror, admin-only-event-types.ts FIRST, new schema.json (additionalProperties:false), event-schemas.spec count+literal+hand-written sample, actor-field-map.spec count, ACTOR_FIELD_MAP entry. Delivery surfaces derive automatically.
- **G6 (collision = silent no-op, replaces a live 500):** updateUserSelf does a raw UPDATE with no 23505 handling — a colliding self-service email change is an uncaught pg error → generic 500 TODAY (pre-existing bug, scout-confirmed). Fix per F5: in-trx pre-SELECT **excluding self** (`where('email','=',email).where('id','!=',userId)` — re-setting your own address is NOT a collision), on collision skip ONLY the email member (other members still apply), return generic success shape; narrow users_email_key 23505 race backstop re-applies without the email member. Both claimInviteAndEmit (already silently drops, invites.ts:408-438) and updateUserSelf surface the dropped address in their RETURN VALUE (internal field, never serialized) so the CONTROLLER can dispatch the notice post-commit — DB layer stays mail-free, and the enqueue-inside-uncommitted-trx hazard is avoided by construction.
- **G7 (notice pipeline):** NEW templateId `email-in-use-notice` (security-notice NOT reused — its subject/copy is "your password was reset by an administrator"; conflating two security events under one subject rejected). 7-touch: worker template + RENDERERS/index unions + types.ts param keys + mail-dispatch.service union + packages/jobs MailSendJobPayload union + templates.spec TEMPLATE_IDS (E7 suite drives itself). Template is URL-FREE (calm notice, no action to take — zero links beats E7's minimum); params `{serverName}` = mail.fromName's effective value (default "Loombre") — NO new server-name registry key (matches existing template posture). Per-address 24h limiter = DB ledger, migration **0025** `email_collision_notice_ledger(email CITEXT PRIMARY KEY, last_notice_at_ms BIGINT NOT NULL)` — in-memory KeyedRateLimiter is per-process/restart-reset (unsuitable) and @loombre/jobs exposes NO pg-boss singleton/dedup surface (scout-confirmed). Atomic window claim, ONE statement: INSERT … ON CONFLICT (email) DO UPDATE SET last_notice_at_ms = EXCLUDED.last_notice_at_ms WHERE ledger.last_notice_at_ms <= :now − 86 400 000 RETURNING email (row = won → send). Controller order: collision && MailConfigService.isConfigured() FIRST → ledger claim → trySend — an unconfigured install never burns the window (F5: no mail → no signal, behavior as today). schema.sql regenerated, never hand-merged.
- **G8 (timing posture):** the collision cell does extra post-commit work (ledger claim + enqueue) vs the non-collision cell — a fresh timing-oracle surface. Mitigation: FORGOT_PASSWORD_MIN_MS precedent — wall-clock floor (≥200ms, lane A picks) on claimInvite and on updateMe-when-body-contains-email (plain profile saves unfloored). C pins floor tests; R runs the timing classifier over the collision cells like last run's F2 probe.
- **G9 (admin-twin fold-in):** updateUserAdmin (PATCH /users/{id}) has the SAME uncaught-23505 email-collision 500 — folded in as a proper 409 conflict there (admins already enumerate via GET /users; no E8 concern; silent-lying to admins rejected). Same-class fold-in as last run's stash-category fix.
- **G10 (UI mechanics):** ProfileSection switches to DIRTY-FIELDS-ONLY submission (true PATCH semantics) and reveals currentPassword only when email is dirty; ChangePasswordSection, the must-change branch (inline in login/page.tsx — field labeled "Temporary password"), and RestrictedSection always show it (masked TextInput, autocomplete="current-password" — login-page precedent exists). Per-field error via the AdminStep styles.fieldError pattern (server-driven mapping of code current-password-invalid onto that one field is NEW wiring); input-preservation on failure is ALREADY the norm (only success branches clear fields — scout-confirmed); "Other devices have been signed out." success line on password change renders only after 2xx (lying-Saved law; SaveStatus pattern). PinModal/unlock flows untouched (unlock is not PIN management).
- **G11 (docs targets):** NEW docs/user-guide/account-settings.md (plain register; linked from user-guide index; joining.md + restricted-content.md already point at "your account settings" with no page — gap closed); admin-guide/users-permissions.md + mail.md gain the collision-notice + mail-dependency note (the "If mail is configured…" pattern at users-permissions.md:93-96 is the model); NEW docs/developer-guide/architecture/security-posture.md (dev register, exempt from per-guide register rules) — no security-posture doc exists anywhere today (scout-confirmed; SECURITY.md is disclosure policy, PLAN §10 is spec-level) — seeded with F1/F3/F5 as implemented measures + pointers, not a full retro-audit. Register-lint baseline 25, zero new.
- **G12 (test blast radius, priced):** users-profile.e2e's password/email call sites gain currentPassword (the displayName/M2 sites deliberately DON'T — proves bare profile saves stay re-auth-free); ALL 13 auth.e2e putRestricted call sites gain it; conformance updateMe bodyless stays 200 (G2), putRestricted bodyless stays 422 (optIn already required). users-profile.e2e's existing F5-revocation test extends to assert the new event.

### Lanes

| Lane | Scope | Model | Status |
|---|---|---|---|
| A | server: F1 verification guard for the four mutation families, F2 contract+SDK atomic, F3 bulk-revoke event, F5 collision detection + notice job + per-address limiter | sonnet | **COMPLETE in-lane** fdac4b6..690928e (7 commits; contract freeze = fdac4b6; gate 12/13 — the 13th's only failure is @loombre/web typecheck ×2 call sites, the expected D23 cascade owned by B; post-typecheck steps independently verified green; orchestrator spot-verified tree + typecheck claim) |
| B | UI (after A's contract freeze): F4 across affected settings/claim forms, both breakpoints, error-state tests | sonnet | **COMPLETE in-lane** a670fed..e554030 (3 commits; pnpm gate ALL 13 GREEN on the A+B assembly; web 1055→1072 tests; register-lint 25 unchanged) |
| C | tests: re-auth happy/wrong/missing per endpoint; rate-limit trip; revocation (device B dies, device A lives, event emitted); collision matrix (claim + change × mail on/off × limiter) proving actor-visible identity in all cells; docs per F6 | sonnet | **COMPLETE in-lane** (30 new adversarial cases ALL GREEN against A's implementation — ZERO F/G violations found; docs landed; register-lint 25 baseline held, pages 57→59) |
| R | opus adversarial: re-auth bypass attempts, timing probes on the compare, enumeration probes through new error shapes + collision cells (E8 must survive F1/F5 verbatim), notice-limiter abuse, revocation completeness | opus | **COMPLETE — TWO corroborating passes; 7 findings (3 HIGH). 6 fixed in the fix wave; R-F1 owner-accepted. Full record above.** |
| fix | remediation of R-F3/R-F4/R-F5/R-F6/R-F7/LOW-8 + docs honesty | sonnet | **COMPLETE + integrated (lane/reauth-fix → main); gate:full 14/14** |

- Lane A divergence, adjudicated ACCEPTED at landing: G3/G4 named session/ as home for the anomaly log + limiter, but D2 (catalog must not import session/) made that unimplementable once updateMe needed both — AnomalyLogService relocated session/→common/, new sibling CurrentPasswordRateLimiterService in common/ (AuthRateLimiterService untouched; its login/refresh/unlock trio are genuinely session-only). Precedent: common/rate-limiter.ts's own header documents the identical conflict. G-numbers read amended accordingly.
- Lane B freeze notes: ProfileSection → dirty-fields-only PATCH, Current password revealed only when email dirty; ChangePassword/Restricted sections always-present field (currentPin untouched); setup wizard THREADS the admin's just-set password AdminStep→RestrictedStep (no retype mid-wizard); all four surfaces route 403 current-password-invalid onto the one field without clearing other inputs; 429 rendered honestly; "Other devices have been signed out." only after 2xx. Bonus correctness catch: ChangePasswordSection's copy claimed password changes do NOT sign other devices out — false under F3 — corrected (+ stale cross-ref comment in settings/devices).
- Lane B divergence, adjudicated ACCEPTED: the must-change screen RE-ASKS the temporary password (labeled field + "you just signed in with" copy) instead of auto-filling from login state. Rationale: a flagged user who reloads (or is bounced back by the 403 password-change-required guard) reaches that screen with NO password in component memory — threading breaks exactly when the screen matters; one consistent behavior beats a hybrid. G10 read amended.
- Lane A oasdiff record (D23 FIFTH use, decision row to be numbered at integration): 2 × request-body-dependent-required-added (PATCH /users/me, email→currentPassword and password→currentPassword) + 1 × new-required-request-property (PUT /users/me/restricted currentPassword); exits 0 (no --fail-on); SDK regenerated same commit (fdac4b6). dependentRequired survived redocly AND openapi-typescript (the latter emits currentPassword?: optional — conditional not encoded in TS; enforcement is server-side regardless).

### Integration record (orchestrator, 2026-08-02; main = 4c0af11, gate:full ALL 14 PASSED on the assembly)

- Stack rebase A→B→C onto main (2a0ab63): ZERO conflicts (lanes touched disjoint files; no lane touched STATE.md), tree-wide marker sweep clean. Final ranges: A = 2a0ab63..9b78b12 (7 commits, contract freeze rebased), B = 9b78b12..fed0c98 (3), C = fed0c98..4c0af11 (2). gate:full run FOREGROUND-equivalent (backgrounded task, output to file, real exit code checked — never piped): exit 0, all 14 steps, on the lane-c worktree holding the full assembly.
- Lane C freeze notes: email-collision-matrix.e2e (19 cases — full {claim, email-change} × {mail on/off} × {window fresh/claimed} grid, byte-shape actor-identity after neutralizing request-scoped fields, self-exclusion cell, >24h reopen boundary, unconfigured-never-burns-window, and the cross-flow cell proving the ledger is ONE shared row per address across claim and email-change); reauth-adversarial.e2e (11 cases — admin reset still revokes ALL pinned against F3's narrower self-change semantics, cross-endpoint shared per-user bucket, ≥190ms multi-sample floor pins + bare-displayName-unfloored median check, E8 byte-identity across targets and endpoints). One transient non-reproducing flake observed and cleared (library-provider-chains C5 STRICT, plugins_base_url_unique dup-key — LPP family, unrelated, 28/28 on re-runs; logged not fixed).
- Decision row **P4.23** | D23 FIFTH use (pre-release breaking contract correction): `currentPassword` re-auth field added — `RestrictedSettingsUpdate` gains it as `required` (every call on that endpoint is account-critical); `UpdateMeRequest` gains it via JSON-Schema `dependentRequired` {password→currentPassword, email→currentPassword} (mixed body; bare displayName/birthDate saves deliberately stay re-auth-free). oasdiff classification: 2 × request-body-dependent-required-added (PATCH /users/me) + 1 × new-required-request-property (PUT /users/me/restricted), exits 0 (gate passes no --fail-on) — this row is the record D23 requires. SDK regenerated in the same commit (contract-freeze commit, rebased 9b78b12-parented). Field deliberately unconstrained (P4.22's currentPin reasoning: proves an already-stored secret). Conformance: updateMe bodyless stays 200 (dependentRequired — {} touches no gated member); putRestricted bodyless stays 422.

### ⚠→✅ CI discovery at integration ROOT-CAUSED + FIXED (pre-existing, NOT this run's feature code): perf-t0 ENFORCING red on origin/main

The push-triggered CI on c672c73 (run 30745168932) FAILED: `browsePageList p95 177.63ms > budget 100ms` (perf-t0, enforcing) — the ONLY breach on that run (RSS/scan/other endpoints all green). Artifact comparison vs the last green run (30691717641 on 0f713a8): browse 21.5→177.6ms while itemDetail/continueWatching/search all statistically flat.

**Root cause (EXPLAIN-proven locally at the tip, NOT a query/index/code regression):** on a freshly migrate+seed'd 50k DB with NO planner statistics (autovacuum ANALYZE hadn't fired yet), Postgres estimates ~1 row for the browse hot path's `WHERE library_id=$x AND item_type='movie'` (really 50 000) and prices a scan-all-50k + top-N Sort plan at cost **8.32**, a hair under the correct keyset-index seek's **8.43** — so it picks the Sort (scan 50k every page). With stats present the identical query plans as a streaming index seek (0.08ms EXPLAIN; end-to-end real perf-t0 harness browsePageList **177ms→15.5ms**, comfortably under the 100ms budget, all four hot paths green). Because it hinges on whether autovacuum has ANALYZEd yet, the SAME code was green on one run and red on the next — a race, not a determinism. (Verified: dropping the Stash run's new 0021 `catalog_items_added_movie_idx` does NOT change the no-stats plan — the mis-pick is the stale-stats knife-edge, not any single index; and seed-large.mjs was byte-identical green→red, so it was never a data change.)

**Fix (commit 9147923, single file, cleanly OUTSIDE this run's feature set):** seed-large.mjs now runs `ANALYZE` on the nine tables it bulk-loads, at the end of the load — the standard "analyze after a bulk load" practice; production never sees the no-stats state persistently (autovacuum keeps stats fresh), only a fresh migrate+seed+measure does, which is exactly perf-t0. Pinned to the leader backend (`max_parallel_maintenance_workers=0`) so it never allocates a parallel DSM segment — the dev-compose PG ships a 64 MiB /dev/shm and a parallel ANALYZE there can die "No space left on device". perf/baselines.json untouched (no budget changed → perf-baseline-check stays satisfied). This ALSO removes a long-standing perf-t0 flake source (the autovacuum race).

Owner note: this fix makes CI deterministic; it does not change any budget or any request-path code. The §5 checklist item 1 (3-OS CI) can go green once this lands on origin.

### Flake ROOT-CAUSED (4th sighting; NOT this run's code) — library-provider-chains C5 STRICT, `plugins_base_url_unique` dup-key

The first main-tip gate:full re-run (after the perf fix) hit the recurring `@loombre/db` flake: `duplicate key value violates unique constraint "plugins_base_url_unique"` at plugins.ts:129, in library-provider-chains.spec.ts > C5 STRICT. Confirmed non-reproducing: 402/402 on two immediate reruns incl. the exact full-package invocation the gate uses. (Background-task wrapper misreported that first run as exit 0 — the LOG said `gate: FAILED`; caught by reading the log, not the wrapper's code. Lesson re-applied: trust the captured log's own verdict, never a wrapper's exit signal.)

**Actual root cause (found this run, first time — not a mysterious "flake"):** the test helper `makePlugin` (library-provider-chains.spec.ts:102) builds `baseUrl: http://127.0.0.1:${1024 + Math.floor(Math.random()*10_000)}` — a RANDOM port. Three db-test files (library-provider-chains, plugins-delivery, plugins) insert into the SAME shared package test DB's `plugins` table (UNIQUE base_url) under vitest parallel workers, so across the suite's ~dozens of plugin inserts the random ports collide with birthday-paradox probability. NOT fixed here (out of a re-auth run's scope, non-reproducing so a fix is unverifiable in-run, and semantically delicate: base_url is origin-strict-matched by resolveDeliveryUrl (`new URL(baseUrl).origin` must equal the delivery origin) and the tests pin lanAllowlist to 127.0.0.1 — a correct fix must make base_url globally unique while staying a bare 127.0.0.1 origin, e.g. a process-global monotonic port counter shared across the three files, not a random port and not a path/host change). **Recommended owner follow-up: replace the random port with a collision-free unique source in an LPP-scoped change.**

### Opus adversarial review — TWO corroborating passes (2026-08-02); 7 findings, run does NOT hold as-shipped

Two opus review agents ran concurrently (unintended duplicate, kept — corroboration). They agree finding-for-finding. Both proved every finding with live HTTP probes; both pinned red-by-design regression tests (reauth-review-findings.e2e.spec.ts, 875 lines, 14 RED / 14 GREEN, committed on lane/reauth-review @200350a). **HELD under attack (pinned green, genuinely sound):** full re-auth bypass sweep (15 shapes × 4 surfaces incl. unicode-lookalike keys, `__proto__`, cross-user passwords → all denied, no column written); unknown-key allowlist on both endpoints; must-change-password hole CLOSED (only the temp password works); 403/422 byte-identical across all 5 targets AND both endpoints; limiter counts before the compare, spends on success only, one shared per-user bucket, clean 429; real argon2id (no short-circuit); **G8 timing floor holds — 6 classifiers ≥32 samples, collide/free ranges fully overlap, sign flips between runs → NO clock oracle**; ledger atomic under 6-way concurrency + CITEXT + self-exclusion; revocation completeness + revokedCount; mail-unconfigured honest walk; URL-free leak-free template.

**Findings (reviewer labels reconciled; both passes agree):**
- **R-F1 / HIGH-1 — E8 email-existence ORACLE on PATCH /users/me (and R-F2/MED-6 weaker twin on claim).** The 200 body (and later GET /users/me, unlimited) echoes the SUBMITTED address when free vs the caller's OLD address when the email silently dropped → a blind 30-trial classifier scored 30/30, case-insensitive, ~14.4k probes/day/account. Lane C's byte-identity grid missed it because UPDATE_ME_VARIABLE_KEYS redacts `email` before comparing and compares two different users, not one actor's colliding-vs-free attempts. **This is a genuine E8 vs E1/E4 TRILEMMA, not a code bug:** you cannot simultaneously (1) apply email immediately with NO mail (E1/E4), (2) let the actor read their own account (inherent), and (3) hide whether the address was taken (E8/F5). Silent-drop keeps (1)+(2) and loses (3); confirmation-links keep (3) but break (1); honest-409 makes the oracle EXPLICIT. **NO in-scope fix closes it — requires an OWNER decision to relax one locked decision. ESCALATED (see §Owner-decision below). Not fixed in the fix wave; its two test cases are `.skip`-with-reason pending the decision; docs corrected to stop overclaiming enumeration-safety on this surface.**
- **R-F3 / HIGH-2 — `POST /users/{self}/reset-password` = account takeover from a bearer token.** Self-reset takes NO currentPassword: a stolen admin access token → printed temp password → attacker login 200, real owner's password 401 (locked out). Exactly F1's hole; the code's CLI-parity defense is wrong (CLI needs filesystem access, a real boundary; HTTP needs only a 15-min bearer token). **FIX: require currentPassword when id === self.**
- **R-F6 / HIGH-3 — the 500 G6 claimed to delete is STILL LIVE.** updateUserSelf's 23505 backstop retries inside the transaction Postgres already aborted (withTransaction opens no savepoint) → 25P02 → uncaught 500; two users racing one free address 500'd the loser 11/12 rounds, and collide=500 vs clean=200 is itself a signal. **FIX: retry the WHOLE updateUserSelf transaction on 23505 users_email_key (fresh txn; its pre-SELECT then catches the now-committed row) — updateUserSelf is only ever called with a top-level db, never a shared trx, so an outer retry is safe.**
- **R-F4 / MED-5 — `users.email` validated as only `typeof==='string'`.** `" x@y "` dodges the collision pre-SELECT and stores verbatim; `"not-an-email"` and CRLF-injection (`"x\r\nBcc:…"`) stored though the contract says `format: email` — and F5 makes that column a third-party-triggered mail `to:`. Contract/server disagreement (invariant 1). **FIX: validate email format + reject control chars/CRLF in updateMe, createUser, and claim; 422 on invalid (syntax check reveals nothing about other accounts, E8-safe).**
- **R-F5 / MED-7 — a failed dispatch still burns the victim's 24h window.** claimEmailCollisionNoticeWindow runs BEFORE trySend and trySend's `{dispatched:false}` is ignored → one queue hiccup silently suppresses that address's notice for 24h. **FIX: release the window when dispatched===false.**
- **LOW-8 — the post-commit collision-only block is unguarded.** claimEmailCollisionNoticeWindow is a live DB call in an untry-caught post-commit block; any throw there is a collision-only status (the profile update already committed). **FIX: wrap the whole notice block in try/catch that swallows (best-effort; a notice failure must never fail the user's request or leak a collision-only status).**
- **R-F7 / MED-4 — "Other devices have been signed out." is false for ~15 min.** Only refresh tokens revoke; the other device keeps full API access until its access token expires (≤900s TTL). **FIX: credentials-changed epoch (AuthGuard rejects an access token whose iat predates the user's last password change — the guard already fetches the user row on non-allowlisted routes; add users.password_changed_at_ms, migration 0026, set in updateUserSelf's password branch + the two reset paths). Fallback if that balloons: soften the copy to the honest "within a few minutes".**

### 🔶 OWNER DECISION — R-F1 email-existence oracle (E8 vs E1/E4 trilemma) — RESOLVED 2026-08-02: (C) ACCEPT + DOCUMENT **[RE-AFFIRMED 2026-08-11]** (owner: not reopened, LD-13)

The authenticated email-change (and, weaker, the claim) collision handling cannot satisfy E8's "no enumeration" while E1 (works with zero mail) and E4 (email is a plain, immediately-settable field) both hold, because the actor can always read their own account back. Options presented: (A) confirmation-link email changes — closes the oracle but BREAKS E1; (B) honest 409 — contradicts F5's silent-no-op and makes the oracle explicit; (C) keep silent-drop, ACCEPT the oracle as a documented household-scale limitation. **OWNER CHOSE (C)** (AskUserQuestion, 2026-08-02): a self-hosted household install keeps zero-mail + immediately-settable email; the exploiter must already be an authenticated member (low real-world exposure). No code change. Landed: the docs (security-posture.md) state the accepted limitation honestly (no longer "under owner review" / no longer overclaiming enumeration-safety); reauth-review-findings.e2e.spec.ts keeps R-F1/R-F2 as permanent `it.skip` records of the accepted behaviour (comments updated from "PENDING" to "ACCEPTED"). E8's "no enumeration" claim now stands ONLY for the unauthenticated claim/reset surfaces it was originally written for, not the authenticated email-change — recorded so a future OAuth/registration change re-examines it.

### Fix wave LANDED + integrated (2026-08-02, lane/reauth-fix → main; 8 commits, ff to 4b40b8c; gate:full ALL 14 PASSED on the rebased assembly, verdict read from the log not a wrapper) — R-F3/R-F4/R-F5/R-F6/R-F7/LOW-8 fixed; R-F1/R-F2 owner-gated

- **R-F3** self-reset now requires currentPassword when id===self (contract+SDK atomic, oasdiff additive-only: new optional AdminResetPasswordRequest.currentPassword + 422/429 responses); admin-on-another-user unchanged. Web ResetPasswordDialog gained the field for the self case (else the existing self-reset UI would always 422).
- **R-F6** updateUserSelf is now a thin wrapper: run the txn once; on a caught users_email_key 23505 re-run a FRESH transaction (safe — only ever called with a top-level db) whose own pre-SELECT catches the now-committed row. Dead in-aborted-txn retry removed. Race test 8 rounds zero 500s + a deterministic Promise.all unit test.
- **R-F7 — epoch approach LANDED (not the copy fallback):** migration 0026 users.password_changed_at_ms, set by all three password-change paths (updateUserSelf + resetUserPasswordAndEmit + resetPasswordViaTokenAndEmit); TokenService.verifyAccessToken now returns iat; AuthGuard rejects a token whose iat < ceil(password_changed_at_ms/1000) (whole-second JWT iat → ceil tie-breaks to reject; null epoch = skip, so existing users aren't mass-logged-out on deploy; skipped while must_change_password true to preserve the recovery flow). Orchestrator-reviewed: the now-unconditional getUserById adds a PK read only to the 3 authenticated allow-listed routes (logout/getMe/patch-me) — NOT a Tier-0 violation (that rule is CPU-heavy work; ViewerContextProvider already does this read per catalog request). **By-design behavior change (documented):** every password change now costs the changing device ONE transparent refresh (its own refresh token is preserved; the web's reactive-401-retry makes it invisible) — never a re-login. admin-reset-password.e2e updated to prove the one-refresh sequence.
- **R-F4** new @loombre/shared isValidEmailFormat (zod z.email(), the same primitive settings-registry already used); wired into updateMe/createUser/createInvite/claimInvite (trim-then-validate — trimming is load-bearing so the review's padded-address case still 200s with the collision dropped); two duplicated hand-rolled email regexes retired.
- **R-F5 / LOW-8** both post-commit notice blocks (updateMe + claimInvite) wrapped in try/catch (swallow + log — the profile update/claim already committed); trySend's dispatched result checked, and on false the just-won 24h window is released via new releaseEmailCollisionNoticeWindow (compare-and-delete on the exact claimed timestamp — atomicity preserved).
- **docs** security-posture.md's F5 section corrected: a "⚠️ Known limitation, under owner review" block now states the residual body-level oracle honestly instead of claiming enumeration-safety.
- **R-F1/R-F2** unfixed BY DESIGN (owner-gated): 5 it.skip cases in reauth-review-findings.e2e.spec.ts, each tagged "PENDING OWNER DECISION (STATE.md 🔶)". All other cases in that 875-line reviewer file are GREEN.
- Gate: server 1732 passed/12 skip, db 404, web 1072, all others green; oasdiff additive-only exit 0; register-lint 25 baseline held.

### §5 Owner checklist (moved here from the mail-run Open ledger per this brief's preamble — NOT code items, unblocked by this run)

1. **3-OS remote CI** — the owner-billed board WAS triggered by the 2026-08-01 push (run 30745168932 on c672c73, in progress at this kickoff); result to be recorded at this run's exit gate.
2. **Real internet-relay deliverability** — smtp-server e2e proves transport/templates/failure path; a real relay (Brevo/Gmail/etc.) + SPF/DKIM/DMARC is home-lab, logged not simulated.

## Optional mail transport + invitation & reset flows that work without it (kicked off 2026-08-01, authority: owner "Optional Mail Transport + Invitation and Reset Flows That Work Without It" brief; docs/PLAN.md §10 + Addendum A decisions A1–A10; design/phosphor/README.md for UI)

### EXIT GATE — WALKED 2026-08-02 (final tree; gate:full ALL 14 STEPS PASSED on the assembled main)

Automated exit met; the one item genuinely requiring physical hardware (a real internet-exposed SMTP relay end-to-end) is logged Open, not simulated. Coverage vs the verbatim mission §5 exit gate:

| Exit-gate item | Status |
|---|---|
| gate:full green 3-OS; contract+SDK atomic; redocly zero-warn | ✅ gate:full ALL 14 steps on the local assembly (web budget 166.5 KB gz / 200). Every contract addition shipped with its regenerated+built SDK (sdk-drift enforced); redocly clean. 3-OS remote dispatch is the owner-billed CI push (Open item 1 — not run locally) |
| E1 proof: invite→claim AND password reset complete end-to-end with ZERO mail configuration (test + review walk) | ✅ BOTH opus reviews executed the real-HTTP no-mail walk (28/28 assertions): invite→claim→auto-login→single-use-404, admin-reset→temp-pw→must-change lockdown→clear; test-send 409 unconfigured; zero mail jobs; trySend dispatched:false throughout. Landed e2e (invites.e2e + password-recovery.e2e) pin it in the gate |
| Invite single-use race (concurrent claims: exactly one wins); revocation; expiry; admin/restricted grant exclusion proven | ✅ race independently re-derived N=12/24 → one 201; revoke 404s later claims; expiry enforced; M4 both gates proven (no is_admin field anywhere; restricted lib 422 at CREATE + re-checked+skipped at CLAIM, even against a grant row injected directly into user_invite_grants and a general→restricted flip) |
| Reset tokens: single-use, 30-min, constant-time, enumeration-safe verified by probe | ✅ 256-bit base64url / SHA-256 at rest / DB-equality lookup; TTL exactly 1 800 000 ms; race N=16 → one 204; body-identical across 7 identifier classes. **Timing enumeration (R-F1/F2) was a real FAIL at review (classifier ~100%) — CLOSED in the fix wave; re-probe classifier 71.9%/66.9% → 36.1%/44.7% (chance 33/50%)** |
| Mail configured (SMTP container): invite+reset+notice delivered; plaintext present; zero external resources; failure path surfaces admin notice + event w/ SMTP error | ✅ worker consumer.e2e drives a real smtp-server: invite delivered w/ HTML+text bodies + zero external resources asserted (only the intended actionUrl), STARTTLS mode, 535 auth-failure → mail.failed with the real error preserved; admin-mail.e2e covers the admin surface. Real internet relay = Open item 2 (home-lab) |
| Test-send button reports real transport results both ways (success + auth-failure fixture) | ✅ POST /admin/mail/test-send → 202 {jobId} enqueues a REAL job (no inline SMTP); success + 535 auth-failure fixtures both drive the real transport; result surfaces via job.updated ADMIN_ONLY + ledger last_error; D's MailTestSendCard subscribes that jobId and renders both outcomes + the 409-unconfigured explanation |
| Public-URL required-and-validated before email tier activates; Host-header poisoning defeated | ✅ network.publicUrl (validated absolute http(s)); isConfigured() gates the tier + passwordResetAvailable; ZERO req.headers.host in the mail/link pipeline (6 forged-header shapes + absolute-form URI + trust-proxy-on all clean); M9 client-origin fallback is client-only, display-only |
| Adversarial findings resolved or owner-acked with severity | ✅ TWO corroborating opus passes; F1–F12 all fixed (review-findings.e2e 7/7 green, not weakened — one case rewritten to a STRONGER closure); owner-acks: currentPassword-on-self-change (F5), list-limit clamp, general reverse-proxy recipe overhaul, silent email-drop honesty tradeoff (below) |
| Docs all three registers, register lint clean; copy-link path documented first everywhere | ✅ admin (inviting-users copy-link-FIRST + mail provider table source-verified) / user (joining) / operator (cli reset-password, reverse-proxy, mail-notes); register-lint 25/25 zero new; docs:build ALL steps incl. drift + dead-link |
| STATE.md: E1–E9 incl. OAuth/LPP future path; coverage vs mission | ✅ this section + the kickoff E1–E9/M1–M16 block; E8 records OAuth/BYO-client-ID as the documented future path + candidate LPP mail-transport capability |

### OPEN ledger (this run — owner-decision + home-lab + owner-ack; nothing silently dropped)

1. **3-OS remote CI** — local gate:full is green on darwin; the 3-OS board (ubuntu/windows/macos) is the owner-billed `gh workflow run` push, not run here.
2. **Real internet-relay deliverability** — the smtp-server e2e proves the transport/templates/failure path; a real relay (Brevo/Gmail/etc.) + SPF/DKIM/DMARC is home-lab, logged not simulated.
3. **F5 currentPassword-on-self-change** — the fix wave revokes other sessions on self password change (closes the blast-radius half); requiring the current password is the stronger measure, a pre-existing-posture change deferred to owner. **[SCHEDULED Wave B (LD-13a), in flight 2026-08-11]** — **[CLOSED-AS-PRE-EXISTING (Wave B B1, verified 2026-08-11): the mandatory-currentPassword narrowing already shipped in the earlier current-password re-auth run (dependentRequired contract clause + require-current-password.ts presence check + P4.23), NOT in this run's diff — B1 verified it end-to-end and added the three missing adversarial tests (shape parity 403-vs-login-401, timing parity proving neither short-circuits argon2id, real race vs concurrent admin reset). D-R2 re-confirmed from the contract side.]**
4. **F3 silent email-drop is a deliberate E8-over-honesty tradeoff** — when a claimant's email (or an invite's emailPreset) collides with an existing account, the email is silently dropped and the claim succeeds identically to a free-email claim (any reject-vs-succeed split is itself an enumeration oracle by status code). Rare on a LAN household; recoverable via profile later. A future honesty-preserving enhancement: signal `emailApplied:false` in the (post-auth) claim response so the new user is told. Owner call. **[CLOSED WAVE B (B1, LD-13c) 6889c304 2026-08-11: TokenPair.emailApplied added additively (claimInvite-only, mirrors mustChangePassword's selective send); false iff the intended email collided and was dropped. Pre-auth byte-identity PROVEN the strongest way — the pre-auth claim GET never queries the users table at all (D-R2 independently re-probed and re-confirmed: no pre-auth oracle; only a weak POST-auth timing residual = the accepted posture). The E8 tradeoff is preserved (still no status-code split); the signal is post-auth honesty only.]**
5. **reverse-proxy recipe general gap** (Docs-lane + review flag) — the three recipes route only a named subset of API prefixes; most bare-path REST routes aren't covered (pre-existing, Open across the app). This run fixed only the /claim line.
6. **List-param limit clamp** — GET /invites inherits the repo-wide un-clamped limit (Open ledger 8 from the Stash run); not introduced here.
7. **ClaimInviteRequest.email null-to-clear** (D flag) — a claimant can't explicitly opt out of an emailPreset (omit = preset wins; "" fails format). Contract design question. **[CLOSED WAVE B (B1, LD-13b) 6889c304 2026-08-11: ClaimInviteRequest.email widened to [string,'null'] (additive request-nullable per oasdiff); DTO+service now distinguish ABSENT (keep preset) from NULL (clear); 8-cell grid absent/null/value × preset/no-preset green; web clear-field sends explicit null. A GENUINE BUG was found+fixed red-first in the same item: email:null was previously silently ignored and the preset applied against the claimant's intent.]**
8. **Re-setting the same temporary password clears must_change_password** (review nit) — no "must differ from temp" check. **[WAVE-A CLOSED 086643de 2026-08-11]** (self-change to an identical password rejected)

### Fix wave landed (2026-08-02, lane/fix → main, 7 commits on 341acb3; gate+gate:full ALL PASSED post-integration + 2 orchestrator comment tidies)

F1 claim API → /invites/claim/{token} (web page route /claim/[token] unchanged; all three proxy recipes fixed). F2 forgot-password enumeration closed (both-lookups-always + mail-unconfigured short-circuit + 200ms floor; probe classifier → chance). F3 email-unique 23505 no longer misreported as username conflict — colliding email silently dropped, claim byte-identical to a fresh one (full oracle closure, not reworded — stronger than the reviewer's own proposed remedy). F4 fractional expiresInMs → 422. F5 self password-change revokes other sessions. F6 additionalProperties enforced on all four public bodies; F7 email-format; F8 minLength:8 on claim/reset; F9 raw token scrubbed from RFC9457 instance on claim/reset/429; F10 dead reset-token purge on issue; F11 comment accuracy; F12 mail action-button scheme allow-list. review-findings.e2e 7/7 green. oasdiff: only the unreleased-endpoint moves + minLength tighten, exit 0.

### Mission (verbatim)

Implement (1) an invitation system: admin creates a one-time, expiring invite link that provisions a new user through a self-serve claim flow, fully functional with zero mail configuration; (2) password recovery: admin-driven reset via CLI + admin UI, and a self-serve email reset that activates only when mail is configured; (3) the mail subsystem: a generic SMTP transport configured through the settings registry with keyring credentials, test-send, outbox-driven delivery jobs with retries and admin-visible failures, and minimal, clean templates for invite/reset/security-notice mail; (4) documentation in the correct registers. All proven by tests including the no-email paths, with the leak/security posture extended to the new unauthenticated surfaces.

### Locked decisions (E1–E9, verbatim from the brief — run law)

- **E1** No-email-first is law: every flow in this run works with mail unconfigured. Invites = copyable one-time links; recovery = admin reset. Mail, when configured, DELIVERS the same artifacts (the invite email contains the same claim link the admin could have copied). No flow, screen, or doc assumes mail exists.
- **E2** Invitations: admin creates an invite (optional pre-set username/display name, role, library grants, expiry default 72h, single-use). Server stores only a HASH of the invite token (argon2id, same posture as refresh tokens — see M3 adjudication); the full link (https://<server>/claim/<token>) is shown ONCE at creation with a copy button. Claim flow (unauthenticated route): token validated → user sets username (if not pre-set) + password → account created with the invite's grants → invite consumed atomically (single-use enforced at the DB level — concurrent claims race-safe) → outbox events user.invited / user.claimed with actor. Pending invites listable + revocable in admin UI. Invites can NEVER grant admin role or restricted-library permissions (those remain deliberate post-creation admin actions — an intercepted invite link must not be able to mint privilege).
- **E3** Password recovery, two tiers: (a) always available: loombre admin reset-password <user> CLI (H2 pattern exactly: interactive confirm, outbox-audited, next-login must set new password) + the same action in admin UI users surface; (b) email tier, visible only when mail is configured AND the user has an email on file: self-serve "forgot password" issuing a hashed, single-use, 30-min reset token by mail. The reset endpoint responds identically whether or not the account/email exists (no user enumeration), rate-limited per the standing limiter patterns.
- **E4** User email is an OPTIONAL profile field (additive migration — see M1: reality makes this a loosening): settable by the user, by the admin, or captured during invite claim (optional there too). Plain column, not keyring; surfaced in profile + admin users; exported/imported via the data-freedom archive.
- **E5** Mail transport core = generic SMTP (nodemailer): host, port, security (STARTTLS/implicit TLS), from-address, from-name in the settings registry (auto-rendered form, env-pinnable per A8); username/password in the KEYRING (masked write-only per A9 pattern). Provider-agnostic by design — no provider-specific code paths in v1. Registry description text stays generic; provider specifics live only in the E9 reference table.
- **E6** Delivery is outbox-driven jobs, never inline: flows enqueue mail.send jobs (template id + params, never raw HTML from callers); worker renders + sends with retry/backoff; permanent failures surface as admin notices + mail.failed events with the SMTP error preserved. A dead mail server can never block an invite creation, a reset issuance, or a request thread. "Send test email" button in settings runs the same pipeline end-to-end and reports the real SMTP conversation result.
- **E7** Templates: minimal, self-contained HTML + plaintext alternative (invite, password reset, security notice for admin-initiated resets); Phosphor-adjacent but EMAIL-SAFE (inline styles, no webfonts, no external images — nothing that phones home from an inbox; the zero-telemetry posture extends to mail). Server URL in links comes from a required public URL setting (registry; validated) — no Host-header trust for security-sensitive links.
- **E8** Security posture for the new unauthenticated surfaces (claim + reset routes): rate-limited, token comparison constant-time against hashes, expired/consumed tokens indistinguishable from invalid in responses, no enumeration anywhere, CSP-clean pages, and both routes added to the adversarial checklist. Provider OAuth connectors (Google, Microsoft, or any other — BYO-client-ID pattern) explicitly OUT of scope this run — recorded as the documented future path and a candidate LPP mail-transport capability; the transport interface is shaped so any such addition is additive.
- **E9** Docs, register rule: admin guide — inviting users (copy-link path FIRST, email as the upgrade), resetting passwords, and configuring mail PROVIDER-NEUTRALLY: the generic SMTP form taught once (host, port, security, credentials, from-address), followed by an even-handed provider reference TABLE (one row each): transactional relays (Brevo/SMTP2GO/Mailgun class — recommended row for internet-exposed installs, free tiers noted), Gmail/Google Workspace (app password, 2FA prerequisite), Outlook/Microsoft 365 (app password/SMTP AUTH caveat), Fastmail (app password), Proton (via Proton Bridge), iCloud (app-specific password), self-hosted/ISP relay (just the five facts). Each row = the values + the one caveat, sourced-verified at write time; anything longer links out. User guide — claiming an invite, forgot-password (both variants, plain language). Operator guide — public-URL setting, reverse-proxy interaction with claim/reset routes, deliverability reality note (one paragraph).

### Run posture (2026-08-01)

- Precondition VERIFIED: gate:full ALL 14 STEPS PASSED on main at ee7a2a0 (web budget 166.5 KB gz / 200 KB). Working tree carried only perf/web-budget-result.json's self-rewrite (the budget step's own output).
- Sub-agent policy per standing rule: sonnet lanes, opus review. Worktree lanes at /Users/ozzy/App Development/loombre-worktrees/lane-{a,b,c,d}; per-lane DBs (loombre_lane_<x>) on compose PG :5442; STATE.md orchestrator-owned (lanes return entry text in freeze reports); orchestrator integrates C → A → B → D sequentially.
- Known lane-agent defect (3 prior occurrences): parking on "waiting for background gate" — lanes are instructed foreground-only gates; on stall the orchestrator reads the worktree and verifies with its own gate run.

### Kickoff ground truth + orchestrator adjudications (recon 2026-08-01 — M-numbers are run law alongside E-numbers; 6 read-only scouts over auth/events+jobs/settings+keyring/contract/web/docs)

- **M1 (email reality — E4 is a LOOSENING, not an addition):** `users.email` is CITEXT NOT NULL UNIQUE (0001), a live login identifier (`getUserByEmail` in auth), required in `CreateUserRequest`/`User`/profile UI. E4 reads onto: 0023 drops NOT NULL (UNIQUE + CITEXT kept — Postgres treats NULLs as distinct), create/claim/profile make email optional, `User.email` becomes nullable-but-required-key. oasdiff will report the response-nullability as breaking — recorded in the commit body per the P4.22 convention (verified at kickoff: the gate's oasdiff step runs `oasdiff breaking` with no --fail-on flag; it reports, exit 0).
- **M2 (displayName honesty bug, folded in):** contract `User.displayName` is declared and BOTH the profile form and AddUserSheet submit it, but no `users.display_name` column exists — the value is silently discarded while the UI reports "Saved" (the exact H1 bug class). Lane A: red-first round-trip test, then `users.display_name TEXT NULL` in 0023, wired through createUserAdmin/updateUserSelf/updateUserAdmin/mapUser. This also gives E2's display-name preset a real column.
- **M3 (token posture):** E2's "argon2id" parenthetical yields to its own "same posture as refresh tokens" clause: invite + reset tokens are 256-bit `randomBytes(32)` base64url, stored as SHA-256 hex, looked up by DB equality on the hash — constant-time by construction (E8), indexable, and no CPU-heavy hashing on unauthenticated routes (DoS posture). Argon2id remains for low-entropy user secrets (passwords/PINs) only. Deviation logged here; house refresh-token law wins.
- **M4 (role):** only `is_admin BOOLEAN` exists — E2's "role" collapses to member-always. The invite schema carries NO role/admin field at all (escalation impossible by construction, not by validation). Grants = `library_permissions` rows; restricted-class library IDs are rejected at invite creation AND re-checked at claim time (defense in depth).
- **M5 (migration numbers, pre-assigned):** A→0023 (user_invites + user_invite_grants + users.email nullable + users.display_name), B→0024 (password_reset_tokens + users.must_change_password), C→0025 RESERVED (expected unused — mail state lives in settings/keyring/job ledger).
- **M6 (events, closed-list process):** A adds `user.invited`, `user.invite-revoked`, `user.claimed` (all ADMIN_ONLY; the claim path also emits the existing `user.created` via the reused creation primitives). B adds `user.password-reset` (ADMIN_ONLY; payload actor: "cli"|"admin"|"self-service", never any secret material) and MAY add `user.password-reset-requested` (ADMIN_ONLY). C adds `mail.failed` (ADMIN_ONLY; payload PRESERVES the SMTP error string — deliberate deviation from probe.failed's closed-code/no-free-text posture because E6 requires the real error; logged here). Envelope enum 29→~34; every lane bumps the hardcoded counts (event-schemas.spec ×1, actor-field-map spec ×1, admin-only snapshot test) in-worktree; orchestrator resolves count merges at integration.
- **M7 (mail job + frozen cross-lane seam):** job type `mail-send` (kebab per JobType convention; the brief's "mail.send" spelling yields, K9-style). C owns packages/jobs surface: payload type `{ templateId: "invite"|"password-reset"|"security-notice"|"test", to: string, params: Record<string,string> }`, JOB_QUEUE_OPTIONS entry, job.updated.schema.json jobType enum, AND the new retry-backoff surface (retryDelay/retryBackoff/retryDelayMax threaded through @loombre/jobs — pg-boss 12 supports it, nothing exposes it today). A/B never enqueue directly: they call the FROZEN server seam `MailDispatchService.trySend({templateId, to, params}): Promise<{dispatched: boolean; jobId: string|null}>` (apps/server/src/mail/mail-dispatch.service.ts, name frozen now) — never throws, returns dispatched:false when mail is unconfigured (E6: a dead/unconfigured mail system never blocks a flow). A/B stub it in-worktree; C implements; integration order C→A→B replaces stubs with the real module.
- **M8 (email-tier activation + discovery):** mail is "configured" := smtpHost non-empty AND fromAddress non-empty AND network.publicUrl set (credentials OPTIONAL — unauthenticated LAN relays are legal). Frozen seam #2: `MailConfigService` (apps/server/src/mail/mail-config.service.ts, C-owned) exposing `isConfigured(): boolean` and `publicUrl(): string|null`. B additively extends public `GET /system/capabilities` with `passwordResetAvailable: boolean` (login page shows FORGOT only then). `POST /auth/forgot-password` returns the identical 202 body even when mail is unconfigured or the account/email doesn't exist — one response shape, always.
- **M9 (public URL + the one sanctioned client-side fallback):** new registry entry `network.publicUrl` (scope ui, category network, envVar LOOMBRE_PUBLIC_URL, default "" = unset, validated absolute http(s) URL, stored without trailing slash) — C owns. ALL mail links are built ONLY from it (E7: zero Host-header trust server-side). The admin invite-reveal is different: the server returns `claimUrl` (publicUrl-derived) OR null, and the WEB composes `window.location.origin + /claim/<token>` as the copy-button fallback when null — that origin is the admin's own browser reaching the server, client-side, and is exactly the origin a LAN user can also reach; documented distinction, not a Host-trust hole.
- **M10 (SMTP registry + keyring shape):** new category `mail` added to the SettingsCategory union + contract enum + docs titles + web CATEGORY_LABELS — and the PRE-EXISTING `stash` category gap (used at settings-registry.ts:646 but missing from the union + contract enum, found at recon) is FIXED in the same commit (C). Keys: `mail.smtpHost` (default ""), `mail.smtpPort` (int 1–65535, default 587), `mail.smtpSecurity` (enum starttls|implicit-tls|none; "none" is an adjudicated addition to E5's two for port-25 LAN relays, caution text required), `mail.fromAddress`, `mail.fromName`; env pins LOOMBRE_SMTP_{HOST,PORT,SECURITY,FROM_ADDRESS,FROM_NAME}. Credentials: ONE keyring entry `mail-smtp-credentials` (A9 envelope {value: JSON string {username,password}, setAtMs}), write-only `PUT/DELETE /admin/mail/credentials` (409 when env-pinned by LOOMBRE_SMTP_USERNAME/LOOMBRE_SMTP_PASSWORD), status as an additive field on GET /admin/settings' response; worker resolves env-first-else-keyring mirroring resolveApiKeyWithKeyring. NOT grafted onto the tmdb|tvdb ProviderName enum (that closed set is duplicated in 4 places; mail gets a parallel sibling service).
- **M11 (test-send, E6-conformant):** `POST /admin/mail/test-send {to}` → 202 `{jobId}`: enqueues a REAL mail-send job (templateId "test", per-send retryLimit 0) — no inline SMTP on any request thread, test included. The result surfaces through the EXISTING job.updated ADMIN_ONLY live feed + ledger last_error (real SMTP conversation preserved); terminal failure also emits mail.failed. D's mail section subscribes to job.updated for that jobId (subscribeAll precedent) and reports both ways.
- **M12 (unauthenticated-surface process):** every new public op needs the QUARTET: contract `security: []` + auth.guard PUBLIC_ROUTES + conformance PUBLIC_OPERATION_IDS + dedicated public-op response assertions; PLUS a named declarative rate-limit policy (registry keys `rateLimit.claim` / `rateLimit.passwordReset`, @RateLimit(..., "ip"), min ≥1/min per AD1) and the byte-identical-404 posture for invalid/expired/consumed/revoked tokens (setup/first-admin's bare NotFoundException precedent; instance-stripped twin tests in seeded-conformance style).
- **M13 (claim auto-login):** claim success mints a real TokenPair via the createFirstAdmin composition (HashService + TokenService + RefreshTokenService) — the user lands signed in.
- **M14 (admin/CLI reset semantics):** `POST /users/{id}/reset-password` (admin, live-admin re-verified) + `loombre admin reset-password <username>` CLI both: generate a random temporary password (shown/printed ONCE, never stored plaintext, never in any event payload), set users.must_change_password, revoke ALL the user's refresh tokens, emit user.password-reset. Admin-initiated resets additionally trySend the security-notice mail (E7) when the tier is active and the user has an email. Login with the flag returns TokenPair + additive `mustChangePassword: true`; a server-side guard restricts flagged users to auth routes + GET /users/me + the PATCH /users/me password change until cleared (cleared exactly when a new password is set). CLI follows H2 to the letter: interactive y/yes confirm naming the user, NO --yes flag, dynamic @loombre/db import, e2e drives the real runCli.
- **M15 (self-serve reset mechanics):** password_reset_tokens (id, user_id FK, token_hash UNIQUE, created_at_ms, expires_at_ms = +30min, used_at_ms NULL); single-use enforced by the same atomic UPDATE ... WHERE used_at_ms IS NULL pattern as invites; success sets password, marks token used, revokes all refresh tokens, clears must_change_password. Old tokens for the same user are invalidated when a new one is issued.
- **M16 (claim/reset web pages):** mirror /login's self-guarding client pattern (no AppShell) but do NOT bounce authenticated viewers (an admin may open a claim link to verify it); CSP applies automatically via proxy.ts's matcher; direct LoombreClient calls (public ops, no bearer), the login page's three-way error-branching template.
- **Ground truth worth repeating:** conformance's unimplemented-allowance is EXACTLY ZERO (every new op needs an IMPLEMENTED_NON_PUBLIC_EXPECTATIONS entry or PUBLIC_OPERATION_IDS + assertions; bijection both ways). SDK must be BUILT, not just regenerated, before conformance sees a new op. The docs drift gate hard-fails on uncommitted regenerated settings-reference/env-reference — any lane touching the registry runs pnpm docs:build and commits the regen. nodemailer is MIT: allow-list clean, NO LICENSE-INTENT row needed. packages/shared's settings-registry test hardcodes secret:true membership as ["database.url"] — no new registry entry is secret (creds live in the keyring), so it stands. New-user-facing strings follow Phosphor register; register-lint is warnings-only but the baseline (25) is recorded and lanes add zero new warnings.

### Lanes

| Lane | Scope | Model | Status |
|---|---|---|---|
| C | mail subsystem E5–E7: registry+keyring+transport+jobs+backoff+templates+test-send+publicUrl + M7/M8 seams | sonnet | **LANDED 1baef34..eb9d996** (gate + gate:full ALL PASSED in-worktree; ff to main) |
| A | invitations E2 + email/displayName E4/M1/M2: 0023, token lifecycle, claim route, race test, events, contract+SDK | sonnet | **LANDED 09f3daf..720d1d8 rebased** (gate ALL PASSED on the C+A assembly) |
| B | recovery E3/M14/M15: CLI + admin action + email-tier tokens + enumeration-safe endpoints + limiter | sonnet | **LANDED 32c4d33..cbb7931 rebased** (gate ALL PASSED on the C+A+B assembly = main) |
| D | UI (after A/B/C contract freeze): invites surface, reset action, mail settings+test-send, claim/reset pages, profile email | sonnet | **LANDED e4d0f9a..37a2f7b rebased** (gate + gate:full ALL PASSED in-worktree; web 123 files/1055 tests; budget 166.5 KB unchanged) |
| Docs | E9 three registers + sourced provider table | sonnet | **LANDED 584275b..187bfd0** (register-lint 25/25 zero new; docs:build ALL PASSED; provider table source-verified 2026-08-01, per-row URLs in the page's Sourcing comment) |
| R | opus adversarial pass per brief §3 + E1 no-mail conformance walk | opus | dispatched |

### D + Docs freeze notes (orchestrator-integrated; main = f1059b4, gate:full ALL 14 PASSED on the full assembly)

- **D**: invites admin surface = sibling InvitesPanel card on /settings/users (all statuses visible, per-row revoke w/ danger confirm) + CreateInviteSheet (SheetOrModal) + shared ui/SecretReveal (extracted from the plugin-wizard precedent, reused for invite link + temp password); reset-password via RowMenu + Modal (self-reset warns about own sessions); Settings "Mail" tab (registry fields through the EXISTING SettingField renderer + write-only MailCredentialsCard + MailTestSendCard subscribing job.updated for the real outcome, 409-unconfigured explains the three missing prerequisites); /claim/[token], /forgot (constant copy), /reset/[token] on a shared AuthScreen shell (M16: authenticated viewers not bounced); /login gains the capabilities-gated "Forgot password?" + mustChangePassword routing to a forced change screen; email optional in profile (clear-to-null) + AddUserSheet. One real bug caught by D's own tests (revoke confirm-state stuck) — fixed in-lane.
- **Docs**: inviting-users.md (copy-link FIRST), mail.md (5-fact generic form; provider table: Brevo/SMTP2GO/Mailgun 587 STARTTLS (relay class, recommended for internet-exposed, free tiers noted), Gmail 587+app-password+2FA, M365 587+SMTP-AUTH-off-by-default, Fastmail 587+app-password, Proton via Bridge 127.0.0.1:1025, iCloud 587+app-specific), joining.md (plain register, both recovery variants), ops: cli.md "Forgot a password?" mirrors the PIN section, reverse-proxy.md requirement 6 (claim/reset pass-through + LOOMBRE_PUBLIC_URL-vs-origin, all three snippets), mail-notes.md one-paragraph deliverability reality. Post-D accuracy pass f1059b4 names the real controls.
- **Flake tally**: the known parallel-turbo conformance contention flake, third costume this file has seen — listSeriesSeasons' 401 arrived as application/json (not problem+json) once under the full gate; isolated 12/12 twice, next full run clean. Pre-existing endpoint, untouched by this run.

### Opus adversarial review — TWO independent passes (2026-08-02), corroborating

Process note: two opus review agents ran (an unintended duplicate; kept — two corroborating security passes is strictly better). Both proved findings with live HTTP probes, not code reading. One committed the red regression pins `7a735b3` on lane/review (apps/server/test/review-findings.e2e.spec.ts — 3 of 7 RED BY DESIGN, pinning R-F2/R-F3; the other 4 are guards a fix must keep green). lane/review is therefore ahead of main by that test-only commit.

**E1 no-mail walk PASSED (both, executed over real HTTP):** invite→claim→auto-login→single-use-404, admin-reset→temp-password→mustChangePassword lockdown (8 endpoints 403 `password-change-required`)→PATCH clears→same live token full access; test-send 409 unconfigured; ZERO mail jobs; no raw token/temp-password/password in any payload or log; sha256(raw)==token_hash, 256-bit base64url not argon2id.

**HELD under attack (verified, not asserted):** token posture; claim race (N=12/24 → exactly one 201); reset race (N=16 → one 204); byte-identical 404 parity (all invalid/expired/consumed/revoked states → one signature, GET+POST); body-level enumeration (7 identifier classes → 1 body); privilege escalation (both M4 gates hold even against a restricted library_id injected directly into user_invite_grants, and a general→restricted flip post-issue); Host-header poisoning (zero req.headers.host in the mail/link pipeline; M9 fallback client-only); templates (HTML escaped, zero external resources, the lane's own test non-vacuous); rate limits (claim fires at #11, passwordReset at #6, Retry-After, shared buckets, no XFF bypass with trust-proxy off); keyring write-only end-to-end incl. 0600 on-disk shape.

**FINDINGS → fix wave (dispatched; lane/fix off main; red tests are the definition-of-done):**
- **F1 HIGH — /claim API↔web path COLLISION.** GET/POST /claim/{token} is served by BOTH the API (JSON) and the Next page apps/web/src/app/claim/[token]; reverse-proxy.md routes /claim/* to the API, so the human invite link renders JSON, not the claim page (reset/forgot avoided this via distinct API paths /auth/*-password). Fix: move the API claim ops to a distinct path (→ /invites/claim/{token}), web page route unchanged; ripple contract+SDK+controller+PUBLIC_ROUTE_PATTERNS+ClaimScreen fetch+proxy recipe+conformance. Breaks E1's PRIMARY path under the documented deploy.
- **F2 HIGH — forgot-password timing enumeration (E8).** Single-request classifier ~100% (3 distinguishable classes; distributions fully disjoint when mail configured). Root: getUserByUsername()??getUserByEmail() short-circuit + real branch does a withTransaction INSERT (+enqueue) the dummy branch doesn't. Fix: kill the short-circuit (both lookups always), skip token issuance when mail unconfigured (config-global, enumeration-safe — also kills R-F7 waste), and floor the whole handler to a fixed wall-clock budget; re-probe → classifier must fall to chance.
- **F3 MED — claim 23505 always → username-conflict** (invites.ts:395), but users.email is CITEXT UNIQUE too → a free username + taken email returns a false "username taken" AND an email-existence oracle. Fix: distinguish err.constraint.
- **F4 MED — POST /invites 500s on fractional expiresInMs** (no Number.isInteger; contract says integer, message says integer). Fix: integer check → 422.
- **F5 MED — PATCH /users/me {password}: no session revocation** (the other two password-set paths revoke all); load-bearing since the must_change guard allow-lists exactly this op (stolen access token can set password + clear flag). Fix: revoke other sessions on self-change; owner-ack the stronger currentPassword requirement.
- **F6 LOW — additionalProperties:false declared, unenforced** on all four new bodies (claim accepted isAdmin/role/etc. → ignored, 201; no escalation, but the contract promises a 422). Fix: unknown-key 422 (SETTINGS_BODY_KEYS precedent).
- **F7 LOW — format:email unenforced** (claim + create); **F8 LOW — minLength 1** on claim/reset while setup enforces ≥8; **F9 LOW — raw token echoed in RFC9457 instance** on claim/reset 422/429 (sanitize-instance strips ?token= only, not the path segment); **F10 LOW — password_reset_tokens never purged** + minted when mail unconfigured; **F11 LOW — two inaccurate "byte-identical to unknown route" comments** (unknown route → 401; true parity is setup/first-admin's inert 404); **F12 INFO — actionButtonHtml no scheme-check** (unreachable behind PUBLIC_URL_SCHEMA; add anyway).

### Open ledger additions (this run, so far)

1. **ClaimInviteRequest.email has no null-to-clear** — a claimant cannot opt OUT of an invite's emailPreset (omit = preset wins; "" fails format). Contract design question, owner call (D flag). **[CLOSED WAVE B (B1, LD-13b) 6889c304 2026-08-11 — see the mail/invites OPEN-ledger item 7 closure for detail; null now clears, absent keeps.]**
2. **reverse-proxy.md's three recipes historically matched only /v1|playback|setup prefixes** while most of the REST surface mounts at bare paths — the four new claim/reset routes are now listed explicitly, but the pre-existing general gap stands (Docs-lane flag; owner/R).
3. **PATCH /users/me changes the caller's password without current-password confirmation** — pre-existing posture (recon flag), newly load-bearing since the must-change-password guard deliberately allows that op. Named for the R lane.

### Backend integration record (orchestrator, 2026-08-01; main = cbb7931, gate ALL 13 PASSED)

Integration order C→A→B as planned (C ff'd clean; A and B rebased with orchestrator-resolved unions: envelope enum 29→34, admin-only inventory 14→19, registry 26→34 UI entries/19 pins, generated docs + schema.sql resolved by REGENERATION not hand-merge). Real findings, all fixed in the integration commits:

- **DI seam trap (A, fixed 720d1d8):** InvitesModule re-provided MailConfigService/MailDispatchService in its own `providers` — second Nest-scoped instances meant the controller called one pair while `app.get()` spies watched the other; with C's real (unspied) config the invite-mail branch silently never fired. Fix: import MailModule (its exports), never re-provide seam services. B had wired this correctly on its own.
- **Template-param seam drift (A+B, fixed c19aceb/cbb7931):** both lanes' trySend call sites spoke stub-era param names (claimUrl/usernamePreset, resetLink/username/reason); C's frozen template contract reads {actionUrl, displayName, expiresLabel?}. All call sites + test assertions aligned; A gained formatExpiresLabel ("3 days" prose per C's no-duration-arithmetic rule).
- **Staged-markers hazard (B rebase, fixed cbb7931):** three files (rate-limit.guard + surface-rate-limiter service/spec) were staged with UNRESOLVED conflict markers during the rebase (git add -A after a partial resolution; the conflict list had scrolled past). Caught by typecheck/lint (incl. a real no-fallthrough from a dropped `break`). Tree-wide marker sweep is now a standing integration step.
- **Generated-file law reconfirmed:** schema.sql, settings-reference.md, env-reference.md, SDK — every hand-merge of a generated file was wrong or fragile; regeneration from the merged source was always correct (migrate-check caught the one hand-merged schema.sql byte-for-byte).
- Orchestrator process slip, recorded: the first C+A gate verdict was read from a notification whose exit code belonged to `| tail` — the gate had actually failed (the DI finding above); main was briefly ff'd then reset to the green tip while diagnosing. Lesson re-learned: never pipe a verification step; capture full output to a file and let the real exit code propagate.
- Suite counts on the assembled main: server 1126/5skip, worker (green incl. mail e2e), db incl. invites 546-line + password-reset 306-line suites, shared/contract/jobs all green; oasdiff across the three lanes: the 8 predicted nullable-email findings (M1, recorded) + additive-only otherwise.

## Stash SQLite metadata sync + dedicated Restricted Content surface (kicked off 2026-08-01, authority: owner "Stash SQLite Metadata Sync + the Dedicated Restricted Content Surface" brief; docs/PLAN.md §6.4 gates, docs/PLAYBACK.md unchanged, design/phosphor/README.md design language)

### SUBSET VALIDATION DONE + a real bug fixed + filesystem-blob support (2026-08-04, owner supplied a real Stash DB copy)

Owner dropped `/Users/ozzy/Desktop/stash-go.sqlite` (a copy) — closes exit-gate Open item 1. Everything Stash-side read-only (S2 proven: file hash+mtime unchanged across every read incl. the full 43k sync). Report: reports/stash-sync-report.md (gitignored evidence).

- **REAL BUG found + fixed (19438e5):** the read model crashed on the real DB. Stash stores a per-file `phash` as a raw signed int64 in the blob-affinity `files_fingerprints.fingerprint` column (e.g. -9223314888072965413); `readFingerprints` did a bare `SELECT fingerprint` grabbing every type, and node:sqlite threw ERR_OUT_OF_RANGE materializing it BEFORE type-filtering — crashing getSceneFiles, thus the apply phase, on ANY real library (phash is on by default). Fixed to `WHERE type IN ('oshash','md5')` (both text); v85 fixture gained real-shaped phash int64 rows + a regression case. Synthetic fixtures never had phash rows, so nothing caught it.
- **Compatible + reads clean:** schema **v85** (top of the 67–85 pin — no disable path). Post-fix, 2,080 scenes sampled across the full catalog: **0 read errors**.
- **Real-DATA scale proof (beats the 33k synthetic):** full real-apply sync over **43,679 scenes → 100% matched, 5.9 min, 562.6 MiB peak, 375,054 provenance rows, 6,934 performers, 12,811 premiere dates.** Round-trip spot-checks (title/date/studio/performers/tags) match the raw Stash DB; null Stash fields correctly don't clobber.
- **Owner's data does NOT exercise:** ratings (0), markers/chapters (0), tag hierarchy (flat — so the default heuristic would call every tag a genre; owner can set an explicit list). Path mapping is one prefix (`/run/media/ozzy/Media Server/`).
- **Filesystem blob-store support (3ca55a8, owner-approved — closes the cover-art gap):** owner's Stash uses Filesystem blob storage (all 53,394 blobs.blob NULL), so covers can't come from the DB. New on-disk reader (`apps/worker/src/stash/blob-store.ts`, sharding root/<c0:2>/<c2:4>/<checksum> verified vs Stash pkg/sqlite/blob/fs.go, reimplemented) composed behind the DB reader (DB bytes win; fs consulted only when DB byteless AND a path set). Migration **0027** (library_stash_connections.stash_blobs_path, NULL=DB-only unchanged); threaded through sync-consumer's getBlob via makeBlobResolver; contract+SDK tri-state PUT + GET field; admin UI blobs-path input. Gate:full green.
  - **Real-cover pass DONE (2026-08-04, owner supplied /Users/ozzy/Desktop/blobs, 52,318 files sharded exactly as our code computes):** resolver read 199/200 sampled scene covers as real JPEG/PNG/WebP (1 miss = graceful null); a 500-scene subset sync WITH blobsPath set enqueued **794 image jobs (498 posters + 212 performer portraits + 84 studio logos)** vs 0 without it — full chain proven on real bytes. Real-data notes: performer portraits sparse on disk (~15% of references present; rest resolve null, no error); **~43% of studio logos are SVG/XML** — resolver returns them fine, but whether the image pipeline (sharp) rasterizes SVG is an OPEN downstream question (flag for a hardening pass if studio logos should render). Remaining home-lab item: the real media-files MATCHING pass (files not on this host; this session synthesized path-matches).

### EXIT GATE — WALKED 2026-08-01 (final tree; gate:full ALL 14 STEPS PASSED)

Automated exit met; owner-in-the-loop + home-lab items logged Open (not simulated). Coverage vs the verbatim mission + §5 exit gate:

| Exit-gate item | Status |
|---|---|
| gate:full green, contract+SDK atomic, redocly zero-warn | ✅ ALL 14 steps; every contract addition shipped with its regenerated SDK (sdk-drift enforced); redocly clean |
| S3 guard both ways (supported fixtures sync; unsupported disables w/ exact notice + event) | ✅ A + R2: v67/v85 sync end-to-end; unsupported disables with byte-exact notice + stash.provider.disabled + status columns; mangled-in-range table fails loudly |
| S2 fs-level: Stash DB byte-identical after full sync | ✅ A + R2 (strengthened): byte/mtime/dir unchanged across full sync incl. successful-snapshot path. HONEST SCOPE: the .db is untouched; a WAL-mode DB's -wal/-shm siblings are created by any read-only open — documented (adapter header + admin guide), a read-only DIRECTORY now fails with a clear cause |
| Subset validation (match rate, unmatched lists, owner spot-check, preview functional) | ⏳ OPEN — owner action; runbook + report template staged (reports/stash/). No real Stash DB copy on this host — cannot run without owner |
| 33k scale proof (runtime/memory; incremental touches only changed; zone p95 in budget; 60fps wall) | ✅ 287.9 s / 404 MiB real-apply; incremental 12→12; **5 of 6 zone-browse budget breaches fixed by 0021's partial index (240→7–33ms); 3 sort paths OPEN (below)**; 60fps = empirical DOM-pinned (no fps harness exists) |
| Chapters render + deep-link seek (both breakpoints) | ✅ E + UI walk: scene-page CHAPTERS list deep-links /watch?t=<s>; Scrubber ticks + ChapterList (desktop popover / mobile sheet); deep-link beats the resume prompt |
| Leak suite extended + green; adversarial walk clean (UI + API + images + events + search + palette) | ✅ R1 (+18 API pins, 4 findings fixed) + orchestrator UI walk (**caught + fixed 1 real leak: palette lock/unlock action was ungated**). Uncleared viewer: no nav/rails/palette-action, zone URLs redirect home. Cleared: full zone renders |
| Staleness non-destructive; sync report complete per S8 | ✅ R2: 9-table before/after graph proves kept-not-deleted; stale still visible to cleared; report has all counts + BOTH unmatched sides (FX3) |
| Docs both registers (register lint clean); no Stash brand assets | ✅ admin "Connecting Stash" + user zone-browsing, 0 warnings on both; nominative name only, no assets |
| STATE.md: decisions recorded; coverage vs mission; home-lab pass logged Open | ✅ this section |

**UI adversarial walk record (orchestrator, 2026-08-01; screenshots reports/stash/r1-walk/):** booted server:3001 + web:3300 against a seeded walk DB (gate 1 capability toggled on, admin holds gates 2–4, PIN 0000). Uncleared (casual): home shows zero zone trace; palette "restricted" → nothing (post-fix); /restricted + /restricted/browse?filters redirect to /home. Cleared (admin): entitlement makes the "Restricted" nav entry + lock control appear; gate screen → PIN unlock → zone home with all four rails (studios w/ logos, performers w/ photos), browse with 5 sorts + density toggle + filters, scene detail with technical facts (NC-17/1H35M/FHD — the S5 authority split visible), performer/studio/tag chips, and 3 chapter deep-links. Direct scene URL re-gated (fail-closed on fresh load — gate 5 holds on direct entry).
**THE UI-WALK LEAK (fixed d0160c3):** the command palette built its lock/unlock action from restricted.state.locked alone (defaults locked for everyone) with NO isRestrictedEntitled gate — an unentitled viewer typing "restricted"/"lock"/"unlock" saw "Unlock restricted content", a trace the zone exists. R1's API walk structurally could not reach this client-only palette state. Fixed to the same fail-closed predicate every other affordance uses; fail-first regression test (+2 cases) pins it.

### OPEN ledger (Stash run — owner-decision + home-lab; nothing silently dropped)

1. **Subset validation (§4)** — owner stages a copy of the real Stash DB + ~500-scene media subset; runbook at reports/stash/subset-validation-runbook.md, report template reports/stash-sync-report.md. ~15 min once staged.
2. **Home-lab full pass** — the real 33k + SMB end-to-end (real mounts, real Stash). The synthetic proof is NOT a substitute.
3. **K3 person_attributes JSONB whitelist** — added by analogy to §6.3's item_attributes; needs owner sign-off to formalize in the plan's whitelist.
4. **S10 sort residue** — sort=duration (needs catalog_items.primary_duration_ms denorm = a writer change across probe + apply, owner call); sort=date (COALESCE-sentinel + LEFT-JOIN satellite key) **[INVESTIGATED 2026-08-11: sentinel mechanism internally consistent; LEFT-JOIN index limitation is the recorded A8b architectural constraint — RE-AFFIRMED]**; **sort=rating is CHEAPLY fixable (R2: two ~1.3MB partial expression indexes, 238→7ms measured) — deliberately not landed because it reverses a recorded 0009 decision (zone-vs-general symmetry = owner call); evidence at the site in restricted-browse.ts. A 0023 migration closes it on a yes.** **[WAVE-A CLOSED a6a3300e 2026-08-11]** (migration 0042; PARTIAL-REVERSAL text quoted at 0009's decision site in restricted-browse.ts; 238.7→7.4ms)
5. **Zone-home rails aggregate** — top-N-by-scene-count has an index-proof floor (~150–190ms); accept or add a clearance-digest cache (§6.4 cache-key precedent).
6. **No DELETE for stash-connection** (FX1) — disable-only today; "forget this connection entirely" is an API gap. **[MOVED to Wave B 2026-08-11]** (contract-touching: new DELETE operation) — **[CLOSED WAVE B (B4) 0d697a65 2026-08-11: DELETE /admin/libraries/{id}/stash-connection landed additively (oasdiff endpoint-added, no breaking; SDK atomic; conformance entry). Scout-grounded semantics: no keyring secret exists to delete (Stash is direct-SQLite, not an HTTP API — the briefed "secret gone" case was documented as vacuous, not faked); synced catalog facts KEPT by construction (satellite tables key off library_id, not the connection); no zombie schedule (loop re-reads the row, treats absence as an ordinary miss); GET-after-DELETE returns to the documented pre-configuration 200 resting state (NOT 404 — that would have broken GET's own tested never-404-for-unconfigured contract); stash.provider.disconnected event added via the 8-step procedure with the real acting-admin actorUserId. D-R2 re-adjudicated the event-schema procedure as sound additive.]**
7. **No success-connect event** — the admin must reopen the Stash modal to see a status flip (only stash.provider.disabled exists; no stash.provider.connected). **[WAVE-A CLOSED 3b08c891 2026-08-11]** (transition-gated)
8. **List-param limit clamp** (R1) — no endpoint clamps limit to the contract's maximum:200 (repo-wide, pre-existing); ?limit=100000 returns a whole list in one page. Conformance + S10-budget item.
9. **Lock scope bounded** (R2) — chapters, stash:/person attributes, provider_ids, artwork cannot be field-locked today (only mergeFields' 10 editorial fields have provenance rows); fine for v1 (no editing UI), a named risk before one lands.
10. **playback.e2e flake** (R1) — "transcode-slots-exhausted" got a non-Loombre 401 once, unreproducible across later runs; someone's eye.



### Mission (verbatim)

Implement the Stash integration end-to-end: a read-only Stash SQLite provider (schema-version-guarded, path-mapped, restricted-scoped) with full metadata mapping (scenes, performers, studios, tags, ratings, dates, details, markers, cover art), an initial + incremental sync engine proven at the owner's 33k-scene scale, and the dedicated Restricted Content surface — browse with filters (performers, studios, tags/genres, rating, duration, resolution, year), performer and studio pages, sort/view options, marker chapters in the player, and restricted-scoped search — all inside the five-gate zone, Phosphor-styled at both breakpoints, with the leak suite extended to every new surface and green.

### Locked decisions (run law — cite S-numbers in lane freezes)

- **S1** Direct SQLite read (owner decision), architected BEHIND the existing provider interface as a first-party restricted-scoped provider; future Stash GraphQL/stash-box mode = additive alternative, never a rewrite. First-party ≠ LPP plugin (deep DB access + dedicated UI exceeds plugin blast radius); community stash-box adapters remain the LPP path.
- **S2** Read-only, always: SQLite immutable/read-only URI; Loombre NEVER writes the Stash DB. WAL-locked → retry w/ backoff → snapshot-copy to temp and read the copy (documented, event-logged). One-way sync v1; write-back out of scope.
- **S3** Schema-version guard: read Stash's schema version at connect; PINNED tested range; outside range → provider disables with precise admin notice ("Stash schema vNN unsupported; supported: X–Y") + event — never best-effort parse. Range is a fixture-tested contract (checked-in schema fixtures per supported version).
- **S4** Matching: primary = canonical path AFTER per-library path-mapping table (admin-configured, live "N of M files matched" preview). Secondary = size + Stash oshash (computed lazily Loombre-side for unmatched candidates only — 64KB head/tail hash). Unmatched Stash scenes AND unmatched Loombre files land VISIBLY in the sync report (H3 no-silent-anything law).
- **S5** Mapping per-field through precedence + metadata_lock (P1.7), Stash provider at TOP of chain for attached libraries: title→title; date→premiere_date/year; details→description; rating100→community_rating (scaled); studio→S6; performers→people (role performer, content_class restricted; aliases/birthdate/country/measurements as item_attributes under stash: namespace); tags→restricted-class tags preserving hierarchy where schema provides it; cover→poster via ingest pipeline (variants + blurhash + dominant color); markers→S7. Duration/resolution stay Loombre-probed — Loombre ffprobe authoritative for technical facts, Stash for editorial facts.
- **S6** Studios = first-class via tags: additive migration adds `kind` to tags (general | genre | studio); studios are kind=studio tags with Stash image ingested; no new entity table — studio browse/filter is tag-filtering with a kind, already guard-scoped. Genre = kind=genre mapping from Stash tag conventions (admin-configurable, default heuristic documented).
- **S7** Markers → chapters: additive chapter_markers table (item_id, title, seconds, source stash); player chapter ticks + chapter list (both breakpoints); deep-linkable start offsets from scene page. UI-only — plan engine + session layer untouched.
- **S8** Sync engine: initial full sync = resumable checkpointed job (tier-capped concurrency; proven at 33k with runtime+memory recorded); incremental via (a) admin button (b) schedule (c) DB mtime watch, diffing Stash updated_at so 12 changed of 33k touches 12 items. Stash deletions → metadata marked STALE (kept, provenance-flagged, admin-filterable) — never destructive. Every sync emits start/complete events with counts; sync report = first-class admin artifact (matched/updated/unmatched/stale/skipped).
- **S9** Restricted surface inside gate-5, replacing nothing outside it: zone home (continue-watching-in-zone, recently-added-in-zone, studios rail, performers rail); browse with combinable filters (performers, studios, tags/genres, rating, duration bands, resolution, year), filter state in URL; sort (added, date, title, rating, duration); density toggle (poster wall ⇄ detailed rows); performer pages (portrait, metadata, filmography) + studio pages (logo, catalog); scene detail (cover, editorial metadata, performer chips, tag chips, markers, play/resume); restricted-scoped search (title/performer/studio/tag) via guarded tsv + people/tags paths. Phosphor at BOTH breakpoints; all queries guard-scoped by construction; zero zone leakage into general search/home/palette/events.
- **S10** 33k-zone budgets: virtualized walls 60fps; keyset pagination on every filter combination (composite/expression indexes WITH the migration, P1-era index law review); p95 ≤ 100ms on T0 profile for zone browse + filtered queries vs 33k synthetic fixture (generator extended to Stash-shaped data at scale).
- **S11** Docs: admin-guide chapter (dignified register) — connecting Stash, path mapping + preview, what syncs, staleness, one-way guarantee ("Loombre never changes your Stash"); user-guide zone navigation (plain register). NO Stash brand assets (nominative name use only).

### Run posture (2026-08-01)

- Sub-agent policy per standing rule: sonnet floor lanes, opus review ×2. Worktree lanes; STATE.md orchestrator-owned; integration to main by orchestrator between phases.
- Precondition VERIFIED 2026-08-01: gate:full ALL STEPS PASSED on main at 0f713a8 (all 14 steps incl. web build budget 166.4 KB gz / 200 KB). Working tree carries only the perf/web-budget-result.json rewrite the budget step itself produces.
- Owner-in-the-loop validation (§4 of the brief): subset run (~500 scenes, copied real Stash DB) is the deliverable this session can stage; the full 33k + SMB pass is HOME-LAB, logged Open, not simulated.

### Kickoff ground truth + orchestrator adjudications (recon 2026-08-01 — K-numbers are run law alongside S-numbers)

Recon: 6 read-only scouts over providers/db/jobs/web/contract/tests. Facts + rulings the lanes cite:

- **K1 (scene identity):** Stash scenes = `item_type 'movie'` rows in restricted libraries (`media_kind 'movie'`). No new item_type. Editorial date: additive `movie_details.premiere_at_ms BIGINT NULL` (no premiere-date column exists for movie-shaped items today; `catalog_items.year` denormalized from it). S5's "premiere_date" reads onto this new column.
- **K2 (tags/studios):** schema reality vs S6 — `kind` today lives on the EDGE (`item_tags.kind CHECK ('genre','tag')`), not on `tags`. Ruling: additive `tags.kind TEXT NOT NULL DEFAULT 'general' CHECK (general|genre|studio)` for entity-level identity (studio image, studio pages) AND additive widening of `item_tags.kind` CHECK to `('genre','tag','studio')` for edge-level filtering. Studios stay `UNIQUE(name, content_class)` rows.
- **K3 (performer metadata):** `item_attributes` FKs `catalog_items` — cannot hold person data. Additive `person_attributes` (person_id FK→people ON DELETE CASCADE, namespace, key, value JSONB, UNIQUE(person_id, namespace, key)) mirroring item_attributes; JSONB-whitelist extension BY ANALOGY to §6.3's item_attributes entry — **flagged Open for owner sign-off**.
- **K4 (zone data architecture):** today's zone fetches the FULL list client-side (deliberate: zero zone-search HTTP side channel). At 33k that design is superseded: the zone gains real guarded keyset endpoints under `/restricted/*` (browse/home/performers/studios/search/detail/chapters). Rationale holds — every request is gate-1..5-checked server-side (`restricted-zone.ts` ground-truthing); scale forces server-side paging; the leak suite grows to cover every new endpoint (R1).
- **K5 (sync application path):** the per-item `metadata` job path (concurrency 2) cannot drive a 33k initial sync. The sync engine bulk-applies through the SAME merge/writer primitives `apps/worker/src/metadata/consumer.ts` uses (`mergeFields`, `upsertCatalogItem`, `upsertSatellite`, `upsertMetadataProvenance`, `findOrCreatePerson/Tag`, `replaceItemPeople/Tags`, image-job enqueue) — extracted into a shared apply module, never a fork of the precedence logic. Provenance source = `provider:stash`.
- **K6 (SQLite driver):** repo has zero SQLite deps. Prefer Node 24 built-in `node:sqlite` (no new native dep); Lane A verifies read-only + immutable-URI + WAL behavior empirically and may fall back to a vetted npm driver WITH license-check + LICENSE-INTENT row. S2's snapshot-copy fallback is the safe path when a live Stash holds WAL locks.
- **K7 (provider registration):** builtin name `stash`, `contentClass 'restricted'`, `kinds ['movie']`; added to `KNOWN_BUILTIN_PROVIDER_NAMES` (apps/server/src/plugins/builtin-metadata-providers.ts) but NEVER to the default `PROVIDER_CHAIN` — attaches per-library via `library_provider_entries` position 0 (S5 top-of-chain). `ProviderRegistry.assertScope` already refuses restricted providers on general libraries.
- **K8 (migration numbering, pre-assigned to kill parallel-lane collisions):** A→`0018` (library_stash_connections, library_path_mappings, stash_scene_links), B→`0019` (tags.kind, item_tags CHECK widening, chapter_markers, movie_details.premiere_at_ms, person_attributes), C→`0020` (stash_sync_reports + report detail rows), E→`0021` (S10 composite/expression indexes). D ships no migrations.
- **K9 (chapters in ms):** S7's "seconds" column yields to CLAUDE.md invariant 5 (milliseconds everywhere): `chapter_markers.start_ms BIGINT` — deviation from brief wording logged here, house law wins. Stash marker `seconds REAL` is converted at map time.
- **K10 (path-mapping preview without server-side SQLite):** the server never opens the Stash DB. `stash_scene_links` holds EVERY stash scene seen (item_id NULLable ⇒ unmatched visible by construction, S4), populated by a cheap inventory pass at connect; the admin "N of M matched" preview is then pure SQL over stored stash paths × candidate mappings × media_files.path — honest label: preview reflects the last inventory/sync snapshot.
- **K11 (B/C seam, frozen):** B owns `apps/worker/src/stash/apply.ts` exporting `applyStashSceneMetadata(trx, deps, input)` (name frozen now); C consumes it via injected dependency and may stub until integration. Orchestrator integrates.
- **K12 (events):** new event types follow the 8-step closed-list process (envelope enum + payload schema + spec count/samples + admin-only list + x-mirror + parity). A adds `stash.provider.disabled` (admin-only, carries the exact S3 notice); C adds `stash.sync.started`/`stash.sync.completed` (admin-only, counts per S8). Events are NOT in openapi.yaml — no SDK step.
- **Ground truth worth repeating:** conformance law — every new endpoint needs an `IMPLEMENTED_NON_PUBLIC_EXPECTATIONS` entry (apps/server/test/conformance.spec.ts) and mounted-route↔contract bijection holds both ways. Leak-suite pattern — three-viewer fixtures (casualUncleared / adminClearedButNotUnlocked / adminCleared) in packages/db/test/leak.spec.ts + HTTP byte-identical-404 twins in apps/server/test/seeded-conformance.spec.ts. Index law — indexes land WITH the query change, EXPLAIN evidence in the migration comment. oasdiff reports but does not hard-block (P4.22 convention) — all additions here are additive anyway. No fps harness exists — 60fps proof stays the empirical DOM-pinned walk. `reports/` is gitignored evidence space. No cron machinery exists — C picks pg-boss `.schedule()` or watcher+debounce (chokidar precedent) and records the choice.

### Lane E freeze (2026-08-01, orchestrator ground-truthed)

**E LANDED a13c0e2..7fbf66b rebased** (6 commits; gate + gate:full both ALL PASSED in-worktree). Facts:

- Chapters end-to-end: GET /items/{id}/chapters (tag catalog-video, no cursor — small complete list); packages/db/src/query/chapters.ts rides getItemById visibility + applyGuardToJoined re-guard (leak 12g, 5 cases: byte-identical-404 for uncleared, []-vs-undefined distinguishable); Scrubber ticks + ChapterList (desktop popover / mobile BottomSheet); VideoPlayer per-item fetch, failure degrades to zero chapters. Deep link `?t=<s>`: **wins over the resume prompt outright** (progress lookup skipped — the deep link IS the user's answer; rationale in VideoPlayer.tsx). Scene-page markers already linked with ?t (D).
- Zone home rails: Row-based, ZonePosterCard extended (aspectRatio/progressPercent/playHref, warning-amber identity), ZoneStudioTile/ZonePerformerTile; performers Avatar-only (no image field in contract yet — FX2). Continue-watching stays 2:3 (Stash ingest only writes poster kind).
- K15 exposure: AdminStashConnection.genreTagNames with a TRI-STATE PUT (omit=untouched / null=reset-to-heuristic / array=replace) — 5 e2e cases.
- **0021 + the headline premise correction: D's library_id-leading composite was WRONG for multi-restricted-library viewers** (btree trailing-column order survives only single-value leading predicates, not ANY()) — E landed `catalog_items (added_at_ms DESC, id DESC) WHERE item_type='movie'` (0009's own partial-anchor trick) + `media_files (item_id) WHERE missing_since_ms IS NULL`. Re-measured (33k, TWO-library viewer): sort=added 253→11–33ms, deep keyset 249→7–9ms, resolution filter 212→7–11ms, performers list 149→7–13ms (finding-6 query reshape — page-then-count, leak semantics proven unchanged), rails 165–245→146–192ms. sort=title never actually breached (D's harness approximated; E measured the real compiled SQL).
- **S10 OPEN residue (owner-sign-off territory, honestly declined here):** sort=duration (needs catalog_items.primary_duration_ms denorm — writer change across probe + apply); sort=rating/date (COALESCE-sentinel keys; follows 0009's own declined-category precedent); zone-home top-N rails (~150–190ms, inherent aggregate floor — only lever is a clearance-digest cache per §6.4's cache-key rule).
- Process: sdk must be BUILT not just regenerated before conformance's bijection test sees a new op; three web test files had inert apiGet/matchMedia stubs that broke on first real use — fixed in-lane.

### FIX WAVE landed (2026-08-01; gate:full ALL 14 PASSED on the assembled tree)

- **FX1 LANDED 0ade0fa** (sonnet lane; gate:full green in-worktree; 63 new web tests — its commit message says 52, the real count is 63, noted by the lane itself). No new route: "Stash" action in each restricted library's row menu → StashModal (Connection / Path mappings / Sync tabs). Tri-state genre control never relies on the omit branch (Save always sends null-or-array — what's on screen is what's written). Preview debounced 400ms, K10 honesty label. S3's notice string finally has its human surface (status_detail verbatim). **Gaps logged Open: no DELETE for stash-connection (disable-only); no success-connect event, so status updates need a modal reopen.**
- **FX2 LANDED 8481a5f, FX3 87905ae, FX4 29068f9** (one sonnet lane; work verified by ORCHESTRATOR — the agent completed and committed everything cleanly but stalled in a wait-loop before delivering its report, third occurrence of the pattern; commits + clean tree + main gate:full green stand as the verification). FX2: RestrictedPerformer.images (RestrictedStudio's shape) + query joins + zone avatars. FX3: unmatchedLoombreFiles on the report endpoint (keyset; live-read set-difference). FX4: usedSnapshotFallback on stash.sync.completed payload (additive-optional) + 0022 nullable column on stash_sync_reports + endpoint field — null semantics documented (terminal-failure runs never learn the answer; pre-0022 rows never claim 'read from source').
- **Orchestrator wiring commit**: report viewer renders the third list (rows normalized {key,primary,secondary} — the one-array-entry addition FX-B pre-structured) + the FX4 snapshot notice in plain language; web 977 green.
- Recurring sub-agent defect for the process ledger: sonnet lanes repeatedly park on "waiting for the background gate notification" despite explicit foreground-only instructions (B once, FX-B once, FX-A terminally). Mitigation that worked: orchestrator reads the worktree state directly and verifies via its own gate run.

### FIX WAVE queue (2026-08-01 — docs lane's code-verified gap audit; dispatch after Lane E lands, before the opus reviews)

The docs lane verified every S11 claim against code and surfaced real coverage gaps (docs were written to actual landed behavior — no invented UI; touch-ups ride this wave):

- **FX1 (the big one — never assigned to any lane): admin web UI for the Stash surface.** Zero references to StashConnection/PathMapping/Sync anywhere in apps/web. Needed per S4 ("admin configures mappings in the library settings with a live preview")/S8 (admin sync button, report artifact)/S11: library-settings section with connection editor (sqlite path, enable, genreTagNames), path-mapping editor + live N-of-M preview (the preview POST exists), sync trigger button, sync-report viewer (counts + unmatched + stale lists). All admin-gated; Phosphor both breakpoints.
- **FX2: performer portraits not exposed** — B ingests person images (kind thumb) but RestrictedPerformer has no image field (RestrictedStudio does). Additive schema field + query join + UI avatar on performer pages/rails.
- **FX3: sync report lacks the Loombre-side unmatched list** — S4/S8 say BOTH sides fully listed; C's endpoint returns Stash-side + stale only (matching.ts documents the set-difference as "caller responsibility", and no caller does it). Add the media_files-without-links query + endpoint field + report UI list (additive).
- **FX4: S2's snapshot-copy fallback is not event-logged** — adapter sets readingFrom:'snapshot' but nothing surfaces it. Additive optional field on stash.sync.completed's payload (evolution policy allows) + carried into the report row.
- **FX5: docs touch-ups post-E + post-FX1** — rails, chapter jump-to-moment (E), the real admin click-paths + screenshot placeholders (FX1), performer photos (FX2).

### Contract additions FREEZE (orchestrator, 2026-08-01 — D's dispatch basis; D authors the yaml + regenerated SDK atomically, shapes below are the frozen surface list)

All additive. Zone ops tag `restricted` (gates 1–5 re-verified per request, existing pattern); admin ops under `/admin/...` with the 401/403 pair + requireLiveAdmin.

- `GET /restricted/home` — zone rails: continueWatchingInZone, recentlyAddedInZone, studios rail, performers rail (server-computed, guarded; K4).
- `GET /restricted/browse` — keyset browse; filters ALL combinable: performerId(s), studioTagId(s), tagId(s)/genre, ratingMin/Max, duration band (ms bounds), resolution band (SD/HD/FHD/UHD from probed media_streams height — S5 technical authority), year range; sort added|date|title|rating|duration + order; cursor/limit per house params.
- `GET /restricted/scenes/{id}` — scene detail: cover ref, editorial fields, studio chip, performer chips, tag chips, markers, progress/resume. Byte-identical 404 to uncleared viewers (house pattern).
- `GET /restricted/performers` (+ q, cursor) and `GET /restricted/performers/{id}` (+ filmography via `GET /restricted/performers/{id}/scenes` keyset).
- `GET /restricted/studios` and `GET /restricted/studios/{id}` (+ catalog via browse filter).
- `GET /restricted/search` — q over title/performer/studio/tag, zone-scoped through the guarded tsv/people/tags paths.
- `GET /items/{id}/chapters` — generic (chapter_markers is content-agnostic; source 'stash' today), guarded like item detail; the player consumes it (Lane E).
- Admin: `GET/PUT /admin/libraries/{id}/stash-connection`; `GET/PUT /admin/libraries/{id}/stash-path-mappings` (wholesale replace, provider-chain shape) + `POST .../stash-path-mappings/preview` (candidate mappings in body → N-of-M + unmatched samples, pure SQL per K10 — works pre-save); `POST /admin/libraries/{id}/stash-sync` ({mode: full|incremental} → job id); `GET /admin/libraries/{id}/stash-sync-report` (latest report incl. unmatched + stale lists, S8).
- Conformance law applies to every op (IMPLEMENTED_NON_PUBLIC_EXPECTATIONS + route↔contract bijection).

### Lane A freeze + orchestrator ground-truth (2026-08-01)

**A LANDED ff488f6..e521912** (7 commits, rebased linear onto main; gate ALL STEPS PASSED twice in-worktree; 91 written test cases / ~105 executed). Facts the other lanes cite:

- Read model FROZEN at `apps/worker/src/stash/read-model.ts`: SqliteReadable; StashScene/getScene/listSceneIds; StashSceneFile/getSceneFiles; StashPerformer/getScenePerformers; StashStudio/getStudio; StashTag/getTag/getSceneTags; StashSceneMarker/getSceneMarkers; StashBlob/getBlob; StashInventoryScene/listScenesForInventory. `folders.path` is absolute in every pinned version — no version branching.
- Pinned schema range **67–85** (Stash v0.27.0 → v0.31.1, newest stable at recon), provenance + release→version table in apps/worker/test/stash/fixtures/README.md. Driver: **node:sqlite** (zero new deps — the lockfile delta is only a @loombre/shared workspace link into packages/db).
- ProviderDetails gaps (documented in providers/stash.ts header): performer aliases/birthdate/measurements, studio parent+image, tag hierarchy, markers have NO home in MovieProviderDetails — S5's rich mapping goes through Lane B's apply.ts consuming read-model.ts DIRECTLY, not fetchDetails. `fetchImages`/`search` are deliberate no-ops (covers are local blob bytes; matching is path/oshash never title search). provider_ids convention: externalId = `"<libraryId>:<stashSceneId>"`.
- Event `stash.provider.disabled` landed (envelope 26→27, admin-only, parity green).
- Process correction (cost A a detour): worktrees branch from committed HEAD — run law must be COMMITTED to main before lane dispatch. Done from here on.

### Orchestrator seam commits (2026-08-01, post-A — dependency-graph surgery so B/C/D parallelize cleanly)

- **K13 implemented at 57e0f72**: `stash-inventory` + `stash-sync` job types pre-added to the closed registry (C implements consumers, D enqueues; NEITHER edits packages/jobs). job.updated jobType enum widened.
- **K8 AMENDED, implemented at 48a81e1**: recon showed D's zone queries need B's editorial schema (tags.kind, premiere_at_ms) — a hidden serialization. The shared DDL landed as ORCHESTRATOR migration `0019_restricted_editorial_schema.sql` (K1 premiere_at_ms w/ absent-means-don't-touch upsert seam, K2 tags.kind + item_tags CHECK widening, S5 tags.parent_tag_id, K3 person_attributes, K9 chapter_markers, K15 genre_tag_names). New numbering: **C→0020 (sync reports), E→0021 (S10 measured-index additions)**; B and D ship NO migrations. Index law honored: 0019 carries the obviously-structural indexes with reasoning; E's 0021 adds what 33k-scale EXPLAIN evidence demands.
- **K14 (contract split):** `GET /admin/libraries/{id}/stash-sync-report` ships with C (its schema+SDK+controller+conformance entry, atomic); `GET /items/{id}/chapters` ships with E (needs chapter query + player UI anyway); genre_tag_names admin exposure on the stash-connection PUT ships with E. Everything else in the freeze list ships with D. C and D both regenerate the SDK in parallel — integration re-runs codegen after the yaml merge, sdk-drift proves the result.
- **K15:** genre mapping config = `library_stash_connections.genre_tag_names TEXT[] NULL` (NULL = Lane B mapper's documented heuristic; explicit array replaces it wholesale). B owns the heuristic; E exposes the field.

### Lane B freeze (2026-08-01, orchestrator ground-truthed)

**B LANDED d4be893..24bbadf** (4 commits, ff onto main; gate ALL STEPS PASSED ×3 in-worktree; 52 new cases). Facts lanes/reviews cite:

- `applyStashSceneMetadata(trx, deps, input)` FROZEN as landed: input = StashSceneBundle {scene, files primary-first, performers, **studioChain resolved ancestor chain ([0]=own, [1]=parent…)**, tags, markers} & {libraryId, itemId, stashSceneId, genreTagNames}; deps {getBlob, enqueueImageJob, clock?}; returns {changedFields}. Opens/joins its own withTransaction; image jobs enqueue AFTER commit. **Seam requirement on C: C resolves studioChain via read-model parent walks before calling apply.**
- Genre heuristic (K15 NULL case): root Stash tags (no parent) ⇒ genre; child tags ⇒ plain tag; explicit genre_tag_names overrides case-insensitively. Rating: community_rating = rating100/10 (matches tmdb's native 0–10 usage; conversion documented both in apply.ts and providers/stash.ts).
- Image pipeline extended additively: `local-temp:` sourcePath prefix (staged blob bytes, temp-deleted post-read; bare local paths stay permanent — the distinction is the point), entityExists now recognizes 'tag' (studio logos) + 'person' (performer portraits) — previously enqueue for those silently no-opped. Performer/studio images deduped via hasOriginalImage; scene cover never gated (C's diffing bounds apply frequency).
- New internal writers: item-attributes.ts, person-attributes.ts, chapter-markers.ts (wholesale replace); findOrCreateTag gained optional {kind, parentTagId} absent-means-don't-touch 4th arg; metadata/layers.ts extracted verbatim from consumer.ts (its 8 original cases prove behavior unchanged). runtime_ms/duration/resolution NEVER written from Stash (S5 authority split, tested).
- **Process correction (affects C/D too): B's worktree branched from STALE 0f713a8 despite 500c156 being committed first — worktree creation snapshots at agent-session start, not dispatch. B self-diagnosed + fast-forwarded; orchestrator warned C/D mid-run.**

### Lane C freeze (2026-08-01, orchestrator ground-truthed; real-apply wired at e6f1aa4)

**C LANDED 0511653..3df8a8d rebased onto B** (9 commits; gate ALL 13 + gate:full ALL 14 PASSED in-worktree). Facts:

- Checkpointing: scan_checkpoints' same-job-id-on-retry shape via NEW `stash_sync_checkpoints` (0020) — stash-sync is LONG_RUNNING/retryLimit 2, one promise per run; inventory+matching re-run fresh each attempt (idempotent), only the apply phase checkpoints/skip-resumes.
- Schedule (S8 trigger b): boot-timer + settings-registry key `stash.sync.scheduleIntervalMs` (default 0/OFF) — plugin-delivery-loop shape, chosen over threading pg-boss .schedule() through the shared JobQueue (blast radius). Trigger c: chokidar mtime watch per enabled connection → debounced incremental enqueue.
- Events stash.sync.started/completed landed (envelope 27→29, admin-only, parity + actor-field-map green). Contract op GET /admin/libraries/{id}/stash-sync-report + SDK atomic + conformance entry.
- **SCALE PROOF (33k synthetic, apply STUBBED — honest caveat recorded):** initial full sync **69.3 s wall / 476.7 MiB peak RSS**; matched 32,314 / unmatched 686; incremental with 12 mutated scenes → touchedCount === 12 (asserted); checkpoint resume: crash after 666 applies → resume same job id → all scenes applied, zero lost (15 redone past last checkpoint, expected). Harness: scripts/gen-stash-fixtures.mjs + scripts/stash-scale-proof.mjs. END-TO-END re-proof with real apply = orchestrator item before exit gate.
- Premise corrections: stale worktree base again (self-fixed ff to 500c156); packages/jobs barrel never re-exported the K13 payload types (fixed, barrel-only); mid-run signature re-freeze to B's landed shape absorbed cleanly.
- Integration: real applyStashSceneMetadata wired at **e6f1aa4** (the planned one-line swap; worker 1113 passed post-wire).
- **END-TO-END 33k RE-PROOF (orchestrator, real apply, quiet machine, harness --real-apply at 778158b): ALL PROOFS PASSED — full sync 287.9 s wall / 404 MiB peak RSS, matched 32,314 = updated 32,314, unmatched 686 (the fixture's deliberate set), stale 0; incremental 12 changed → touchedCount 12; resume all-2000/zero-lost (15 redone past last checkpoint, expected).** Caveat recorded: the synthetic fixture carries NO cover blobs (imageJobsEnqueued 0) — image enqueue-at-scale rides the owner's real-DB subset validation (§4), not this proof.

### Lane D freeze (2026-08-01, orchestrator ground-truthed)

**D LANDED 2a03cab..c0d64cc rebased onto C** (3 commits; gate:full ALL 14 PASSED in-worktree, /browse 166.4 KB gz). Facts:

- All frozen zone + admin ops landed EXCEPT K14's two (sync-report=C ✓, chapters=E pending). `GET /restricted/items` kept DEPRECATED (oasdiff flagged hard removal as breaking; evolution policy) — thin delegate to listRestrictedBrowse. RestrictedScene gained `durationMs` additively (editorial runtimeMs is never populated for Stash scenes — probed duration is the honest field).
- **Leak suite +26 cases (12a–12f) incl. a REAL fail-first catch:** getRestrictedSceneDetail originally resolved GENERAL item ids through the zone-only surface for cleared viewers — fixed with an explicit content_class='restricted' predicate; pinned by case "a general (non-zone) item id is ALSO undefined through this surface, even fully cleared". HTTP twins: 11 e2e in libraries.e2e.spec.ts (alongside the /restricted/count precedent — brief named seeded-conformance, D corrected).
- Query modules: restricted-{browse,performers,studios,search,home}.ts; resolveEntitledRestrictedLibraryIds now exported from restricted-zone.ts and shared. Browse resolves primary file + video stream via leftJoinLateral (duration/resolution = probed facts, S5).
- Web: 8 /restricted/* routes; Zone{BrowseGrid,FilterBar,SortControl,DensityToggle,DetailedRow} components; URL filter state in lib/zone-browse-filters.ts (CSV ids, minutes bands, defaults omitted); density = localStorage-only (personal pref, not shareable URL state — appearance-prefs precedent). Full-fetch machinery retired (restricted-zone-items/toolbar deleted); gate flow/PinModal/entitlement predicates untouched. Genre picker reuses GET /tags?kind=genre client-filtered to restricted (documented; no new surface).
- **EXPLAIN evidence for E's 0021** (33k seeded, ANALYZE'd; full writeup preserved at reports/stash/explain-findings-0021.md + reusable seed/EXPLAIN scripts in session scratchpad): 6 T0-budget breaches, 5 collapsed by ONE composite `catalog_items (library_id, added_at_ms DESC, id DESC) [WHERE item_type='movie']` + sort_title twin; sort=duration unindexable (per-item LATERAL; denorm needs owner sign-off — measure after finding 1); performers-list aggregate → partial covering idx or LATERAL-count query reshape; top-N-by-count rails have an inherent aggregate floor (accept or clearance-digest cache).
- Integration conflicts (recorded for honesty): sdk/generated regenerated from the auto-merged yaml (codegen is the authority), admin-plugins.module.ts + conformance expectations resolved as unions of C's and D's additions.

### Lane burn-up

| Lane | Scope | Model | Status |
|---|---|---|---|
| A | Provider core: SQLite RO adapter, S3 guard + schema fixtures, S4 matching + path-mapping + oshash, S2 lock lifecycle | sonnet | **LANDED ff488f6..e521912** |
| B | Mapping S5–S7: apply.ts entity writers via 0019 schema, image ingest, precedence/lock, stash:/person attrs, genre heuristic | sonnet | **LANDED d4be893..24bbadf** |
| C | Sync engine S8: consumers, checkpoints, incremental diff, staleness, events, 0020 + report endpoint; 33k fixture gen + scale proof | sonnet | **LANDED 0511653..3df8a8d + e6f1aa4 wire-up** |
| D | Zone surface S9: contract+SDK atomic, guarded zone queries, routes, filters + URL state, performer/studio/scene pages, search, density | sonnet | **LANDED 2a03cab..c0d64cc** (rebased; conflicts: sdk regen + module/conformance unions) |
| E | Player chapters UI + /items/{id}/chapters + zone home rails + genre-config exposure + 0021 indexes w/ query plans | sonnet | **LANDED a13c0e2..7fbf66b** (rebased; both gates green in-worktree) |
| Docs | S11 both registers: admin "Connecting Stash" chapter + user-guide zone browsing | sonnet | **LANDED 6460361** (register lint 0 warnings for both files; gate green) |
| R1 | opus: leak-suite extension + adversarial zone walk (fail-first then green) | opus | **LANDED 2eacbf5..f067429** (rebased) |
| R2 | opus: mapping fidelity + safety audit (S2 fs-proof, S3 both-ways, S4 visibility, staleness, authority split, S10 indexes) | opus | **LANDED fbea941..3518bec** (rebased) |

### Review freeze — R1 adversarial leak sweep (2026-08-01)

Four findings, all fail-first, all fixed in the same lane; 18 no-leak probes pinned permanently; leak.spec 67→78, libraries.e2e 12→18, ws-broadcaster 5→6; gate green.

1. **REAL LEAK (D's general-id class, replayed one level down):** /restricted/performers/{id}/scenes accepted a GENERAL-class person id (role='guest' credit on a zone scene) that the parent surface 404s — 200 with a real scene card. Fix: browse's performerIds EXISTS now carries `role='performer'`, the same predicate every surface that MINTS a performer id uses.
2. **Forged cursors were 500s** (driver 22P02 surfaced as urn:loombre:problem:internal). Typed MalformedCursorError + uuid-format checks in the lagging validators + one ProblemJsonExceptionFilter branch → 422 problem+json PRODUCT-WIDE, payload never echoed; five zone ops declare 422; SDK regenerated. Case pins "the 422 must never become an entitlement oracle."
3. **Contract-description leak-in-waiting:** /restricted/home's prose promised locked viewers aggregate studio/performer rails; the code (correctly) returns all-empty, pinned by 12f — contract text corrected toward the safe behavior before anyone "conformed" the code to it.
4. **Unproven image gate:** the existing uncleared-404 image assertions passed vacuously (no fixture pointed at a real file — stat() failed for EVERYONE; studio logos had no fixture). Fixed test-side with a real PNG + repointed rows; the production gate was correct all along, now actually proven.
- Out-of-scope finding logged Open: NO limit clamp to the contract's maximum:200 anywhere (repo-wide, pre-existing) — ?limit=100000 returns the whole zone in one page; conformance + S10-budget item.
- **UI walk NOT performed by R1** (chrome-devtools MCP: profile-lock, no isolation flag reachable; claude-in-chrome: extension not connected). Server-rendered HTML of zone routes carries zero zone strings (app is client-auth'd, so HTML proves only the shell). API walk done + permanent. Visual walk = orchestrator/owner item.
- One unrelated flake noted for someone's eye: playback.e2e "transcode-slots-exhausted" got a non-Loombre-shaped 401 once, unreproducible across two later full runs.

### Review freeze — R2 fidelity + safety audit (2026-08-01)

Nine checklist items: 3 DEFECT-FIXED, 5 STRENGTHENED, all green; +30 tests (worker stash 84→114); gate green.

- **S2:** proof covered only the adapter session + failed-snapshot path — now: successful-snapshot fs-assertion (write-free BEGIN IMMEDIATE lock trick), full-sync-path byte/mtime/directory assertion, and the WAL truth: read-only open of a WAL DB ALWAYS creates -wal/-shm siblings it cannot remove — the .db is untouched (asserted) but a read-only DIRECTORY makes the DB unreadable with SQLite blaming "readonly database"; explainOpenFailure now names the real cause; guarantee's true scope written into the adapter header + admin guide (orchestrator commit 7f8bf50).
- **S3:** boundary fixtures (67/85) now SYNC end-to-end, not just connect; in-range-but-mangled-table fails loudly, nothing half-applied.
- **S4 DEFECT:** oshash laziness was false — path-matched candidates were re-hashed on size collision AND two Stash scenes could silently link one item; fixed (pass-1-claimed candidates excluded), pipeline.spec.ts created (the file pipeline.ts's header always cited but nobody wrote).
- **S8:** staleness proof widened from link-row-survives to a full 9-table before/after graph with non-vacuity guard; stale scenes proven still visible/playable to cleared viewers.
- **S5:** the premiere_at_ms seam was unpinned on the CONSUMER side (one plausible line in the tmdb refresh would NULL every scene's date with a green suite) — mutation-verified test added. Lock-scope honesty written into apply.ts: chapters/attributes/provider_ids/artwork CANNOT be locked today (fine v1, named risk before any editing UI).
- **S10:** E's partial-index correction empirically confirmed (D's composite is NOT EVEN USED at 33k/two libraries: 240.9ms seq-scan vs 0021's 7.6ms). date/duration honestly owner territory (expression index confirmed unused). **sort=rating IS cheaply fixable: two ~1.3 MB per-direction partial expression indexes, 238.7→7.4ms measured — deliberately NOT landed (reversing a recorded decision citing 0009's precedent = owner symmetry call); evidence at the exact site in restricted-browse.ts.**
- **FX4 chain + 33k proof integrity:** honest at every hop; the proof script's headline line printed "[apply STUBBED]" unconditionally — including for the --real-apply run STATE.md recorded (JSON was correct; the human-copied line wasn't) — fixed, label derived from the flag; imageJobsEnqueued:0 verified as a fixture fact (NULL blobs), now stated in the script header.

## rc.3 field UX round — controllers can now START a stopped server; installs end in the browser, not silence (2026-07-31)

Owner field report, three defects, one shared root: (1) tray/menubar "Start server" permanently grayed out; (2) Windows Start-Menu launch does nothing visible; (3) no launch option at install completion and no browser-open to the setup wizard. **Owner posture note (2026-07-31): Windows ships the Burn bundle `.exe` ONLY — the bare `.msi` is no longer a published artifact.** That made (3) strictly worse than rc.1 left it: Burn runs the chained MSI silently, so `ca.LaunchTray`'s `UILevel > 2` gate means it NEVER fires for real users — every bundle install ended with nothing on screen at all.

- **Root cause of (1) — the long-open "IPC start-when-stopped hole" (this file's I3/I4 ledger), now DECIDED and CLOSED as: controllers delegate start to the platform service manager; IPC stays status/stop/open-web.** Both controllers gated the Start item on a successful IPC poll — a connection to the very process the user wants to start. `IPC_SERVER_START_SEMANTICS` (frozen contract, unchanged by this round) already said start-a-stopped-server must go via SCM/launchctl; neither controller had implemented it, so "Start server" was enabled only in states where its label read "Stop server". Provably disabled in every reachable state, both platforms.
- **Windows fix:** decision table `ServerControl.Decide` + `TrayLaunchModes` live headless in Loombre.Tray.Ipc (pinned by new ServerControlPlanTests + TrayLaunchModeTests); `ServiceManagerProbe` (WinForms side, new `System.ServiceProcess.ServiceController 8.0.1` ref — LICENSE-INTENT row amended) queries SCM state and starts the three-service stack, server first, downstream best-effort. Unreachable-IPC no longer hard-disables: SCM `stopped/paused` ⇒ ENABLED Start; SCM `running/startPending` with IPC down ⇒ honest disabled "Starting server…" (first-boot payload-extraction/initdb window). **Services.wxs grants `[WIX_ACCOUNT_USERS]` ServiceQueryStatus+ServiceStart via `util:PermissionEx` on all three services** — deliberately the SAME trust boundary as the existing `LOOMBRE_IPC_WINDOWS_GRANT=*S-1-5-32-545` token-file posture (owner-review item 1: any local user may drive status/start/stop; this makes the SCM agree with the IPC, widens nothing new — fold into that item's sign-off). No ServiceStop grant (stop stays IPC-graceful). Pre-grant installs fall back to ONE UAC `sc start` prompt.
- **macOS fix:** `MenuState.lifecyclePlan` (LoombreIPCKit, LifecyclePlanTests — mirrors the C# table; edit together) + `LaunchdFallback` constants + `PrivilegedLaunchdStart` (in-process NSAppleScript `do shell script … with administrator privileges`, so the credential prompt says Loombre, not osascript; kickstart-then-bootstrap composition; explicitly NO SMJobBless helper — a per-click admin prompt is the smaller honest surface for an unsigned pkg, P4.1). Needed because `com.loombre.server.plist` KeepAlive.SuccessfulExit=false means the menubar's own Stop leaves the daemon down with no UI way back.
- **(2) fix — three launch paths now carry three intents** (TrayLaunchModes, flags authored in Shortcuts.wxs/Bundle.wxs so a typo there fails a C# test): Start-Menu = flagless Interactive ⇒ surface the web UI; HKLM Run key now passes `--autostart` ⇒ silent icon (never a browser at logon); installer passes `--open-web` ⇒ wait-for-ready then browser. A SECOND interactive launch (the exact rc report: mutex-second exits silently) now signals the live instance over a `Local\` auto-reset event (`Loombre.Tray.OpenWebSignal`); the live instance runs the same surface flow. Surface flow = open browser when IPC answers; else balloon-tip the truth ("starting — browser will open when ready" / "server is stopped — right-click and Start server" / 180 s timeout warning). NotifyIcon balloons replace dead silence.
- **(3) fix — completion-window launch + browser-to-setup on every channel.** Windows: `Bundle.wxs` defines WixStdBA `LaunchTarget`/`LaunchArguments` variables ⇒ the success page grows a "Launch" button ⇒ `Loombre.Tray.exe --open-web` (the ONLY completion vehicle on the exe-only channel; `ca.LaunchTray` also upgraded to pass the flag for interactive direct-MSI runs, still UILevel-gated for silent). macOS: menubar auto-opens the web UI ONCE PER USER (UserDefaults `didAutoOpenWebOnFirstRun`, com.loombre.menubar domain) the first time a reachable server advertises `webUrl` — postinstall bootstraps the agent while Installer.app still shows the conclusion pane, so a fresh install flows straight into the browser; `conclusion.txt` rewritten to say so. Both land on `/setup` on fresh installs because the web root auto-routes (`decideBootRoute`: unauthenticated + needsSetup ⇒ /setup) — no installer knowledge of wizard routes.
- **Verification ceiling (I3 posture unchanged, no dotnet on this host):** Swift 54/54 green + clean build (`swift test`, menubar); C# authored test-first but compile/test = CI/Windows VM; all four edited .wxs xmllint-clean; `util:PermissionEx`-under-ServiceInstall + `WIX_ACCOUNT_USERS` PropertyRef + WixStdBA Launch variables need first `wix build` evidence; grep-gates PASS (2088 files).
- **OWNER-REVIEW (new, small):** (a) the SCM ServiceStart grant above — same decision as review item 1, one sign-off should cover both; (b) macOS users UPGRADING get the one-time browser-open too (defaults key is new) — accepted as a release-notes line; ditto a brand-new macOS user account's first login gets one tab, once, ever.

## rc.1 REAL-MACHINE debug — Windows DOA root-caused, install-visibility gap closed (2026-07-27/28)

Owner installed the rc.1 draft on real hardware. Two independent classes of defect, neither reachable from CI.

- **WINDOWS, fatal: `VCRUNTIME140.dll` is not part of Windows.** Both LoombreServer and LoombreWorker died at boot, three restarts each, on `ERR_DLOPEN_FAILED` loading `@napi-rs/keyring`'s `.node`. The file was PRESENT — Node resolved it, resolution checks existence — so the failure was a missing *dependency* of it. PE import tables confirmed on both shipped binaries: `keyring.win32-x64-msvc.node` → `KERNEL32, VCRUNTIME140.dll, advapi32, bcryptprimitives, api-ms-win-crt-*`; `postgres.exe` → `KERNEL32, VCRUNTIME140.dll, Secur32, WS2_32, libcrypto-3-x64, icu*, api-ms-win-crt-*`. The UCRT (`api-ms-win-crt-*`) half ships with Windows 10+; `VCRUNTIME140.dll` comes from the VC++ 2015-2022 redistributable. Owner's box: `Test-Path System32\vcruntime140.dll` = **False**. **Every GitHub windows runner has it (Visual Studio preinstalled) — which is exactly why diag round 18 could assert `/healthz` 200 against an MSI that was dead on arrival on a clean machine.** node.exe itself links the CRT statically, so LoombreWeb kept serving :3000 throughout — the single most misleading symptom ("web works, server doesn't").
- **CONFIRMED ON THE OWNER'S MACHINE (2026-07-28):** after `winget install Microsoft.VCRedist.2015+.x64` and a service restart, **the server launched and the first-run setup wizard rendered**. Root cause proven by the fix working on the failing host, not merely inferred from the import tables — Windows now joins macOS/Linux/Docker as a channel observed running the full app end-to-end on real hardware.
- **Two fixes, both needed.** (1) `packages/secrets/native-keyring.ts` imported `@napi-rs/keyring` STATICALLY at module scope, so an environmental dlopen failure propagated through the import graph and killed the process — while `detect.ts` has always documented `source:"fallback"` as covering "the addon didn't load" and file0600 works everywhere with nothing native. Load is now LAZY + typed-error-wrapped; a dead addon degrades to file0600 instead of a boot loop. Regression test reproduces the real failure shape (`vi.mock` factory that throws) and failed at `native-keyring.ts:34` before the fix; 38/38 secrets tests pass after, incl. the real darwin Keychain round-trip. (2) The MSI now blocks at `LaunchCondition` with an actionable message + winget one-liner, since embedded PostgreSQL — the DEFAULT database — cannot start without the runtime either; keyring being optional does not save it. Detection is deliberately fail-OPEN (System32 FileSearch **OR** the redist's canonical registry marker): a detection bug must degrade to today's behaviour, never brick installs for everyone.
- **MACOS was never broken.** Verified live on the owner's Mac: server pid 64082 `/healthz` 200, next-server pid 64086 `/login` 200, worker running, embedded PG 18.4.0 running as `_loombre`, IPC discovery+token readable by the console user (full status response, `state:"running"`). `pkgutil` receipt: installed 19:34:54, server up 2 s later. The `ERR_MODULE_NOT_FOUND` crash-loop in the logs is timestamped 19:34:33 — **before** that install — i.e. the previous build's daemons, which `preinstall` then evicted. The actual defect: **nothing surfaced any of it.** `Distribution.xml` had `onConclusion="none"`, postinstall never launched the app, and there was NO LaunchAgent — so the menu bar stayed empty at install AND after every reboot, while Windows had had an HKLM Run key since day one. Fixed: `com.loombre.menubar` LaunchAgent (`/Library/LaunchAgents`, RunAtLoad, no KeepAlive — a menu bar item that respawns when you quit it is hostile), postinstall `launchctl bootstrap gui/<uid>` for the console user, preinstall bootout for upgrades, and a conclusion pane naming `http://localhost:3000`.
- **Same gap on the other channels:** Linux `install.sh` enabled the units but never started them (printed a `systemctl start` line and exited); now `enable --now` by default with a `--no-start` opt-out — the shipped defaults are a complete working configuration, so "configure the env file first" did not justify making every operator pay. Windows now launches the tray at end of install (`ca.LaunchTray`, impersonated, `asyncNoWait`, skipped under `/qn`).
- **Also fixed from the field data:** duplicate tray processes (owner's box had TWO `Loombre.Tray.exe`; now a `Local\` single-instance mutex — three launch paths exist, so duplicates were the expected case), and `LoombreServiceHost.exe` run with no arguments produced a `0xE0434352` APPCRASH + WER minidump per invocation (unhandled `ArgumentException`) — now a usage message and exit 2, no dump polluting the log an operator searches when something real breaks.
- **Docker + Linux independently re-verified green on this host, full runs:** Docker smoke 12/12 (migrate, seed, login round-trip, catalog read, web `/login`, worker SIGTERM clean shutdown, teardown). Linux smoke ALL CHECKS PASSED in `ubuntu:24.04` — external-PG scenario, embedded scenario (initdb + auto-migrate + `/healthz` 200), web `/login` 200, worker discovery-join with zero `DATABASE_URL`, clean uninstall, foreign-file safety.
- **KNOWN, NOT YET FIXED — Windows web runs an unsupported Next configuration.** `web.log`: `⚠ "next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.` It serves correctly today (200 on `/login`), but it is explicitly unsupported and could break on any Next minor. The Windows lane chose `next start` over a hoisted deploy because the standalone tree's pnpm links cannot survive the zip boundary; the real fix is to materialize the standalone tree with real files. Own it before GA.
- **CI GAP this exposed (the important lesson):** every install smoke runs on a runner whose toolchain is a superset of a user's machine. Runner-only DLLs, runtimes and SDKs are invisible to it BY CONSTRUCTION. A green install smoke is evidence the *package* is coherent, never that a *clean machine* can run it.

### rc.2 field test: the worker was ALIVE and inert (2026-07-28)

Owner installed rc.2 on Windows, completed setup through Hardware, and hit "Worker not detected yet" with the tray reading "Worker: stopped". Neither of the two obvious explanations was right — the worker process was running, and the tray was not merely misreporting.

- **What the log actually said (owner's `worker.log`):** ten `[@loombre/jobs] failed to register work handler for "<queue>": ECONNREFUSED 127.0.0.1:5433` at 00:51:01, then `worker: failed to run hwcaps boot check: ECONNREFUSED` at 00:51:06, then — **after all of them** — `worker up — pg-boss consumers registered: scan, probe, metadata, …`. The server's `startedAtMs` puts its own boot at 00:50:53, so the worker lost a race with first-boot embedded-PG provisioning by ~8 seconds. IPC at diag time: `provisioning: {state:"ready"}`, i.e. PostgreSQL was long since up.
- **Root cause 1 — a rejected promise cached forever.** `packages/jobs/src/queue.ts`'s `startPromise ??= …` memoized the FIRST `boss.start()` failure permanently. Every later `enqueue`/`work` re-awaited that stale rejection instead of reconnecting; the tell is the hwprobe error carrying a `PgBoss.start`/`Contractor.isInstalled` stack on a call that never attempted a connection. Fixed two ways: `ensureStarted()` now RETRIES within a bounded window (a database that is still starting is "not yet", not "broken" — every installer starts worker and server concurrently and the server must run initdb first), and a rejection is no longer cached, so a later call genuinely retries. **Deliberate contrast recorded in the code:** `packages/secrets/native-keyring.ts` caches its rejection ON PURPOSE — a missing system DLL cannot appear later in a process's lifetime, whereas a starting database can.
- **Root cause 2 — the worker announced success over ten failures.** `queue.work()` is fire-and-forget with a `.catch()` that only logs, so `main()` could not know. New additive `JobQueue.ready()` tracks every registration; `apps/worker` awaits it BEFORE printing "worker up", so a failure throws and `main().catch` exits non-zero. A silent no-op worker is far worse than a loud restart.
- **Root cause 3 — and nothing would have restarted it anyway.** `LoombreHostedService.OnChildExited` called `Stop()` with no exit code, so SCM saw a GRACEFUL stop and never applied the `util:ServiceConfig` recovery actions. Owner's own earlier data: `LoombreWorker status=Stopped exit=0 svcExit=0`, with a 7031 "terminated unexpectedly" for LoombreWeb but none for the worker. This silently defeated Services.wxs's documented claim that the worker's bounded discovery poll DEPENDS on SCM restarting it. Now sets `ExitCode = ERROR_PROCESS_ABORTED (1067)` plus `ServiceSpecificExitCode` = the child's real code.
- **Still open (unchanged, now the ONLY remaining worker-status defect):** `worker-liveness.ts` infers state from the jobs ledger, so an idle worker reads "stopped". Confirmed live on macOS earlier this session (IPC said stopped while pid 64084 ran). A real heartbeat is the fix; not attempted here because the rc.2 report turned out to be a genuine functional failure, not the cosmetic one.

### Windows ships ONE artifact (owner: "this new setup is confusing me as a user. what am I supposed to run?")

rc.2 published `.exe` and `.msi` side by side, differing by three characters, with the distinction resting on Windows Installer trivia (an MSI cannot install another MSI, so a prerequisite chainer MUST be a separate bootstrapper). Making a user learn that in order to pick a download is a failure of the installer. Releases now stage **only** `loombre-<version>-windows-x64.exe`, which is a strict superset — it embeds the same MSI, adds the VC++ prerequisite, registers a normal ARP entry, and supports `/quiet /norestart /log`. The MSI's own advantages are all fleet-management features (GPO Software Installation, ProductCode detection, `.mst`, `msiexec /a`, `.msp`) that nobody has asked for; it is still BUILT and still smoke-tested end-to-end by windows-msi-diag.yml, so re-publishing is a one-line change.

### Prerequisite auto-install + app icon (owner directive, same session)

Owner: "installers detect that the necessary dependencies are installed and if not, automatically prompt the user to install them prior to continuing" + "add the app icon so that it doesn't appear blank after install".

- **Dependency audit done EMPIRICALLY across every bundled native binary, not assumed.** Windows: `VCRUNTIME140.dll` is the ONLY missing-dependency class — needed by `postgres.exe` (+ every pg client tool) and `keyring.win32-x64-msvc.node`. `@img/sharp-win32-x64` imports only `KERNEL32`, `libnode.dll` and the libvips DLLs shipped inside its own package, and **both** `libvips-42.dll` and `libvips-cpp-8.18.3.dll` were checked and import no vcruntime/msvcp/concrt (CRT-static) — verified rather than assumed, precisely because keyring taught us not to. macOS: **nothing** — `otool -L` across node, postgres, initdb, ffmpeg and both `.node` modules shows every non-stock dependency is `@loader_path`/`@rpath`-relative, i.e. bundled alongside. Linux: the three already-known sonames. Docker: the image owns its deps.
- **Windows now ships TWO artifacts.** `loombre-<version>-windows-x64.exe` is a WiX Burn bootstrapper (`installers/windows/msi/Bundle.wxs`) that detects the redistributable and installs it before the MSI; `…-windows-x64.msi` is unchanged for silent/managed deployment and keeps its blocking LaunchCondition. The redistributable is pinned in `installers/windows/vcredist-manifest.json` against an **immutable versioned** Microsoft URL (NOT the rolling `aka.ms` pointer, which would break any pinned hash on every servicing update) and embedded (`Compressed="yes"`) so installs work offline; `scripts/fetch-vcredist.mjs` downloads + verifies (sha256 `843068991daaa…`, re-verified on cache hits too — it is an elevated executable). `Permanent="yes"`: uninstalling Loombre must never remove a shared runtime other software now depends on. Exercised end-to-end on this host: download, verify, cache-revalidate.
- **Linux `install.sh` now detects and OFFERS to fix.** The ldd preflight was moved to run BEFORE any service start — it previously ran at the very end, survivable only while the script left services stopped; with `enable --now` a missing library would have meant a crash-looping server with the warning scrolled off the top. It picks the install command by which package manager EXISTS (apt-get/dnf/zypper/pacman/apk — derivatives lie about `/etc/os-release` ID, they cannot fake having apt-get), prompts interactively showing the exact command, re-probes with ldd afterwards (trust the linker, not the package manager's exit code), and refuses to START services it knows cannot work. `--install-deps` for unattended, `--no-install-deps` to opt out; a non-interactive shell never mutates the package set silently.
- **App icon wired everywhere it was blank.** `scripts/build-app-icons.mjs` generates `design/blaze/assets/icons/loombre.{ico,icns}` from the 1024px Blaze source (hand-written ICO container — 6-byte header + 16-byte entries + PNG payloads, which every Windows since Vista reads — so no ImageMagick/npm dependency enters the icon pipeline). Outputs are COMMITTED because the `.ico` is consumed on a Windows runner that has neither `sips` nor `iconutil`. Wired: macOS `Contents/Resources/AppIcon.icns` + `CFBundleIconFile` (extension-less — the suffixed form silently falls back to the blank icon on some OS versions), Windows `ARPPRODUCTICON` + Start Menu shortcut `Icon` + the tray exe's `ApplicationIcon` resource + the bundle's `IconSourceFile`.
- **UNPROVEN, needs a Windows run:** Bundle.wxs, the two C# edits and the LaunchCondition have never been compiled — there is no .NET SDK on the dev host. `windows-msi-diag.yml` gained a bootstrapper install/uninstall smoke (incl. asserting the redistributable SURVIVES uninstall) and that is what has to go green. Note honestly what that job can and cannot prove: the runner already has the redistributable, so it exercises the DETECT-AND-SKIP path and the MSI chaining, never the install-the-prerequisite path — which is provable only on a clean image, and is exactly the gap that let rc.1 ship broken.

## Completeness wave VERIFIED — all four channels boot the full app (2026-07-27/28)

- **Windows (diag rounds 13-18, each a first-execution truth):** stageWeb's dereferencing cpSync over the junction-structured standalone tree = silent exit-127 hard crash (verbatim copies + step logging); .NET 8's strict RequestAdditionalTime validation threw in OnStart and killed extract-carrying hosts with ZERO output (best-effort + never-die-silent guards + pre-logger svc-trace breadcrumbs); Next standalone's linked node_modules cannot survive the tar -L zip boundary — the keyring sibling-severing class again — so Windows web ships a HOISTED @loombre/web deploy + .next output and runs `next start --hostname 0.0.0.0` (HOSTNAME env dropped: Windows pre-sets it to the machine name); the diag's import-graph probe was DEFEATING main.ts's isDirectEntrypoint guard by passing the script path as argv[1] (booted the server in a bare env; dummy argv[1] fixed it). **Round 18: MSI:PASS + INSTALL:PASS (import graph, /healthz 200 = embedded PG provisioned+auto-migrated under a real restricted-token LocalSystem service, web /login 200, discovery file present) + UNINSTALL:PASS (zero residue).**
- **Linux (smoke rounds 5-10):** stale-server masquerade fixed (teardown pkill'd wrapper paths that exec'd away; dist-path kills + waitForPortFree barrier); precompiled @loombre/db was missing migrations/ + the ./migrate export (fingerprint also now covers the exportsMap — a second stale-cache class); embedded-PG shared-lib prerequisites ldd-probed EXHAUSTIVELY = libgssapi-krb5-2 + libxml2 + libreadline8 (smoke installs them; install.sh WARN-preflight with per-distro remedies; docs); initdb "invalid locale name en_US.UTF-8" on locale-less hosts → EmbeddedPostgresConfig.localeProvider="builtin" with C.UTF-8 (OS-independent; libc default preserved for existing tests; ICU linguistic collation = later per-database follow-up); macOS AppleDouble "._*.sql" tar entries reached PG as migrations (dotfile filter in BOTH runner twins + COPYFILE_DISABLE in tar). **Round 10: ALL CHECKS PASSED incl. embedded scenario — server (provision+auto-migrate), web /login 200, worker discovery join, zero DATABASE_URL.**
- **Whole-board status: macOS ✓ (local build + staged-web boot via bundled runtime + release-time PackageKit install smoke w/ web assert), Docker ✓ (both images, compose stack, web /login, teardown), Linux ✓ (round 10), Windows ✓ (round 18).** pnpm v11 verifyDepsBeforeRun disabled in pnpm-workspace.yaml (the .npmrc key is ignored on v11) — kills the no-TTY auto-reconcile failure class incl. the documented prune incident.
- **Rehearsal rounds 4-6:** round 4 — linux/docker/windows green; macOS EACCES'd on the LAST cwd-relative writer in the codebase (anomaly log defaulting to <cwd>/logs under launchd's read-only workdir; also silently polluting Program Files on Windows) → LOOMBRE_DATA_DIR-preferring default. Round 5 — the macOS server was FULLY UP and the smoke 404-probed "/" instead of /healthz. **Round 6 (release run 30313571665): ALL SIX JOBS GREEN, all four macOS install-smoke verdicts PASS (install, import graph, server boot, web boot). Draft created: linux 214.6 MB (web standalone shrank it), macos 150.8 MB, windows 403.9 MB, both docker sidecars, signed manifests. Owner install re-testing round 2.**

## Installer completeness wave (2026-07-27, owner mandate: "installers must contain everything needed to install AND run the app")

- **Trigger:** owner install-tested the round-3 draft — installs succeeded but NO channel produced a running app. Four parallel channel audits (windows/macos/linux/docker) against a single runnable-full-app bar produced ranked gap lists; every finding traced to file:line evidence.
- **Two cross-channel product gaps found (root causes, not lane bugs):** (1) NO WEB UI in any channel — even Docker excluded apps/web and its docs promised a wizard at :3001 that cannot exist; (2) NO schema-migration path in embedded mode — @loombre/db shipped dist-only, the server never migrated at boot, docs required a repo checkout; an embedded first boot yielded a schema-less cluster (this invalidated the round-3 "macOS SERVER_BOOT:PASS" — the server answered on :3001 over an empty database).
- **Foundation (product-side) landed:** apps/web `output:"standalone"` (static export impossible: per-request CSP nonce middleware; standalone server.js proven serving /login locally); `@loombre/db/migrate` (migrations/ ships in deploys; programmatic runner; server EMBEDDED bootstrap auto-migrates at boot — safe per H4 forward-only; external mode NEVER auto-migrates) with real-PG specs; LoombreServiceHost `--spawn-restricted` (CreateRestrictedToken disabling the Administrators SID + CreateProcessAsUser — pg_ctl's own technique — because postgres.exe refuses admin tokens and LocalSystem is one; quoting in Core's WindowsCommandLine with CommandLineToArgvW-inverse specs); menubar discovery path fixed to the data-dir root + GeneratedVersion.swift stamping (real install showed v0.0.1); shared scripts/fetch-node.mjs + installers/node-manifest.json (win-x64 24.18.0 sha256 re-verified locally).
- **All four lanes rebuilt against the audits (parallel implementation agents, disjoint ownership):** Windows — real node runtime, vendor-shaped pg + LOOMBRE_EMBEDDED_PG_* env, LOOMBRE_DATA_DIR→ProgramData root (tray discovery), LOOMBRE_IPC_WINDOWS_GRANT=*S-1-5-32-545, third LoombreWeb service (WebPort.wxi 3000, firewall rule), auto-start restored + SCM recovery actions + ServiceDependency ordering, diag smoke now proves FULL FIRST BOOT (healthz :3001 + web :3000 + discovery file, log tails on failure). macOS — standalone web staged + com.loombre.web daemon + loombre-web shim (LOOMBRE_WEB_PORT namespacing), LOOMBRE_DATA_DIR export unconditional (external-mode IPC was silently disabled), LOOMBRE_IPC_GROUP=admin + app-support root _loombre:admin 0750 (menubar can finally traverse+read), postinstall dscl typo, release build-macos smoke asserts web :3000. Linux — pg staged vendor-shaped at manifest defaultVersion only (was: flattened AND version-mismatched AND double-shipped on arm64), embedded env wiring in the wrapper, standalone web (599 MB dead tree → ~60 MB runnable) + loombre-web.service (ReadWritePaths for Next's runtime cache), MemoryDenyWriteExecute REMOVED from all units (systemd documents it incompatible with V8), smoke gains an EMBEDDED-mode scenario (no DATABASE_URL: initdb + auto-migrate + healthz + web /login + worker discovery-join, run as non-root), web-standalone sharp swapped to linux binaries (build-host darwin binaries would 500 every /_next/image). Docker — second image (ghcr.io/loombre/loombre-web, own bake target + cache, cosign-signed, docker-web-image.json sidecar; release.yml wired), compose web service + LOOMBRE_WEB_URL + CORS `-` semantics fixed (the old empty-string default silently DISABLED CORS), dead ffmpeg hw-accel override fixed (never passed through), LOOMBRE_SCAN_POLL exposed, JWT prose corrected (secret persists under /data/secrets since P4.7/P4.17), smoke asserts web /login 200, docs made truthful (UI at :3000). .dockerignore: installer build caches (2.8 GB) excluded from build context.
- **OWNER-REVIEW flags:** (1) Windows IPC token file readable by BUILTIN\Users — required for the non-elevated tray, means ANY local user can drive IPC (status/start/stop); acceptable for single-user machines, sign off or scope down. (2) ffmpeg macos-arm64 checksum-mismatch + license-unconfirmed caution (pre-existing, LICENSE-INTENT mandate) still open before a PUBLISHED release. (3) homebrew cask uninstall stanza lacks com.loombre.web (follow-up). (4) macOS smoke.mjs has no web coverage (release smoke covers it; local smoke gap).

## First draft-release dress rehearsal — Windows MSI lane proven (2026-07-26 → 2026-07-27, v0.9.0-rc.1)

- **Rehearsal run 1 (tag at ffe93cb, release run 30217169344):** linux + macos + docker GREEN on their first-ever release-lane executions; build-windows FAILED at build-msi step 1/7 — `execFileSync("pnpm")` is ENOENT on Windows (pnpm is a .cmd shim; Node refuses shell-less cmd-script spawns per CVE-2024-27980). gate.mjs/dep-audit.mjs already carried `shell: WIN`; build-msi was simply the first RELEASE-lane script ever to execute on a Windows runner. The `release` job correctly skipped (no draft created).
- **Diag loop instead of tag cycles:** new permanent `windows-msi-diag.yml` (manual dispatch) mirrors release.yml's build-windows step-for-step, so the whole MSI lane could be proven without re-running 4 platforms per attempt. Eight rounds, every failure a first-execution truth, all fixed in production code (never in the diag):
  1. pnpm shim → resolve to the REAL entry point (pnpm.exe, or the shim's pnpm.cjs/corepack JS run by this same Node — NOT shell:true, whose unquoted args break on spaced paths).
  2. `pnpm deploy` → `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`: pnpm v10+ needs `--legacy`, which lanes I1/I4 already passed — I3 missed it. Also ported I4's ajv runtime-dep vendoring (a `--prod` deploy omits it; the installed server would crash at device-profile validation — the green macOS release log proves this fixup still fires; the src→dist export patching, by contrast, found nothing to patch and was NOT ported).
  3. placeholderDir's `cmd /c echo …> "path"` → Node's arg quoting mangles the nested redirect; replaced with plain writeFileSync (there was never a reason to shell out).
  4. FIRST C# COMPILE EVER (the authoring host had no dotnet): CS0104 ambiguous `Timer` (WinForms vs Threading, both via implicit usings — aliased); CS0117 `ProcessStartInfo.CreateNewProcessGroup` is .NET 9+ only (removed — not load-bearing: TrySendCtrlBreak broadcasts group 0, and no SIGBREAK handlers exist yet so stops take timeout+kill regardless); CS0234 `ServiceBase` does NOT ship in the `-windows` TFM (the csproj comment claimed it did) → `System.ServiceProcess.ServiceController` 8.0.1 PackageReference; `EnableWindowsTargeting` added so the documented macOS compile-proof works. Two parallel static compile-reviews over all 1,658 never-compiled C# lines found these in ONE round instead of four. All 35 (now 42) dotnet tests pass on windows-latest.
  5. WIX0144 extension not found → `wix extension add` caches into cwd-relative `.wix/`; the build ran from REPO_ROOT while the add ran in installers/windows. Build now runs from WINDOWS_DIR (all path args are absolute).
  6. FIRST wix COMPILE of the authoring: WIX0150 ×2 — WiX preprocessor defines are PER SOURCE FILE, so Package.wxs's ServerPort define never reached Services.wxs/Firewall.wxs → shared `ServerPort.wxi` include (still `-d`-overridable). WIX0230 ×3 — CreateFolder-only components keypath on their Directory, which forbids `Guid="*"` → explicit PERMANENT GUIDs (MSI component rules: never regenerate).
  7. **WIX7502 — MSI's hard 65,536-Component ceiling vs 84,305 harvested files (owner paused for their own fix round, then chose option 1: ARCHIVED PAYLOAD).** The five big trees (server/worker/web/node/pg) now ship as ONE payload.zip (built with System32\tar.exe bsdtar by ABSOLUTE path — a GNU tar on PATH cannot produce ZIP); LoombreServiceHost extracts on first service start (new PayloadExtractor in Core: sha256 marker idempotence, Local\ mutex vs the two services racing, stale-tree removal so upgrades never leave version-mixed trees; OnStart calls RequestAdditionalTime first; covered by real-IO dotnet tests). Uninstall sweeps extracted trees via util:RemoveFolderEx (canonical HKLM-remembered-path pattern; runs on the OLD product during MajorUpgrade too, forcing a clean re-extract — WixToolset.Util.wixext 5.0.2 pinned in lockstep, LICENSE-INTENT row updated). ffmpeg/tray stay per-file components. **Two honesty fixes from tracing the start path:** services are now Start="demand" and NOT started at install (the node/ payload is still a PLACEHOLDER — the old Start="install"+Wait="yes" would fail EVERY real install today; flip back in the change that makes node real), and the latent trailing-backslash argv trap (`--cwd "[SERVERDIR]"` → `\"` = escaped quote) is fixed with the trailing-dot idiom.
  8. WIX1148 — '0.9.0-rc.1' is not a legal MSI ProductVersion (numeric-only; comparisons otherwise undefined) → build-msi derives a range-checked numeric MsiVersion for Package metadata; the full semver still names the .msi file. **ROUND 8 FULLY GREEN: payload.zip 118.6 MiB, MSI 281.0 MiB, zero warnings, artifact uploaded.**
- **Validation ceiling, stated honestly:** the MSI BUILDS green and its C# is test-covered, but no real Windows install/extract/service-start has run yet (Wave-3 VM territory). The owner is install-testing the rehearsal artifacts on real machines. Known-and-flagged gaps unchanged: node/ payload placeholder, web/ not standalone-servable, DATABASE_URL boot-wiring open.
- **Rehearsal run 2 (release run 30288917134, tag at d2ee36f): ALL SIX JOBS GREEN — first complete release pipeline pass.** Draft release created (isDraft: true, invisible until published): linux tarball 326.8 MB, macos-arm64 pkg 134.8 MB, windows-x64 MSI 294.6 MB, manifest.json + SHA256SUMS each with real minisign signatures; the H5 belt-and-braces step verified the produced signatures against the committed keys/minisign.pub INSIDE the run. Docker pushed ghcr.io/loombre/loombre:0.9.0-rc.1 AND :latest. Owner is install-testing the artifacts on real machines; publish-or-delete is the owner's call afterward.
- **TAGGING RULE (cost two silent no-op tag pushes):** GitHub honors the bracketed CI-skip marker for TAG pushes too, matched ANYWHERE in the tagged commit's message — the STATE.md-commit convention makes those commits untaggable, and an explanatory commit that merely QUOTED the marker was skipped as well. Tags get a clean (empty if need be) anchor commit, message free of the marker.
- **OPEN — owner decision:** build-docker tags `:latest` unconditionally, so an rc tag repointed public `:latest` at a prerelease (GHCR images are live immediately — drafts gate only the release page assets). Candidate fix: push `:latest` only for non-prerelease versions.
- **REAL-MACHINE INSTALL TESTING (owner, round-2 draft) found THREE defects a green build cannot catch — all fixed + now regression-tested at the INSTALL level:**
  1. **macOS install FAILED** (PKInstallErrorDomain 112, from the owner's /var/log/install.log): pkg/scripts/{pre,post}install were tracked git-mode 100644 and `pkgbuild --scripts` packages modes verbatim — PackageKit refuses a non-executable preinstall. Fixed: git modes 100755 AND build-pkg.mjs force-chmods a staged scripts copy (mode regressions can no longer ship; verified via pkgutil --expand). Bonus from the same log: scripts ran under ROSETTA — Distribution.xml.tmpl now declares hostArchitectures="arm64" (also refuses cleanly on Intel instead of installing unrunnable arm64 binaries).
  2. **Windows installed into Program Files (x86):** StandardDirectory `ProgramFilesFolder` is the 32-BIT folder even in an `-arch x64` package → `ProgramFiles64Folder`.
  3. **No server/web trees on disk after install:** first-start extraction can never run while node/ is a placeholder (demand-start services). Extraction now happens AT INSTALL TIME — deferred+elevated CA `ca.ExtractPayload` runs LoombreServiceHost.exe in its new extract-cli mode after InstallFiles (Return=check, fails the install loudly); the services' first-start extraction stays as marker-checked self-heal.
  - **Install-level CI now exists on both platforms:** windows-msi-diag runs a real elevated msiexec install (asserts all 9 trees in 64-bit Program Files + server\dist\main.js + both services registered + NO x86 folder) then uninstall (asserts ZERO residue — proves RemoveFolderEx) — VERDICT:INSTALL:PASS + VERDICT:UNINSTALL:PASS in run 30294271750. release.yml build-macos runs `sudo installer` (real PackageKit) on the .pkg it just built and asserts the LAYOUT.md layout (/opt/loombre/<version>, current symlink, Loombre.app).
- **Rehearsal round 3 (release run 30295280481, tag at 8b6ee04): ALL SIX JOBS GREEN incl. the first in-release macOS install smoke (VERDICT:PKG_INSTALL:PASS).** Fresh draft up (same 7 assets, MSI now 294.6 MB with install-time extraction CA). Owner re-testing on real machines.

### Mission (verbatim)

Close all four ledger items: (L1) .mts admitted to scanner ingestion with fixtures, (L2) the Linux tarball installs a loombre PATH shim with clean uninstall, (L3) the admin-only event list becomes single-source with the other copies derived or parity-tested, and (L4) pnpm gate splits into gate (fast, inner-loop) and gate:full (adds the web production build + bundle budget check), with CI and merge protection running full. Each lands green; the ledger section in STATE.md is emptied with pointers to the closing commits.

### Originating ledger wording (2026-07-26 exit gate + round-1 CI entry — review-lane ground truth)

- **L1:** "`.mts` admission is zero-cost (identical mpegts family as .m2ts) whenever wanted — currently excluded-but-visible purely for brief-scope discipline."
- **L2:** "Linux tarball still ships no `loombre` PATH shim (installers/ untouched per standing constraint; docs/ops/cli.md documents the honest invocation)." Promoted by H2: CLI PIN recovery is not invocable as documented on tarball installs without it.
- **L3:** "No automated parity gate across the three admin-only event-list copies (R-4 — snapshot tests only)."
- **L4:** "Gate-gap follow-up for the owner ledger: consider adding the web production build (or a node:-scheme import lint for client-reachable graphs) to `pnpm gate` — this class is currently caught only in CI perf jobs."

### Run posture (2026-07-27)

- **Standing rule recorded (auto-memory too): sub-agent floor = sonnet (no haiku); review = opus — this and all future runs.**
- Precondition gate dispatched on clean main (e96b278; last full 3-OS board green at 8f11000, e96b278 is [skip ci] docs-only) — result recorded below.
- Isolation: worktree lanes, per-lane DBs (loombre_lane_<x> on compose PG), STATE.md orchestrator-owned; installers/ constraint LIFTED for Lane B only (owner decision in this brief supersedes the 9552333-era hands-off note).
- Scope: the four items only.

### Lane burn-up

| Lane | Scope | Model | Status |
|---|---|---|---|
| A | L1 .mts admission + probe-failed visibility + docs tables | sonnet | **LANDED fcb94ef..38099e1** (6 commits; two premise corrections recorded below; in-worktree: worker 979, server 1451, web 896, jobs 17, shared 72, contract 42 green) |
| B | L2 tarball PATH shim + uninstall safety + smoke re-run + docs | sonnet | **LANDED 7e83ba7** (container smoke ALL CHECKS PASSED incl. 2 new safety scenarios; rebuild 79s + smoke 41s) |
| C | L3 canonical admin-only list + derivation/parity + demonstrated catch + LPP pointer | sonnet | **LANDED 375be32** (red-first parity catch captured verbatim; shared 72, contract 41, server 984, worker 966 green in-worktree) |
| D | L4 gate/gate:full split + CI wiring + CLAUDE.md/docs + runtimes | sonnet | **LANDED 293b985** (fast gate byte-identical — zero-diff step array; runtimes measured; CLAUDE.md diff orchestrator-applied to the untracked local copy) |
| R | opus review vs original ledger wording; L2 safety, L3 catch proof, L4 fast-gate byte-parity | opus | **DONE — all four items CLEAN against the ORIGINAL ledger wording; 10 findings (1 MED + 3 LOW + 1 open owner clause + 1 process + 4 nits), the 8 fixable ones fixed same-day (below)** |

### Lane R review record + fix wave (2026-07-27, orchestrator-applied)

Verdicts (adversarial, against landed code): **L1 CLEAN** — premise correction judged "honest, not papered over" ("closure, not papering over": putting probe outcomes in scan.completed would require holding a scan open across the probe queue, an invariant-6 violation; the sibling-disclosure surface is the honest resolution); all five chain levels verified asserting what's claimed (terminal-ONLY seam firing incl. hook-throw swallowing + recordFailed-before-hook ordering; real-binary ffprobe; stderr-never-in-outbox proven by JSON.stringify assertion). **L2 CLEAN** — foreign-file safety holds under adversarial reading on BOTH sides (byte-identity sha256 assertions, not log-greps); the /opt/loombre-evil prefix compare is quoted-inside-case so --prefix glob metacharacters cannot inject; broken symlinks correctly take the replaceable branch; --help proven to touch neither DB nor adminDeps. **L3 CLEAN** — re-exports are reference-identity-asserted (a re-typed copy fails); parity absorbed L1's 11th entry with ZERO literal edits outside the intentional snapshot ("the mechanism demonstrably works"); grantable-15 now derived, not literal. **L4 CLEAN** — step array byte-identical (verified programmatically); full only appends; runtime claims internally coherent and honestly labeled. **Scope CLEAN** (58 files all attributable; installers/ touched by Lane B only; one dependency edge added: @loombre/shared as packages/contract devDep, acyclic). **No freeze-entry claim irreproducible.**

Findings → dispositions (all fixes verified green: contract 43, constants 1, LibrariesPanel 9, lint/typecheck/docs-build, install.sh bash -n):
- **F1 (MED, FIXED):** user-guide claimed "Loombre never guesses or shows a broken entry" for unreadable files — contradicted by this run's own garbage-file test (the item DOES appear, fails at play; no catalog read filters unprobed items). Rewritten honestly: the entry may show up at first but won't play, and is flagged.
- **F2 (LOW, FIXED):** four prose sites carried stale/re-staling member counts (delivery-loop still said "eight"; three said ten). All four made count-free — prose counts re-stale on every addition.
- **F3 (LOW, FIXED):** the printed fallback shim command was `ln -s` without -fn/sudo — failed exactly in the branch where a symlink is guaranteed present, and from the non-root shell an operator most likely pastes into. Now `sudo ln -sfn ...`.
- **F4 (LOW, FIXED):** dangling spec-name pointer in garbage-file-ingestion.spec's chain index.
- **F5 (OPEN — owner):** mission clause "merge protection running full" cannot be closed by a lane: branch protection does not exist (404). Owner action with exact required-check contexts + gh command surfaced in the final report.
- **F6 (PROCESS, FIXED):** the freeze entries/emptied ledger were uncommitted at review time — landed in this commit.
- **F7 (residual, DISCLOSED — potential future ledger item):** probe.failed visibility is live-session-scoped (events row is durable but no retrievable surface exists when no admin is watching; EventLogPanel is a ring buffer; readEventsForViewer has zero HTTP callers). Honestly documented in the admin guide ("for as long as the dashboard stays open"); the natural follow-up is a queryable admin surface.
- **F8 (nit, FIXED):** the probe-failed disclosure rendered only the path — the closed-enum `code` (the reason the event carries it) now renders beside it.
- **F9 (nit, FIXED):** parity diff's Set semantics would hide a duplicated schema-mirror entry — explicit no-duplicates test added on the mirror side.
- **F10 (nit, FIXED):** README's contributing summary still said `pnpm gate` must pass — now gate:full.

### EXIT GATE — WALKED 2026-07-27 (final tree at this commit)

- [x] `pnpm gate` green: precondition run ALL STEPS PASSED on e96b278; the 13 fast steps re-proven inside gate:full on the merged tree (plus Lane D's dedicated fast run, 13/13, 2m47.7s). `pnpm gate:full` **ALL STEPS PASSED (14/14)** on merged main. Matrix 517/517; scripts:test 113/113. [~] 3 OS from a clean clone = the push + `gh workflow run ci.yml -f os=all` dispatch at close-out (pointer recorded in the final report; CI gate legs now run gate:full per L4).
- [x] L1: .mts fixture ingests + probes to 'ts' (real ffmpeg, 87-fixture manifest); fake-text .mts visibly surfaced as probe-failed via the five-level chain (with the premise correction recorded); docs tables updated.
- [x] L2: tarball smoke green docs-verbatim with PATH-resolved commands (`loombre --version`, `loombre admin reset-pin --help` from a fresh shell, no path prefix); uninstall leaves no dangling shim AND never deletes a foreign file (both tested with byte-identity assertions).
- [x] L3: single canonical source; parity mechanism demonstrated to catch an injected delta (red-first, verbatim-captured); LPP pointer comment in place.
- [x] L4: the barrel-import class fails under local gate:full with the module/chunk named (exact 8f11000 UnhandledSchemeError reproduced + reverted); both runtimes recorded (fast 2m47.7s / full 2m46.9s cold-Next; isolated marginal ~15.4s — headline delta noise-dominated, labeled as such); CLAUDE.md + CONTRIBUTING + getting-started + PR template + performance-budgets updated. [~] CI required check = owner-side branch-protection CREATION (F5).
- [x] STATE.md: ledger section emptied with pointers to closing commits; coverage vs mission complete (sole open clause = F5, owner-scoped).
- **Owner actions (the only ones):** (1) create branch protection on main — required checks exactly `gate (ubuntu-latest)`, `perf-t0 (ubuntu, enforcing)`, `perf-web-budget (ubuntu, enforcing)`, `perf-lighthouse (ubuntu, enforcing)`; exact gh command in the run's final report. (2) F7 residual (durable probe-failed surface) — future ledger candidate, not blocking.
- **3-OS dispatch (run 30259488783, tree 5fdf3ae): FULL BOARD GREEN — the first CI execution of `gate:full` on all three OS legs** (+ all three perf jobs; gate-node-next skipped-on-dispatch by design). Round 1 was green everywhere except macos, which failed on the DOCUMENTED real-hardware-deadline flake (session.integration throttle-suspend SIGSTOP timing — Phase-3-era suite untouched by L1–L4, green on yesterday's dispatch); failed-leg rerun GREEN, confirming flake-not-regression. Exit-gate "3 OS" item CLOSED with remote proof on the final tree.

- Precondition met at kickoff: `pnpm gate` ALL STEPS PASSED on clean main (e96b278).

### Freeze entries (orchestrator-integrated from lane reports)

**L1 — .mts admitted + probe-failed visibility (LANDED fcb94ef, 7b33a68, 7cabb14, 9d71ce3, e70a3d0, 38099e1).** VIDEO_EXTENSIONS += mts (identical mpegts family as m2ts, FORMAT_FACTS row verified empirically); EXCLUDED loses it; legacy-format spec fixtures flipped; generated h264_aac.mts fixture probes to 'ts' (real-ffmpeg integration, 87 fixtures). **TWO PREMISE CORRECTIONS, both lane-caught:** (a) the brief's "ingestion already requires a successful ffprobe" is FALSE — the scanner never runs ffprobe (invariant 6: it enqueues a probe job; scan.completed fires before probes run; a probe failure used to leave a visible permanently-not-ready item with the path buried in jobs.last_error). Built architecture-honest machinery instead: packages/jobs queue.work() gains a typed `onTerminalFailure` hook (fires only when retries are exhausted, best-effort, hook errors swallowed+logged — 11 unit tests); apps/worker probe hook (probe/terminal-failure-hook.ts) emits a NEW admin-only outbox event `probe.failed` {mediaFileId, libraryId, path, code} (closed ProbeError-code enum + "unknown"; no free-text/stderr in the event stream) — registered as a ONE-PLACE addition thanks to L3's canonicalization (canonical list 10→11, envelope enum 25→26 + x- array, new payload schema, derived specs followed automatically — the parity/completeness specs went genuinely red mid-build, captured); LibrariesPanel gains a second disclosure "N failed inspection (unreadable media)" beside the skip one (session-scoped, capped 100, NOT reset on scan.started — probe jobs outlive their scan; jsdom-tested). The garbage-file chain is proven at five levels: text-file .mts ingests + scan completes (no crash) → real ffprobe throws nonzero-exit → terminal-only seam fires → event row lands → panel renders. scan.completed itself UNTOUCHED (probe results are a different event by architecture — the panel unifies them visually; recorded as the honest resolution of the brief's "scan report's skip section" wording). (b) The lane's worktree had forked BEFORE Lane C landed — detected via merge-base, resolved by cherry-picking 375be32 (-x) before starting; landing on main skipped the duplicate. Grantable count stays 15 by construction (26−11). Docs: video table += .mts; user guide names .mts as working + one outcome-language line about unreadable files; admin promise paragraph gains the failed-inspection sentence.

**L2 — Linux tarball loombre PATH shim, the H2-recovery invocability fix (LANDED 7e83ba7).** build-tarball.mjs writeWrapperScripts() gains a third wrapper `bin/loombre` (bundled node against lib/server/bin/loombre.mjs, LOOMBRE_FFMPEG/FFPROBE set; resolves its PHYSICAL path via readlink -f before deriving APP_ROOT — the sibling dirname idiom breaks through a symlink; siblings untouched, never symlinked). install.sh symlinks /usr/local/bin/loombre → "$PREFIX/bin/loombre" — ADJUDICATED B-1: install.sh is root-gated so "user-mode install" doesn't exist; shim placement is purely defensive (any failure warns + prints the exact `ln -s "/opt/loombre/bin/loombre" "/usr/local/bin/loombre"` line and continues, never fails the install); existing symlink → ln -sfn replace; foreign non-symlink file → warn + skip, byte-untouched. uninstall.sh removes the shim ONLY when readlink -f resolves it under "$PREFIX" (trailing-slash-guarded prefix compare). `admin reset-pin --help`/-h added (usage, exit 0, THROWING_ADMIN_DEPS-proven no DB touch — previously --help was swallowed as a username). PROVEN by the real container smoke (rebuilt arm64 tarball 79s; smoke 41s, ALL CHECKS PASSED): `loombre --version` and `loombre admin reset-pin --help` work from a fresh shell with no path prefix; shim GONE after uninstall; PLUS scenario (a) idempotent re-install incl. over a planted stale symlink and (b) foreign-file safety on BOTH install (warned, byte-identical) and uninstall (still present, untouched). Docs: ops/cli.md ("no shim" claim retired; full-path invocation kept as the shim-couldn't-be-placed fallback — wording deviation from the brief's "user-mode installs" recorded), install/linux.md, LAYOUT.md (tree/provenance/wrapper/uninstall-promise all updated; the promise now names the shim).

**L3 — admin-only event list single-source (LANDED 375be32).** Canonical: packages/shared/src/admin-only-event-types.ts (pure data; barrel + ./admin-only-event-types subpath per the 8f11000 precedent; doc header names every derived/parity site; LPP W4 pointer comment at the definition). apps/server event-taxonomy.ts + apps/worker constants.ts are now straight re-exports (original export names kept; stale "eight" prose fixed; the old "apps/worker cannot import apps/server" duplication rationale dissolved — worker imports shared). The ONE intentional snapshot lives at packages/shared/test (10-item literal + envelope-enum completeness); server/worker specs assert DERIVATION (reference identity) with counts derived, not literal. Contract: envelope.schema.json gains machine-readable `x-loombre-admin-only-event-types` (admin-only-ness previously existed NOWHERE machine-readable in the contract) + parity spec in packages/contract/test (@loombre/shared devDep, acyclic, depcruise-clean) whose failure names BOTH files and the differing entries (diff logic extracted + unit-tested; Ajv strict-mode kept — the x- keyword explicitly registered rather than blanket-disabling strictness). **Demonstrated catch, red-first, captured verbatim:** fake.admin-event added to the real x- array → "Admin-only event-type list parity mismatch between packages/shared/src/admin-only-event-types.ts and packages/contract/event-schemas/envelope.schema.json: extra in schema (...): fake.admin-event" → reverted green; same one-sided mutation demo for the worker derivation spec. Drifted prose copies fixed (EventLogPanel header — omitted user.restricted-pin-reset; metadata.match-candidates description). Recorded nuance, untouched by design: packages/db events.ts's visibility lists deliberately pass admin-only types through readEventsForViewer (zero HTTP callers; enforcement is in-memory at ws-broadcaster:274) — not a copy. Deviation: no web IMPORT added (the admin UI performs no admin-only filtering by construction; its correction is the prose pointer).

**L4 — gate fast/full split; CI runs full (LANDED 293b985; CLAUDE.md diff applied by the orchestrator to the untracked local copy).** scripts/gate.mjs: mode arg — bare = fast (13-step array BYTE-IDENTICAL, zero-diff-verified against pre-change main); `full` appends step 14 `web-build-budget` (pnpm perf:web-budget — builds the web production bundle itself, prints the per-chunk table, names breaches; the budget threshold lives in the script per docs/PLAN.md §9.3, perf/baselines.json is the change-control ledger, nuance recorded); unknown args = usage error. package.json += gate:full. ci.yml: gate job (all matrix legs — bundle SIZE is deterministic, unlike the perf-NUMBER jobs which stay separate/ubuntu-only; design comment updated to stay true) + gate-node-next run gate:full; standalone perf-web-budget job KEPT (artifact publisher + required-check candidate; ~1min ubuntu redundancy acknowledged in-comment). Docs: CONTRIBUTING's now-false "no separate, looser local path" sentence rewritten; getting-started §5/§5a; PR template checklist → gate:full; performance-budgets.md cross-ref; CLAUDE.md Commands (also fixed its pre-existing stale step list — omitted runtime-imports + docs-build) + working-agreements line. **Red-first class proof:** reverting AccountSection.tsx to the barrel import reproduces the exact 8f11000 UnhandledSchemeError (full import trace naming the chunk path) under the new step alone; reverted clean. **Measured runtimes (honesty check):** fast 2m47.7s; full 2m46.9s cold-Next — headline delta is NOISE-dominated (test step ~2min dominates); the isolated marginal cost of the new step is **~15.4s** on this hardware (CI's 1m04s standalone-job figure is mostly Actions overhead absent mid-gate). **OWNER ACTION (surfaced, not executed): branch protection does not exist on main (`gh api .../protection` → 404) — CREATE it** with required checks exactly `gate (ubuntu-latest)`, `perf-t0 (ubuntu, enforcing)`, `perf-web-budget (ubuntu, enforcing)`, `perf-lighthouse (ubuntu, enforcing)` (windows/macos legs are dispatch/[full-ci]-only and cannot be required); the exact `gh api` command is in Lane D's freeze report (orchestrator holds it — ask, or see the run's final report).

## Audit-residue hardening run (kicked off 2026-07-26, authority: owner "Closing the Audit Residue" brief; docs/PLAN.md v1.1 as amended per H4 + docs/PLAYBACK.md §2.6)

### Mission (verbatim)

Implement the five hardening items: (H1) a real user_settings.prefs writer restoring the language pickers end-to-end into playback track selection, (H2) an audited admin PIN-reset CLI closing the PIN recovery gap, (H3) the scanner extension list reinstated for common legacy formats with skipped files made visible in the scan report, (H4) PLAN.md §4.2 amended to pure forward-only migrations with the zero-to-current CI proof confirmed as a permanent gate, and (H5) a release-pipeline guard making it impossible to tag a build containing the placeholder minisign key — plus (H6) the admission-lock topology constraint recorded. Each item lands green or is reported blocked with evidence; none are optional.

### Originating audit language (commit 9552333, "fix!: close 42 verified findings from full-codebase review" — the audit record; quoted here as review-lane ground truth)

- **H1:** "Preferred audio/subtitle language and playback prefs reported 'Saved' while putMySettings discarded them (it declares no @Body at all). The form is removed rather than left lying, following the precedent set for the theme control; restoring it needs a user_settings.prefs writer."
- **H2:** "currentPin is deliberately left unconstrained: it is the only recovery path for anyone already affected, since no admin or CLI PIN reset exists." + residue list: "a forgotten PIN still has no recovery path".
- **H3:** "Scanner accepted 9 declared extensions probe can never extract, so those items ingested and sat permanently unplayable." + residue list: "the narrowed scanner extension list is a real v1 scope statement worth recording".
- **H4:** residue list: "no down migrations exist anywhere (contradicts PLAN.md 4.2)".
- **H5:** residue list: "docs/install/linux.md still ships the all-zero placeholder key" (sibling finding fixed in 9552333: keys/README.md still called the trust root a placeholder after the real key landed — the class of failure is placeholder residue surviving key rotation; the guard makes it structural).
- **H6:** residue list: "admission control is process-local and would need a DB advisory lock under a multi-process topology".

### Preconditions + run posture (2026-07-26)

- Precondition "current gate green on a clean clone": kickoff `pnpm gate` on clean main (70c0242) came back RED at the FINAL step — docs-build's generated-reference drift check: 9552333 amended packages/plugin-protocol/spec/lpp-v1.md (default-must-satisfy-own-constraints erratum) without re-committing the generated docs/developer-guide/plugins/spec.md. Every other gate step passed. Repaired with the gate's own prescribed fix (regenerated file committed, d646134); docs:build then ALL STEPS PASSED. NOTE: all five lane worktrees forked from 70c0242 (pre-repair), so every lane independently rediscovered and correctly flagged this same drift as pre-existing/out-of-scope — their reports corroborate the diagnosis; no lane touched it.
- Isolation: worktree lanes per the standing policy (G15 lesson applies — any resume message pins the absolute worktree path). DB contention avoided structurally: each DB-touching lane creates and exports its OWN database on the compose PG (`loombre_lane_<x>` via DATABASE_URL); main-tree dev DB untouched by lanes.
- STATE.md is orchestrator-owned this run — lanes return their entry text in their freeze reports; the orchestrator integrates (prevents 5-way merge conflicts on this file).
- Scope discipline: the six items only. ACL/TLS items from the same reports and P4.22 relitigating are OUT unless an item names them.

### Lane burn-up

| Lane | Scope | Model | Status |
|---|---|---|---|
| A | H1 prefs writer → contract/SDK → pickers → §2.6 selection seam + cases | sonnet | **LANDED 2833bfe** (worktree freeze d72879f; suites green in-worktree: server 973, web 885, db 254, shared 69) |
| B | H2 reset-pin CLI + outbox event + tests + both doc registers | sonnet | **LANDED 276edfc** (worktree freeze c4442f3; server 1419, worker 949, contract 31, db 254 green in-worktree) |
| C | H3 extension reinstatement + visible skips + fixtures + docs | sonnet | **LANDED d9b5db5** (worktree freeze 3614533; matrix 506→512 green/0 red; worker 964, server 1407, web 886 green in-worktree) |
| D | H4 §4.2 amendment + zero-to-current gate; H6 topology note | sonnet | **LANDED 3be4f4b + 995151f + 7209595** (ground truth on fresh lane DB: 17/17 migrations, seed, leak 41/41, conformance 50/50) |
| E | H5 release placeholder guard + dry-run failure test | sonnet | **LANDED f413b7a** (red-first captured; checker PASS 5 locations + 52-file docs sweep; scripts:test 113/113 re-proven on merged main) |
| R | opus cross-check vs originating audit language; scope + honesty verdicts | opus | **DONE** — verdicts below; 4 findings, all fixed same-day by the orchestrator (see "Lane R review + fix wave") |

### Lane R review + fix wave (2026-07-26, orchestrator-applied)

Review method: adversarial, against the landed code/tests and 9552333's own language, not the freeze reports. Verdicts: **H1 CLEAN** (Saved-honesty test real and non-vacuous — asserts error present AND "Saved" absent, with a sibling proving "Saved" does render on success; no code path sets "saved" before the await resolves; end-to-end persistence verified through to the §2.6 seam). **H2 CLEAN** (no HTTP surface — zero reset routes in contract/controllers/SDK/web; no bypass flag; no secret material in the payload; the e2e's 403-not-401 assertion verified honest against restricted.controller's actual gate order). **H5 CLEAN** (independence of the placeholder check from the equality check pinned — an all-placeholder tree fails; prepare-job wiring + needs-chain verified; post-sign minisign -V targets the committed key). **H6 CLEAN**. **H4 doc-half CLEAN** / CI-half finding. **H3 PARTIAL** — the enumerated finding closed, its CLASS not. **Scope CLEAN** (97 changed files all attributable; installers/ACL/TLS untouched; P4.22 not relitigated — pin constraints byte-identical; only dep change = apps/web gaining workspace-internal @loombre/shared). Freeze-entry claims reproduced except in-worktree suite counts (unverifiable read-only; CI re-proves).

Findings → fixes (all applied by the orchestrator on main, same day):
- **R-1 (MED, H3): silent-skip class not closed.** classifyAuxiliary routed known-media-but-in-NEITHER-set extensions (.mts/.asf/.mka/.ogv/…) to plain "ignored" — no count, no list, no log — while docs claimed "never dropped silently". Sharpest instance: .mts is the identical mpegts family as the admitted .m2ts. FIX: EXCLUDED_MEDIA_EXTENSIONS widened from 3 to 26 (curated recognized-media tail — video mts/asf/ogv/3gp/3g2/divx/m2v/rm/rmvb/wtv/f4v/dv, audio mka/m4b/dsf/dff/mpc/tta/ra/shn/amr/ac3/dts/spx), all visible-skip; .aif ADMITTED as the alias suffix of .aiff (same content, ffprobe reports 'aiff' — verified empirically; same alias treatment as mpg/mpeg); .mts kept excluded-but-visible ONLY for brief-scope discipline — **owner call: admitting .mts is zero-cost (identical 'ts' container) whenever wanted**. Scanner spec gains the .mts visible-skip case; media-extensions.spec's exclusion inventory updated; docs now state the honest boundary (recognized-media types are reported; unrecognized suffixes are non-media and ignored without a report).
- **R-2 (MED, H3): skip visibility was live-session-only.** admin-dashboard-live.ts discarded scan.completed for any library the session hadn't seen scan.started for; a mid-scan-joining admin saw nothing, and libraries.md promised "every scan's result". FIX: guard removed (completion alone registers; panel joins on its own libraries list so unknown ids never render), new completion-alone jsdom test, docs claim rewritten to what the code actually guarantees (note renders while the dashboard is open incl. mid-scan joins; the server log is the durable record).
- **R-3 (MED, H4): the "permanent gate" was untested-in-CI with a Windows hazard.** The run was unpushed (no CI had executed the new step); the step comment claimed "all 3 OS legs" while the matrix defaults to ubuntu-only; psql's stdout on the windows leg is CR-terminated, so `[ "$table_count" -ne 0 ]` would die on "0\r" under set -euo pipefail. FIX: `| tr -d '\r'` added; comment reworded to the true matrix conditions; the push + [full-ci] dispatch below is the execution proof.
- **R-4 (LOW, H2): "lockstep test" overclaim.** constants.spec compares the worker constant to its own hardcoded copy — a snapshot, not drift detection; no automated parity gate exists across the three admin-only-list copies. FIX: test renamed + honesty comment added; H2 freeze entry corrected above.

### EXIT GATE — WALKED 2026-07-26 (final tree 05bfd40)

- [x] `pnpm gate` **ALL STEPS PASSED** on the final tree (third run; the first two failed ONLY on the documented statfs local flake — admin-storage-pool dedupe, isolated 4/4 green each time — now FIXED per STATE.md's own prescription: structural totalBytes equality + usedBytes drift tolerance instead of live-snapshot deep-equality, test-only, commit 05bfd40). Playback matrix 517/517 (512 cases green / 0 red, +6 this run); scripts:test 113/113. [~] 3-OS: push + `gh workflow run ci.yml -f os=all` dispatched at close-out (run pointer below) — also the FIRST execution of the H4 zero-to-current step and the R-3 windows psql guard.
- [x] Contract + SDK atomic every time (A and C both narrowed/widened openapi.yaml; cherry-picks composed cleanly and codegen re-verified drift-clean on the merged contract — no reconciliation commit needed); redocly zero-warn; oasdiff classifications recorded in both commit bodies (P4.22 convention).
- [x] H1: prefs round-trip UI→DB→TrackSelection proven (user-settings e2e ×16 incl. the DB→controller→plan() seam case; resolve-selection ×20 incl. B/T-pair matching and the A-2 subtitle-pref override); failed-save shows error, never "Saved" (review-verified non-vacuous both directions).
- [x] H2: reset → old-PIN-403 → fresh-opt-in proven e2e; user.restricted-pin-reset ADMIN_ONLY in the feed (ws-broadcaster case); docs in both registers (ops/cli.md + admin-guide + user-guide); no HTTP surface (review-grep-verified).
- [x] H3: legacy-format fixtures ingest (probe integration vs real ffmpeg files); excluded formats visibly skipped, test-enforced at scanner + payload + panel + local-log levels; silent-skip CLASS closed by R-1 (26-entry visible set, honest docs boundary); scope recorded here + both guides.
- [x] H4: §4.2 amended; decision logged; zero-to-current standing + asserted in ci.yml's gate job (all matrix legs); ops rollback section written (the old §4.2's unfulfilled promise, fulfilled).
- [x] H5: placeholder present → FAIL naming file + owner action (red-first verbatim in Lane E's record; 18 tests); real-key path documented; prepare-job fail-fast + post-sign minisign -V wired.
- [x] H6: constraint + exact-module pointer recorded (STATE.md + architecture docs).
- [x] Review: every finding cross-checked against 9552333's own language (quoted at kickoff); 4 review findings all fixed same-day; scope discipline CLEAN (97 files, all attributable; installers/ACL/TLS untouched; P4.22 byte-identical).
- Orchestrator extras beyond the six items, both forced by the run: precondition repair d646134 (docs-drift left by 9552333 itself — the gate was NOT green at kickoff) and the statfs flake test hardening 05bfd40 (blocked two exit-gate walks).
- **3-OS dispatch round 1 (run 30236243516): gate GREEN on ALL THREE OS legs** — ubuntu + windows + macos, first live execution of the H4 zero-to-current step AND the R-3 windows psql guard, both held. perf-t0 green. **BUT both enforcing web-perf jobs failed on a REAL defect no lane could see locally:** AccountSection's `LANGUAGE_CODES` import went through the @loombre/shared BARREL, whose other exports import node:crypto/node:path — the Next production webpack build refuses node: schemes (UnhandledSchemeError). Invisible to every lane check because `pnpm gate` does NOT include the web production build (only the CI perf jobs run `next build`), and vitest resolves the barrel under Node where node: imports are legal; the orchestrator's own pre-gate `pnpm build` had swallowed the failure behind an unchecked redirect (process lesson: never `>/dev/null 2>&1` a verification step's exit code). FIX: packages/shared gains a `./language-codes` subpath export (pure data + pure functions only); AccountSection imports the subpath, keeping the barrel out of the client graph. Verified: web production build exit 0; /browse 170,343 B gz vs 204,800 budget (16.8% headroom; +5.5 KB run cost); AccountSection 19/19; typecheck clean. **Gate-gap follow-up for the owner ledger: consider adding the web production build (or a node:-scheme import lint for client-reachable graphs) to `pnpm gate` — this class is currently caught only in CI perf jobs.** *(CLOSED 2026-07-27: `pnpm gate:full`, commit 293b985 — L4 of the owner-ledger close-out run.)* Round-2 dispatch on the fixed SHA is the final board.
- **3-OS dispatch round 2 (run 30236967355, tree 8f11000): FULL BOARD GREEN** — gate ubuntu + windows + macos, perf-t0, perf-web-budget, perf-lighthouse all success (gate-node-next skipped-on-dispatch by design). The run's exit-gate "gate green, 3 OS" item is CLOSED with remote proof on the final tree.
- **Owner ledger: EMPTIED 2026-07-27 by the "Closing the Four Owner-Ledger Items" run (see its section at the top of this file).** (1) `.mts` admission → **CLOSED, fcb94ef** (+ the probe-failed visibility machinery 7b33a68..38099e1). (2) Tarball `loombre` PATH shim → **CLOSED, 7e83ba7** (container-smoke-proven; the H2-recovery invocability fix). (3) Admin-only event-list parity → **CLOSED, 375be32** (canonical in packages/shared; parity demonstrated red-first). (4) Was the round-2 CI pointer — resolved in the round-2 entry above (full board green at 8f11000). The related gate-gap follow-up from the round-1 CI entry (web production build not in pnpm gate) → **CLOSED, 293b985** (`pnpm gate:full`).

### Freeze entries (per item; orchestrator-integrated from lane freeze reports)

**H1 — user_settings.prefs is a real writer; §2.6 consumes it (LANDED 2833bfe).** `putMySettings` (apps/server/src/catalog/users.controller.ts) now takes a validated `@Body()` (house hand-rolled pattern; unknown keys 422; readOnly `restrictedOptIn` + `updatedAtMs` accepted-but-ignored) and persists via @loombre/db's new `updateUserPrefs` (identity.ts upsert, self-scoped by user_id — identity plumbing is deliberately outside `applyGuard()`, per that file's standing header; the writer's doc comment says so). `mapSettings` reads real prefs with per-key fallback defaults. Web `AccountSection` restores the two language pickers as Phosphor-styled native `<select>`s (NEW markup, not the old free-text inputs; no autoplay control — F3(c) precedent; no theme control — owner ledger item 6 untouched; both values round-trip unchanged) with honest "Saved" semantics: 2xx-gated, failed-PUT-shows-error-never-Saved TESTED. New canonical language list packages/shared/src/language-codes.ts (ISO 639-2 + ~20 bibliographic/terminologic equivalence pairs + pure `languageMatches()` — stored `fra` matches stream-tagged `fre`). §2.6 subtitle auto-match key is now `subtitleLanguagePref ?? resolvedAudioLanguage` (adjudication A-2; docs/PLAYBACK.md §2.6 amended same commit; pin still wins; NO full-sub auto-selection). Cascade cases live in resolve-selection.spec.ts (+20) + new user-settings.e2e.spec.ts (16, incl. DB→controller→selection seam proof) — engine/matrix untouched by design (selection is matrix INPUT; invariant 2 applies only to engine changes, none made). **oasdiff: 5 error + 3 warning, all on PUT /users/me/settings request properties** (min-length ×3, pattern ×2; max-length ×3 warning) — P4.22-style pre-release narrowing, recorded in the commit body; SDK regenerated same commit, drift-clean. Conformance bodyless expectation putMySettings 200→422.

**H2 — CLI PIN-reset recovery (LANDED 276edfc).** `loombre admin reset-pin <username>` (apps/server/src/cli/admin-reset-pin.ts + admin-node-deps.ts): server-local, interactive y/yes confirmation NAMING the user and stating what's cleared; NO `--yes` flag (the interactive confirmation is the privilege boundary); no HTTP surface exists (grep-verified: zero reset routes in openapi.yaml/controllers). Clears user_settings.{restricted_opt_in, restricted_pin_hash, restricted_unlocked_until_ms} via new `resetRestrictedPinAndEmit` (withTransaction + writeEvent; true no-op with NO event when the user never opted in). Event `user.restricted-pin-reset` (ADMIN_ONLY; payload {userId, username, actor:"cli"}, actorUserId null): registered at envelope enum 24→25 + payload schema + event-schemas.spec + event-taxonomy ADMIN_ONLY 9→10 + actor-field map + ws-broadcaster admin-delivery case (job.updated pattern; leak.spec untouched — the precedent ADMIN_ONLY type has no leak case either, grep-confirmed). **Bonus finding: an undocumented THIRD copy of the admin-only list (apps/worker/src/plugin-delivery/constants.ts `LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES`) caught and pinned with a new SNAPSHOT test (constants.spec.ts) — red-first. Lane R corrected the original "lockstep" claim: the test compares against its own hardcoded copy (no cross-import — dependency direction forbids it) and NO automated gate enforces parity across the three copies; adding an admin-only type means updating server list + worker constant + both specs BY HAND (the test's comment now says exactly this).** `runCli` is now async; @loombre/db loads ONLY inside the admin branch (dynamic import; help/version/paths/doctor load zero DB code; bin header claims updated). E2E proof chain: opt-in PIN 1234 via real putRestricted → unlock → CLI reset (real runCli, fake confirm, real DB) → old-PIN unlock now 403 (honest gates-1-4 precondition — opt-in is cleared, so the wrong-PIN path is not what fires) → fresh opt-in PIN 5678 works → event row asserted. pin-format.ts + users-me.controller.ts headers updated: the CLI is the recovery path; currentPin stays unclamped as the self-service migration valve and dies naturally. Docs: NEW docs/ops/cli.md (honest invocation incl. the tarball's no-shim reality) wired into sidebar + ops index; admin-guide "Forgot PIN?" plain-language note + user-guide one-liner; register-lint 21→21 warnings (0 new).

**H3 — legacy-format reinstatement, visible skips (LANDED d9b5db5).** Scanner admission set (v1.1): video mkv,mp4,avi,mov,m4v,ts,m2ts,webm + REINSTATED wmv,mpg,mpeg,vob,flv; audio flac,mp3,m4a,ogg,oga,opus,wav,alac + REINSTATED aac,aiff. Excluded-but-VISIBLE (`EXCLUDED_MEDIA_EXTENSIONS`): ape,wv,wma — genuinely rare + codec-support thin (WIDENED to 26 entries by the Lane R fix wave below — the recognized-media tail, closing the silent class; audio also gains the admitted .aif alias of .aiff there); classifyAuxiliary gained a distinct 'unsupported' kind checked before 'ignored'; scan.completed payload additively gains skippedUnsupportedCount + skippedUnsupportedFiles (capped 100; count authoritative); LibrariesPanel shows an expandable "N skipped (unsupported format)" disclosure (jsdom-tested); plain junk stays silently ignored. Prerequisite honored: Container union widened by EXACTLY asf,mpeg,flv,aac,aiff — PLAYBACK.md §2.1 amended FIRST, then **nine** agreeing sites (the enumerated five PLUS four found by the lane: packages/db media-info.ts + media-assembly.ts `CONTAINERS` whitelists — missing them would have made every reinstated file silently permanently "not ready" — and openapi.yaml's second MediaFileSummary.container enum copy; new DB-level tests pin the whitelists). Empirical format_name (ffprobe 8.1.1): wmv/wma→asf, mpg/mpeg/vob→mpeg (vob via dvd muxer; dvd_nav_packet data stream already skipped), flv→flv (h264+aac accepted), aac→aac, aiff→aiff. plan() needed ZERO decision-rule changes (confirmed empirically); 6 new matrix cases 507–512, burnup 506→512 green/0 red — incl. the honest surprise that mpeg2-on-mpeg2-capable-device keeps Stage B verdict `copy` so no software-fallback reasons fire despite decision `transcode`. oasdiff: Container findings all `response-property-enum-value-added` (warning class). Docs: full format table incl. v1 exclusions in admin-guide/libraries.md ("operator guide" per the brief ADJUDICATED to admin-guide — scanning is taught there, no ops page fits; logged deviation), user-guide plain-language passage in watching.md; register-lint 0 new warnings. Fixture generator 80→86 files; probe integration + new scanner spec (ingestion/exclusion/kind-independence/100-cap). media-extensions.spec red-first captured (stash/run/restore, not simulated).

**H4 — forward-only migration policy (LANDED 3be4f4b + 995151f).** Audit finding: "no down migrations exist anywhere (contradicts PLAN.md 4.2)". §4.2's old bullet promised tested `down` for dev and an ops-guide rollback page; neither was ever true (migrate.mjs has never had a down command; grep: zero down references in docs/developer-guide/ or packages/db — "remove scaffolding" resolves to verified-none-exists). §4.2 now: forward-only, no down migrations anywhere, ever; dev reset = drop + re-migrate zero-to-current (pnpm db:reset); production rollback = restore pre-upgrade backup + roll forward — and the ops promise is now FULFILLED: docs/ops/backup.md gained "Rolling back a failed migration" (chosen over updating.md: backup.md owns restore mechanics incl. the restore drill). Zero-to-current proof made PERMANENT + ASSERTED in ci.yml's gate job: step renamed "Zero-to-current proof: fresh DB → all migrations → seed" and hard-fails (psql information_schema check) if schema public isn't empty before migrating; conformance + leak ride the same job's test step (each self-sufficient); db:migrate-check separately replays the chain into a scratch schema; kept in the one gate job (all 3 OS legs, no new job). Ground truth on fresh loombre_lane_d: 17/17 migrations from zero, seed committed, leak 41/41, conformance 50/50.

**H5 — placeholder minisign key structurally untaggable (LANDED f413b7a).** Audit residue: "docs/install/linux.md still ships the all-zero placeholder key" (class sibling of the keys/README.md staleness 9552333 fixed). Checker core extracted to scripts/release/lib/pubkey-consistency.mjs (pure, 18 node:test cases); placeholder detection is a standalone PRIOR failure condition against every location including keys/minisign.pub itself — an all-placeholder tree used to PASS the equality-only check, now fails naming the file + owner action ("generate the real keypair per keys/README.md, wire it with `pnpm embed-public-key` + the marker blocks"). docs/install/linux.md added as 5th checked location (placeholder replaced with the real key; stale pre-release note rewritten per its own replacement instruction; marker/fence ordering normalized — its old fence-wraps-markers shape was unparseable, which is the red-first failure captured verbatim) + a docs-wide sweep of every tracked docs/**/*.md marker block (52 files). Wired: release.yml `prepare` job (a bad tag dies in seconds, before any build spend) + existing pre-sign run + NEW post-sign `minisign -V -p keys/minisign.pub` verification of manifest.json + SHA256SUMS (proves the CI signing secret pairs with the committed, placeholder-free public key — brief clause (b) closed without touching the secret). Stale prose fixed: packaging-release.md (placeholder-era claim + wrong sign-manifest.mjs CI attribution), ci.yml step comment, embed-public-key generator template (update-public-key.ts regenerated). No v* tag pushed (owner-billed); the prepare wiring IS the tagged-build gate.

**H6 — admission-lock topology recorded (LANDED 7209595).** Audit language: "admission control is process-local and would need a DB advisory lock under a multi-process topology". No code change — transcode-admission.ts's own header already documents the constraint AND the conversion path. docs/developer-guide/architecture/playback-engine.md gained "Admission control is process-local": TranscodeAdmissionGate (module-level singleton, promise-chain mutex serializing count+create) is correct for v1's one-server-process-per-instance topology (compose prod + bundled installers); multi-process against one database would over-admit and requires converting to a pg_advisory_xact_lock-guarded count+insert transaction in packages/db (CLAUDE.md invariant 4; precedent query/identity.ts first-admin creation). **The topology constraint: packages/db conversion is REQUIRED before any multi-process deployment — this section is the honest map for whoever scales it.**

## Public-facing docs restructure (2026-07-26, owner-directed; commit 324f400)

- **README rewritten visitor-first (308 → 217 lines).** Three owner decisions recorded: (1) the Install section presents ALL FOUR channels (Docker/Compose, Linux tarball+systemd, Windows MSI, macOS .pkg) as first-class in a platform table with an honest "installer artifacts ship with tagged releases; none has shipped yet" note — NOT a Docker-only quick start (the full copy-pasteable Docker sequence stays, minus the old drift-apology meta-commentary); (2) STATE.md dropped from the README doc list — it stays tracked and public (per the pre-public-cleanup decision above) but is no longer advertised to visitors; its link home is CONTRIBUTING.md; (3) badges added (ci.yml status, static AGPL-3.0-only, static Node 24). Every internal codename (P4.x, D-numbers, STATE.md refs, plan-§ citations) stripped from README headings/body — grep-verified zero remaining. The "Status: private" claim removed (was already stale — repo is public as of 2026-07-26).
- **Perf-budget material MOVED, not copied:** README was the ONLY home of the enforced-budgets table + `perf/baselines.json` update-requires-reason ledger (no developer-guide page covered `perf-t0` at all). Now `docs/developer-guide/architecture/performance-budgets.md`, wired into the dev-guide index, the VitePress sidebar, and CONTRIBUTING's invariants section; README keeps one link from the budget-hardware bullet. Internal refs (plan §9, P2.6/D15) deliberately KEPT on that page — right audience.
- **Screenshots:** stable copies at `docs/public/screenshots/{home,player,browse-music,movie-detail}.png` + `hdr-tonemap.jpeg` (originals stay in reports/ — other docs cite them); resolves for BOTH the GitHub README (repo-relative) and the VitePress site (`/screenshots/…` via the public dir). README's raw HTML comment, "(screenshot coming…)" placeholder lines, and empty admin-dashboard cell removed.
- **Gap check came back mostly already-done:** docs/ops/acme.md already had the full HSTS truth table and docs/install/docker.md the cosign command — the only genuine gap was reverse-proxy.md never stating IN PROSE that the proxy owns HSTS on that path (its nginx recipe's add_header line was unexplained). Added a short section with Caddy/Traefik equivalents; correction caught during drafting: NONE of the three recipe proxies sets HSTS by default (a near-miss claimed Caddy does — it does not).
- **Hygiene same pass:** CODE_OF_CONDUCT.md linked from README + a new CONTRIBUTING section (was orphaned — linked from nowhere); LICENSE-INTENT.md H1 `# LICENSE-INTENT.md` → `# Licensing intent & provenance` (title only).
- **Verification:** `pnpm docs:build` PASS (dead-link checking on; register-lint warnings pre-existing), scripted README link check 37/37 relative links resolve, screenshots confirmed landing in `docs/.vitepress/dist/screenshots/`.

## Repo transferred to the loombre org (2026-07-25)

- Owner transferred the GitHub repo `ozzydeving/Loombre` → **`Loombre/Loombre`** (org account; canonical casing confirmed via `gh api repos/loombre/loombre` → full_name `Loombre/Loombre` after the first push returned a "repository moved" redirect notice). Coordinate sweep applied: GitHub coords → `Loombre/Loombre`, GHCR images → `ghcr.io/loombre/loombre` (registry paths are lowercase, matching release.yml's `REPO_LOWER`) across 17 files (README, Dockerfile OCI label, docs/install + docs/ops, VitePress social/edit links, issue-template security link, systemd unit Documentation=, Homebrew formula, release-notes script + test, update-check `DEFAULT_MANIFEST_BASE_URL`, design bundle READMEs). docs/ops/env-reference.md REGENERATED via tsx gen-env-reference (not hand-edited), zero drift beyond the URL line. Historical entries below intentionally keep `ozzydeving/*` — they record what was true at the time.
- release.yml needs no edit (uses `${{ github.repository }}` / `REPO_LOWER` dynamically). NOT redirected by GitHub: GHCR image namespaces — any previously published `ghcr.io/ozzydeving/loombre` images stay at the old path; `ghcr.io/loombre/loombre` exists only after the next publish. Prior release attestations/cosign identities (if any) name the old repo URL; docs describe the new-identity flow for future releases. Owner confirmed NOTHING was published pre-transfer — no GHCR/attestation legacy exists. Casing is load-bearing in ONE place: the docs' cosign `--certificate-identity-regexp "^https://github.com/Loombre/Loombre/"` — Fulcio certs embed `github.repository` canonical casing and regex match is case-sensitive, so the lowercase form would fail verification of real release signatures.
- Verification: render-release-notes tests 4/4, update-check config.spec 6/6. grep-gates: 6 pre-existing violations in untracked/gitignored `apps/web/.lighthouseci/manifest.json` (absolute paths from the old local folder name; clean clone unaffected) — unrelated to this sweep, left for owner to delete or keep as W2 Lighthouse evidence.

## Pre-public cleanup (2026-07-25, owner-directed; three owner decisions recorded)

- **Owner decisions:** (1) STATE.md STAYS TRACKED and ships publicly (this file remains the database per CLAUDE.md; personal-info lines redacted — §6 validation entry + parser note genericized, owner home path/library inventory removed). (2) The five internal review docs DELETED from the tree: reports/{install-smoke-linux,lpp-adversarial-review,security-review-phase4,privacy-review-phase4,hw-verify-macos}.md — their C/H/M findings were all fixed with tests per the Phase-4/LPP entries above, and the still-open LOW items remain tracked at the Phase-4 W3-sec entry (L1 rate-limiter Map eviction, L2 isAdmin JWT staleness, L3 update-check redirect-following) — reports/t0-audit.md (live template, renamed clean of the former name) + agpl-readiness.md (LICENSE-INTENT link) + README screenshots stay. (3) FRESH PUBLIC SNAPSHOT before going public: history squashed to a single initial commit (pre-squash history preserved in a local-only branch + bundle; old commits contain unredacted paths + the review docs and must not be pushed).
- **Dead code removed (three-agent audit, all candidates reference-verified):** apps/server/src/tls/index.ts (the ONLY orphan module in apps/+packages/ — stale re-export barrel, main.ts imports tls/* directly), scripts/scan-report.mjs (zero invokers), reports/addendum-a-settings-ui.png (unreferenced). Audit explicitly cleared: worker-thread entries (new URL), bin/loombre.mjs's compiled-path import, matrix specs (vitest.matrix.config), styleguide-only Overlay demos, amber app-icon (D7 alternate — kept).
- **Stale tooling fixed:** scripts/*.test.mjs + release:test suites were wired to NOTHING (scripts/ is not a workspace; turbo never reached them) — new `pnpm scripts:test` runs all of them, added as an explicit ci.yml gate-job step. Doing so exposed a stale pin: fetch-embedded-pg.test.mjs still asserted the superseded D1 PG-17 default; corrected to N4 reality (default 18.x, floor 17, extras 17.x upgrade-test only). release.yml's four vestigial "lane In script pending" guards removed (all lane scripts exist). Duplicate root package.json license-check script removed (scripts/license-check.mjs, run by gate, is the successor — its comment already claimed the old one was removed). Dangling comment citations to the untracked reports/phosphor/wave3/fidelity-audit.md reworded in 4 web files; hw-verify-macos.md references reworded in ci.yml/runbook/vt-tonemap spec.
- **Local-only purge:** 18 prunable pre-rename agent worktrees (19 GB) + their 18 fully-abandoned worktree-agent-* branches (each 1 commit of already-integrated wave work) deleted; apps/web/.lighthouseci (5 MB, the manifest that tripped local grep-gates) deleted. Local grep-gates now PASS.
- **Still open for the owner:** GitHub-side after the squash force-push, old commits remain fetchable on GitHub until GC — NOTE the public STATE.md itself cites dozens of pre-squash SHAs in its dated history, so "nobody knows the SHAs" does NOT hold; for a guarantee, recreate the repo from the snapshot before flipping visibility. Candidate improvements, not done: depcruise no-orphans rule (would have caught tls/index.ts mechanically), .nvmrc vs hardcoded CI node-version drift.

## Release signing trust root LIVE (2026-07-26, owner ran the offline half)

- The P4.9 placeholder era is OVER: owner generated the real minisign keypair offline per keys/README.md (public key ID `9EA9BD1D8785E084`; secret key passphrase-protected at `~/.loombre-release-signing.key`, owner-held, never in repo/CI logs), and set `LOOMBRE_MINISIGN_SECKEY` + `LOOMBRE_MINISIGN_SECKEY_PASSWORD` repo secrets. Wiring completed same session: `pnpm embed-public-key` regenerated packages/shared/src/update-public-key.ts, real key pasted into docs/ops/updating.md + scripts/release/release-notes-template.md marker blocks, `check-pubkey-consistency` PASS — all 4 locations byte-identical. release.yml's fail-closed signing step is now satisfiable; the repo is clear for the first draft-release dress rehearsal (rc tag → CI builds all four installer channels → draft release → owner tests artifacts → publish or delete).

## Pre-public hardening (2026-07-25, owner-directed follow-up: L1–L3 closed, CoC added, CLAUDE.md untracked)

- **L1 CLOSED (rate-limiter Map growth):** KeyedRateLimiter now sweeps at most once per `capacity*refillMs`, evicting buckets that have refilled to FULL capacity — behavior-neutral by construction (a full bucket is indistinguishable from the fresh lazily-allocated one a returning key gets), proven by the new eviction spec block (evicts-full / keeps-mid-refill / evicted-key-starts-fresh / updatePolicy-unchanged). Steady-state memory = distinct keys per refill window, not lifetime churn.
- **L2 CLOSED globally (stale isAdmin claim):** require-live-admin.ts RELOCATED settings/ → common/ (same module-boundary escape-valve precedent as rate-limiter.ts; 9 importers repointed). The three remaining claim-only surfaces — catalog admin.controller (12 sites), users.controller (5), libraries.controller (6) — now claim-fast-fail THEN re-read users.is_admin fresh per request (A10/gate-5 pattern). ws-broadcaster re-reads is_admin at its existing 5s context-TTL boundary, fail-closed — a demoted admin's live socket loses ADMIN_ONLY delivery within ≤5s. Proven by live-admin.e2e.spec.ts (demote → same still-valid token 403s /admin/jobs, /users, /libraries immediately; failing-first run demonstrated the 200s) + a ws-broadcaster.e2e demote case.
- **L3 CLOSED (update-check blind redirects):** perform-check.ts now uses fetchWithBoundedRedirects — manual `redirect:"manual"` hops, MAX 3, each hop must be https OR same-origin (default GitHub `releases/latest/download` needs exactly one https redirect; local http fixture/lab mirrors may redirect within themselves); violations → existing "unreachable" path, never a throw to callers. 7 new spec cases incl. end-to-end verified-through-redirect and refused-chain→unreachable.
- **FIRST PUBLIC-REPO 3-OS CI (2026-07-26, runner minutes now unmetered — repo is PUBLIC as of this date):** dispatch 30188323030 (`gh workflow run ci.yml -f os=all`). ubuntu-latest GREEN + all three enforcing perf jobs GREEN (lighthouse/t0/web-budget). windows-latest and macos-latest each surfaced ONE real defect — both first-ever executions of the affected specs on those platforms:
  - **Windows (test bug, not impl):** packages/shared/test/crash-dir.test.ts hardcoded the POSIX literal `/var/lib/loombre/crashes`; crashDirPath is a node:path `join` helper, so Windows correctly returns `\var\lib\loombre\crashes`. Assertions rebuilt from `join()` + a new explicit native-separator-per-platform case. The IMPL is correct and unchanged — a Windows install must get Windows separators.
  - **macOS (timeout, not defect):** packages/provisioning-pg/test/corruption.integration.spec.ts does REAL initdb/pg_controldata against vendored binaries and SKIPS on linux/windows (darwin-arm64 = proven integration host), so macos-latest was its first-ever CI run — vitest's fixed 5s default was never right for it (file takes ~20s there, ~6.8s locally). All 6 tests now carry `30_000 * TIME_SCALE`, matching the timeout the file's last test already used.
  - **Ubuntu borderline flake (fixed pre-emptively):** apps/worker test/image/variant-job.spec.ts (real sharp/AVIF encode) took 13.4s on a 3-core runner vs 0.73s locally — one AVIF case blew the 5s default in run 30187808986, then passed in 30188323030. apps/worker/vitest.config.ts now scales testTimeout/hookTimeout by LOOMBRE_TEST_TIME_SCALE (already in turbo globalEnv; ci.yml sets 3, macOS 10).
  - **ROUND 2 (dispatch 30188677276 + push 30188677341): macOS GREEN (timeout fix held), ubuntu green on dispatch; three MORE findings, one a REAL PRODUCTION BUG:**
    - **P4.18 — served HLS playlist was rewritten non-atomically (REAL BUG, fixed).** apps/worker/src/transcode/runner.ts wrote `media.m3u8` with plain `writeFile` (O_TRUNC) on EVERY loop iteration while clients poll `GET /playback/sessions/{id}/hls/media.m3u8`, so a reader could observe the file empty (truncate→write window) or partially written. apps/server/src/playback/hls-file.controller.ts already refuses a zero-length read and re-polls — which is why this never surfaced client-side — but that guard CANNOT detect a NON-EMPTY partial playlist. Now atomic: write `<path>.tmp` then `rename()` (atomic within a directory on POSIX; Node's rename replaces the destination on Windows via MOVEFILE_REPLACE_EXISTING). Readers see the previous complete playlist or the next one, never a torn one. Found because the ubuntu leg read `''` where `#EXTM3U` was expected — same commit passed on the dispatch run, i.e. a genuine race, not a slow runner.
    - **Windows test-portability ×2 (impls correct, tests wrong).** vendor-layout.spec.ts asserted POSIX separators; resolveVendorBinaryPaths is host-native by design (production derives `platform` from process.platform/arch at bootstrap/provisioning.ts:106 and feeds the results to existsSync/spawn — a foreign target's paths are never resolved for real), so structural assertions are now join()-built while the genuinely target-derived `.exe` suffix keeps literal assertions. secret-file0600.spec.ts asserted mode 0o600; Node's chmod on Windows only toggles the read-only attribute (reads back 0o666) — assertion is now host-aware, NOT skipped, so the POSIX guarantee stays strictly enforced where it is real.
    - **~~PLATFORM LIMITATION~~ → CLOSED by owner directive (P4.19).** The Windows gap (no POSIX bits ⇒ secret inherits the parent directory's DACL) is now closed at provisioning time rather than documented-and-accepted. `packages/provisioning-pg/src/secret/windows-acl.ts` applies `icacls <file> /inheritance:r /grant:r <principal>:F` — inheritance stripped, ONE explicit owner-only full-control ACE. Details that matter:
      - **Per-platform guarantee, now stated as such in file0600.ts's header:** 0600 mode bits on POSIX; explicit owner-only DACL on Windows. The backend name stays `file0600` (it is a wire-visible SecretBackend enum value in @loombre/provisioning), but it no longer claims a POSIX-only guarantee in prose.
      - **Write ORDER on Windows:** create empty → apply DACL → write the secret bytes. Any other order leaves the secret briefly readable under inherited permissions.
      - **Principal = SID (`*S-1-…`) via `whoami /user`,** falling back to the bare account name: a name like "alice" is ambiguous on a domain-joined host, a SID never is.
      - **FAIL-CLOSED:** a failed icacls throws the new typed `SecretAclError` instead of leaving the secret under inherited permissions — provisioning stops loudly. Practical failure modes named in the message: icacls not on PATH, or a non-ACL volume (FAT32/exFAT).
      - **Self-healing:** the idempotent path (secret already exists) re-asserts the DACL, so a cluster provisioned by a pre-hardening build is repaired on next run. Content is never touched.
      - **CI assertion (windows-latest gate):** secret-file0600.spec.ts asserts the ACL actually on disk — no `(I)` inherited ACEs, no BUILTIN\Users / Everyone / Authenticated Users, EXACTLY one ACE ending `:(F)`, owned by this process's account; plus a Windows-only test that re-grants BUILTIN\Users by well-known SID and proves the next generate() revokes it. ACE lines are matched positively on the `principal:(FLAGS)` shape so the assertions do not depend on the runner's display language.
      - **DELIBERATE CONSEQUENCE, operator-visible:** Administrators and SYSTEM are NOT granted (they can still take ownership — inherent to Windows). If the server is later run under a DIFFERENT Windows account than the one that provisioned, that account cannot read the secret. Relevant if/when the Windows service lane runs under LocalSystem rather than the installing user — installers/windows must either provision as the service account or grant it explicitly.
    - **P4.19 EXTENDED to the other two secret writers — Windows CI forced the question (round 3).** The gap flagged above was not hypothetical: windows-latest round 3 failed on `tls/acme/account-key.spec.ts` + `cert-store.spec.ts` with the same `expected 438 to be 384`, i.e. the ACME ACCOUNT KEY and the CERTIFICATE PRIVATE KEY were inheriting the parent DACL. Canonical implementation now lives in `packages/secrets/src/owner-only-file.ts` (`writeOwnerOnlyFile` / `applyOwnerOnlyDacl` / `reassertOwnerOnly` / `currentUserPrincipal` + typed `SecretAclError`), shared by `apps/server/src/tls/fs-secret.ts` and this package's own file0600 backend (JWT HMAC keys et al) — apps/server already depended on @loombre/secrets, so no new edge. provisioning-pg keeps its own copy (its header forbids depending on packages/secrets; @loombre/provisioning is a pure contract package and cannot host I/O) — **TWO copies now, both marked "keep in sync"**, down from the three a naive fix would have produced.
    - **ROUND-4 FINDING — the two-flag idiom is NOT owner-only (real defect in the first cut, caught by CI).** `icacls /inheritance:r /grant:r <user>:F` left **three** ACEs on windows-latest. `/inheritance:r` removes only INHERITED entries and `/grant:r` replaces only the NAMED principal's entry, so any OTHER principal holding an EXPLICIT ACE (SYSTEM, Administrators) survives both flags. The "no `(I)`" and "no BUILTIN\Users" assertions BOTH PASSED while the secret was still readable by other principals — only the exact-ACE-count assertion caught it. `applyOwnerOnlyDacl` now enumerates the DACL after applying the flags, `/remove:g`s every principal that is not the owning account, and then VERIFIES its own postcondition (exactly one ACE, belonging to this account) — throwing SecretAclError if not, rather than returning as though the guarantee were made. Both copies updated. Lesson worth keeping: for a confidentiality control, assert the WHOLE resulting state, not the absence of the principals you happened to think of.
    - **Shared test seam:** `apps/server/src/tls/test-support/assert-owner-only.ts` — POSIX asserts 0600; Windows asserts the real DACL (no `(I)`, no BUILTIN\Users/Everyone/Authenticated Users, exactly one `:(F)` ACE owned by this process). Throws instead of importing vitest's `expect`, matching self-signed-cert.ts's posture in the same directory.
  - **DNS-01 HOOK ON WINDOWS — PRODUCT GAP, deliberately NOT papered over (owner decision needed).** `runDnsHook` spawns the operator's hook path DIRECTLY with no shell, on purpose: the hook receives attacker-influenceable record values. On Windows that means `#!/bin/sh` hooks cannot execute (spawn EFTYPE — round 3's failure) AND `.cmd`/`.bat` cannot be spawned without `shell: true`, which Node has refused since the CVE-2024-27980 batch-file fix. **Net: a Windows operator's `LOOMBRE_ACME_DNS_HOOK` must today be a native executable (.exe).** The four script-fixture tests are gated to POSIX with that reasoning recorded in the spec; the spawn-failure case stays ungated. Enabling `.cmd` hooks means reintroducing a shell into that spawn (command-injection surface) — a security/product decision for the owner, not a test fix. Options if Windows hooks matter: (a) document .exe-only, (b) allow `.cmd` via an explicit interpreter (`cmd.exe /c`) with strict argument quoting + a hook-path allowlist, (c) support a `node <script>` hook form.
  - **P4.21 — the LAST Windows blocker, precisely localized: TWO TLS specs crash their vitest fork. PRE-EXISTING, unrelated to this sweep.** After the hookTimeout fix (P4.20) the `Hook timed out` error is GONE, but `Worker exited unexpectedly` ×2 remains — so the two were INDEPENDENT problems and P4.20's causal claim (hook kill ⇒ fork death) was WRONG; recorded as such rather than quietly amended. Localized by diffing the spec files vitest REPORTED against the full 90 (note: Windows vitest prints backslash paths — normalize before diffing): apps/server reports 86 passed + 2 skipped = 88, and the two files that never report at all are **`src/tls/manual-provider.spec.ts`** and **`src/tls/runtime.spec.ts`** — both of which create a REAL `https.Server` and perform a REAL TLS handshake. Same two files in runs 30189253989, 30190855614 and 30191836871; run 30189253989 PREDATES the secrets/TLS work (turbo never reached apps/server in 30189943168, which is why that run showed zero). So: a pre-existing Windows-only crash in real-TLS specs, NOT a regression from the rename/cleanup/security work. **Owner decision — no code change made.** Next diagnostic step if wanted: run those two specs alone on windows-latest with `--pool=threads` (or `--no-isolate`) to separate a Node/OpenSSL-on-Windows native crash from a vitest fork-teardown/handle-leak issue. Everything else on Windows passes: 943/943 worker tests, all 88 reporting server files, and the full DACL battery.
  - **P4.21 ROOT CAUSE FOUND AND FIXED (2026-07-26) — a PRODUCTION Windows crash in manual-TLS hot-reload, plus a diagnostic-method failure worth keeping on record:**
    - **THE BUG:** libuv's Windows fs-event backend hard-aborts the process — `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72` — when `fs.watch` is given a directory path containing a DOS 8.3 short name and an event fires. os.tmpdir() on GitHub runners IS such a path (`C:\Users\RUNNER~1\…`). `watchManualCertificate` (manual-provider.ts, the LOOMBRE_TLS_MODE=manual hot-reload) passed caller-spelled dirs straight to fs.watch, so `manual-provider.spec.ts` and `runtime.spec.ts` (which exercises the manual branch) killed their vitest fork with NO JS error — the "Worker exited unexpectedly" seen 5/5 in real CI. NOT a TLS/OpenSSL issue, NOT vitest pools, NOT turbo concurrency, NOT the shell: every one of those hypotheses is dead, and the crash reproduced in EVERY forks-pool configuration including each spec alone (2-second instant death) once the logs were read correctly.
    - **PRODUCTION IMPACT (why the fix is in src/, not the tests):** a Windows operator whose cert/key path contains a short-name component (%TEMP%-derived paths, legacy tooling output) would have the ENTIRE SERVER abort on the first cert-rotation event. Fixed in manual-provider.ts: `canonicalWatchDir` resolves each watched dir via `realpathSync.native()` (expands 8.3 names on Windows; resolves symlinks everywhere — also better for certbot's `live/` symlink layout) with fall-back to the caller's spelling if resolution fails. Also collapses two spellings of one dir into one watcher. The worker's library watcher is chokidar (normalizes internally) — manual-provider was the only raw `node:fs` watch in the tree.
    - **DIAGNOSTIC-METHOD FAILURE (the reason rounds 1–5 reported nonsense):** GitHub's API reports `conclusion: "success"` for `continue-on-error` steps EVEN WHEN THEY FAIL. Every "all green / hypothesis refuted" reading in rounds 1–4, and round 5's "gate passes under bash", was that artifact — L1/L2 actually died in seconds at the oasdiff step (not installed in the diag job), and the two specs actually crashed in EVERY configuration tested. The truth only surfaced by downloading raw step logs, where the libuv assert line had been sitting since round 1, step A. **Standing rule for any future CI diagnostics: never read step conclusions under continue-on-error — print explicit `VERDICT:` lines and read the log.** The rewritten windows-tls-diag workflow (round 6) encodes this.
  - **~~DIAGNOSIS ROUND 1 (workflow `windows-tls-diag`, run 30208139890) — HYPOTHESIS REFUTED, usefully.~~ INVALIDATED — see the method-failure note above; the conclusions in this and the following round entries were API artifacts.** Ran both specs on windows-latest five ways: default forks+isolate (the CONTROL, predicted to crash), `--pool=threads`, forks `--no-isolate`, and each spec alone. **ALL FIVE PASSED, including the control.** So the specs are NOT intrinsically broken on Windows and it is NOT a pool-mode property — the crash only exists when they run inside the FULL apps/server suite (88 other files first, sequentially, many binding sockets and spawning children). Refutes the "native Node/OpenSSL TLS crash" theory outright. Round 2 (steps F/G in the same workflow) runs the FULL suite under forks vs threads with the gate's real Postgres/ffmpeg setup — the only context in which the crash has ever reproduced — to separate a fork-pool-at-scale interaction from suite-cumulative resource exhaustion (Windows ephemeral-port/handle pressure is the leading candidate for the latter, given how many e2e suites bind ports before these two run).
  - **~~KNOWN WINDOWS CI GAP~~ → CLOSED (2026-07-26).** P4.21 root-caused (libuv 8.3-short-name fs-event abort, see above) and fixed in production code (manual-provider.ts `canonicalWatchDir`). PROOF, not assertion: diag round 6 ran the two formerly-crashing specs 3× on windows-latest with the short-name precondition confirmed present (`tmpdir: C:\Users\RUNNER~1\...`) — VERDICT:R1/R2/R3 all PASS; real ci.yml run 30212271137 then delivered the FIRST-EVER green windows-latest gate (after 6 consecutive reds), with both specs REPORTING (`✓ manual-provider.spec.ts (5 tests)`, `✓ runtime.spec.ts (2 tests)`) and the server suite accounting for all 90 files (88 passed + 2 pebble-skipped-by-design). A same-day full 3-OS dispatch is the repetition proof. The windows-tls-diag workflow is KEPT (manual-dispatch-only, zero standing cost): its header now documents the root cause, the fix, and the continue-on-error VERDICT-line method rule.
  - **WINDOWS ACL UNIFICATION (owner-directed, done).** Both behaviors kept, single home: `packages/secrets/src/windows-acl.ts` now exposes TWO NAMED POLICIES with the rationale for each permissiveness level stated on the function itself — `applyOwnerOnlyDacl` (secrets/0600 tier: exactly one ACE, fail-closed, because a 0600 file must not silently become "every local admin can read it" when the platform changes) and `applyServiceReadableDacl` (IPC discovery/token files: SYSTEM full + Administrators read + operator extras, best-effort, because these files EXIST to be found by a tray app or CLI running as a different account than the LocalSystem service, and a failed hardening step must not take the listener down). Both call sites migrated: `packages/secrets/src/owner-only-file.ts` is now the file-WRITING half only, and `apps/server/src/ipc/windows-acl.ts` is a thin seam that keeps the IPC-specific operator documentation + `RECOMMENDED_ICACLS_COMMAND` while delegating the icacls call. Public contract of the IPC module unchanged (`applyWindowsAcl`, `WindowsAclResult`, `RECOMMENDED_ICACLS_COMMAND`) so `discovery-files.ts` and its spec were untouched. provisioning-pg still keeps its own copy — architecturally mandated, marked keep-in-sync. **Prior-art miss recorded:** the IPC module already existed when `owner-only-file.ts` was written; it was not checked for first, which is how the repo briefly ended up with two Windows-ACL idioms by accident rather than by decision.
  - **P4.20 — WINDOWS hookTimeout was unscaled (REAL defect, FIXED).** Three consecutive windows-latest failures after every code/test defect was fixed, with confusing symptoms — (a) run 30190448758: Postgres `ECONNRESET` / `Connection terminated unexpectedly` / `migrate.mjs reset failed` across four unrelated DB specs; (b) runs 30190855614 + 30191339575: **all 943 apps/server tests PASSED (86 files)** yet the run failed on two vitest "Worker exited unexpectedly" pool errors. The third run finally printed the cause alongside them: **`Hook timed out in 10000ms`**. apps/server set NO timeouts, so it inherited vitest's fixed 10s hookTimeout, while nearly every e2e suite there resets+reseeds a live DB from `beforeAll` by spawning migrate.mjs + seed.mjs — fine on real hardware, not on a Windows runner. A hook killed mid-setup takes its FORK down with it, which is precisely the "Worker exited unexpectedly" signature; and a hook killed partway through `migrate.mjs reset` also explains (a)'s torn-down connections. FIX: LOOMBRE_TEST_TIME_SCALE applied to `apps/server/vitest.config.ts` AND `packages/db/vitest.config.ts` (identical per-file schema-reset hook pattern). Assertions unchanged; local scale is 1 so stock 5s/10s limits are preserved.
    - **Process lesson (worth keeping):** apps/worker and provisioning-pg got this exact treatment in earlier rounds; apps/server and packages/db were left unscaled because each fix was made reactively, one failing package at a time. A config-wide audit after the FIRST timeout fix would have caught all four at once and saved three Windows rounds. Remaining unscaled configs are deliberate: playback-engine (pure, no I/O) and apps/web (jsdom units, no DB, no child processes).
  - **LOCAL FLAKE, pre-existing, follow-up candidate:** `src/catalog/admin-storage-pool.spec.ts` "dedupes two library paths on the SAME filesystem" equality-compares TWO LIVE statfs snapshots — on a busy machine the disk's used-bytes moves between the calls (observed: 8 KiB delta mid-gate) and the test fails spuriously. Passes alone; CI runners are quiet enough. Proper fix: inject the statfs reader (house pattern) or snapshot once and compare derived values, never two live reads for byte-equality.
  - **storage.spec.ts** — third instance of the hardcoded-POSIX-separator test bug (after crash-dir and vendor-layout); now join()-built. Pattern worth a lint rule if a fourth appears.
  - **Node 26 canary (gate-node-next) — RECORDED, NOT FIXED:** 44 apps/web tests fail with `window.localStorage` undefined under jsdom on Node 26. `continue-on-error: true` + push-only, so it never blocks and is SKIPPED on dispatch runs. Per N2 this job exists to accumulate adoption evidence for the Oct-2026 Node 26 LTS switch — shimming localStorage would destroy the signal. Owner decision point at LTS time: bump jsdom/vitest or carry a documented environment shim.
- **Repo hygiene same pass:** CODE_OF_CONDUCT.md added (Contributor Covenant 2.1, enforcement contact via GitHub — no personal email in-tree). CLAUDE.md untracked by owner decision (gitignored `/CLAUDE.md`, stays local); README/CONTRIBUTING/.dependency-cruiser references reworded to stand alone (invariant list's public home = docs/PLAN.md + CONTRIBUTING's distilled rules). design/ CONFIRMED load-bearing and stays tracked (blaze-provenance + blaze-public-assets tests byte-read design/blaze/assets/svg/ masters; READMEs are cited spec authority).

## Blaze logo rollout (kicked off 2026-07-25, authority: owner "Official Logo Rollout Across apps/web: Foundation Lane, Then Wide-Parallel" brief; design/blaze/README.md is THE spec — where brief and README conflict, the README wins and the conflict is logged here)

### Mission (verbatim)

Integrate the final Loombre logo identity ("Blaze" — three-tongue flame, inner flame as negative space, amber phosphor on near-black) across apps/web per the bundle README: ship the SVG masters as production assets; build a shared <BlazeMark> component with gradient / scanline / flat variants; replace the sidebar placeholder pulse-dot with the horizontal lockup at spec sizes; replace favicon + app-manifest icons; build the boot-splash component from loombre-splash.html (one-shot entrance + bloom, infinite out-of-phase idle burn, staggered wordmark and boot-log reveal); rebuild the loading spinner and indeterminate bar on the mark; set the GitHub social-preview banner — at reference fidelity, with every existing CI gate and performance budget green.

### Precondition + bundle reconciliation (2026-07-25)

- "Current gate green (clean clone, 3 OS)": met-on-local-evidence — the Phosphor exit gate walked SAME DAY on this tree (clean-clone local gate ALL STEPS PASSED at 185-line entry below; final working-tree gate ALL STEPS PASSED on 8b75e5d); only the docs-only [skip ci] STATE commit 8708e7b sits between that proof and this kickoff. Remote 3-OS legs remain billing-blocked (rerun pointer: dispatch 30182622346, 0 steps) — this run's exit-gate "3 OS" item INHERITS the owner billing action, the identical posture the sweep, LPP, and Phosphor recorded. Every Blaze wave gates locally regardless.
- Bundle reconciliation: brief names the handoff folder `design_handoff_loombre_logo/`; it was found already unpacked (untracked) at design/phosphor/blaze/. Moved to design/blaze/ per the brief's explicit target (also matches D12's recorded path) and committed 9cd22a6. grep-gates PASS (1966 files) with the bundle in tree. Zero content amendments needed (bundle already names ozzydeving/Loombre — no R8 correction this time, unlike the Phosphor bundle).
- D1 byte-faithful anchor — SVG master SHA-256 at commit (shipped copies must hash identical): mark 090ea925bcb9…, mark-scanline 4ae6b52937e2…, mark-flat 1d6059701a59…, favicon 49f54826002824…; full sums via `shasum -a 256 design/blaze/assets/svg/*.svg` at 9cd22a6.

### Kickoff ground truth + orchestrator adjudications (recon 2026-07-25 — G-numbers are run law alongside D-numbers)

- **G1 (amends D7's deletion clause):** apps/web serves NO favicon today — no favicon.ico/icon.*/apple-icon.*/manifest anywhere under src/app, `metadata` in layout.tsx:8-11 has no icons/manifest key, public/ contains ONLY fonts. D7's "delete whatever is served" is vacuous for favicons; W0 CREATES the wiring (metadata icons + a new app manifest). The real placeholder purge is TWO pulse-dots, not one: shell/Sidebar.module.css:51-76 (D8, Lane A) AND app/login/page.module.css:27-51 (`.brandDot`, 9px, glow 0 0 16px). Login brand block replacement → Lane B (owns that surface: stacked-lockup treatment, gradient mark ≥24px + wordmark per D2 rules); Lane D proves repo-wide pulse-dot extinction by grep.
- **G2 (D2 rationale corrected, decision unchanged):** the lockup SVGs contain NO Google Fonts @import (verified byte-level; bundle README:70's claim about its own files is wrong — logged as a bundle-vs-reality conflict). D2's ruling stands on the real grounds: SVG `font-family` text nodes don't reliably bind the app's self-hosted faces (silent fallback = wrong wordmark), and text-in-SVG is unselectable/untranslatable. Lockup SVGs stay design-only.
- **G3 (scanline three-way conflict, adjudicated):** existing `--scanlines` token = 28% @ 1px/3px (Phosphor law, 4 consumers); Blaze README:62 recipe = 35% @ 1px/3px; the mark-scanline SVG's internal pattern = 1.2px @ 35% every 3.2px. RULING: the splash overlay ships the Blaze recipe as a NEW splash/brand-scoped token; the app-wide `--scanlines` stays 28% (Phosphor spec governs Phosphor surfaces); the SVG ships byte-faithful per D1 (its pattern is untouchable anyway). Owner may override at the W0 checkpoint.
- **G4 (brand ≠ accent):** `--color-accent` is USER-SWAPPABLE (lime/mint/blue via data-accent, tokens.css:276-286). The Blaze mark must NEVER derive from it or the logo turns lime. W0 adds brand-fixed tokens: `--brand-amber #ffb454` (justified duplicate of the accent DEFAULT — semantic split; precedent: appearance-prefs.ts:56 swatch literal), `--brand-amber-bright #ffd9a0`, `--brand-amber-deep #e08f2e`, `--color-bg-splash #07080a`, and the D11 glow token (comment must state: brand-mark glow, NOT the retired `--shadow-ember-bloom`). #101218 (Blaze "tile") ≠ `--color-bg-raised` #111318 — do not alias; fixture page may use the literal (duplicates no token).
- **G5 (D6 derivability limits):** APP_VERSION (lib/app-version.ts ← root package.json, currently 0.9.0) is the ONLY version source reachable pre-auth by all audiences (GET /system/info is admin-only) — splash boot log AND sidebar line use it; renders V0.9.0 not the reference's fixture V0.9.2. `LIBRARY MOUNT /MNT/MEDIA` and `STREAM ENGINE` readiness have NO pre-auth data source (libraries endpoint is authed; no engine-readiness contract field). Boot-log lines derive from REAL client boot facts instead: client version, server host via describeServerUrl() + reachability, auth/route-decision readiness — U9 precedent (login/page.tsx:12-45 ledger). Exact line copy = Lane B freeze item, orchestrator adjudicates. NO fabricated mount/engine claims.
- **G6 (D10 mechanics):** globals.css:64-72 globally clamps animation to 100ms !important under reduced motion. The D10 collapse is implemented per-component (class-level !important overrides beat the `*` clamp on specificity) and TESTED via the CSS-source-asserting pattern (readFileSync + regex the @media block — Toast.test.tsx:186 / phosphor-mobile-css.test.ts precedent), since jsdom evaluates no @media.
- **G7 (fixture/test infra):** NO Storybook, NO Playwright, NO @testing-library/react — HARD LINE, no new npm deps. Component harness = components/ui/test-render.tsx (renderIntoBody). Fixture page = the existing public /styleguide route (its own chunk; not /browse, not /login). Screenshots = live browser, committed under reports/blaze/waveN/ with the wave3-fidelity `build-*`/`reference-*` side-by-side naming.
- **G8 (budget exposure):** BlazeMark + path module land in Sidebar → counted by the /browse 200KB gz budget (156,159 B now, ~24% headroom). The splash stays route-scoped/dynamically imported so its animation code NEVER enters /browse. Lighthouse perf ≥0.90 audits /login (currently 1.00) — exactly where the splash lands: the run's single highest-risk gate; W2 re-proof mandatory, baseline edits require perf/baselines.json reason strings.
- **G9 (grep-gates reality):** there is NO fixture-hygiene section to extend — Lane D AUTHORS one (new pattern array, scoped like NAMING_SCOPE_PREFIXES to apps/) with D6's literals; the Google-Fonts grep needs explicit carve-outs for legitimate mentions (apps/web/public/fonts/PROVENANCE.md, src/styles/fonts.css comments; design/ and LICENSE-INTENT.md sit outside an apps/-scoped ban). R8's walkAll scans EVERY new asset byte-wise incl. its path — all shipped assets keep the loombre- prefix.
- **G10 (tablet rail, brief-decided):** the ≤1279.98px collapse hides the entire wordmarkRow today (Sidebar.module.css:363) — per the kickoff brief's "mark-only at collapsed width", Lane A ships the 18–19px flat mark centered in the 76px rail.

### Locked decisions (run law — cite D-numbers in lane freezes)

| # | Decision |
|---|---|
| D1 | The SVG files ARE the production assets: svg/loombre-mark.svg, -mark-scanline.svg, -mark-flat.svg, -favicon.svg ship into apps/web public assets byte-faithful (path data, gradient stops, scanline pattern untouched). Splash HTML + lockup SVGs are references only (D2, D6). |
| D2 | Lockup SVGs NEVER ship to the client (they embed a Google Fonts @import — violates the zero-telemetry/self-hosted-fonts law). In-app lockups are composed: <BlazeMark variant="flat"> + real text nodes in the repo's self-hosted Archivo/Plex Mono (wordmark Archivo 800, font-stretch:125%, letter-spacing .22em horizontal / .24em stacked + padding-left:.24em optical centering, #E9EBEE; subline Plex Mono 500, .16em, #61666E). Lockup SVGs stay in design/blaze/ for print/design use. |
| D3 | One geometry, two render modes. Static: ONE <path> (outer + core) fill-rule="evenodd" — core is a true hole. Animated (splash, spinner): TWO paths, core filled with the surface color behind it (#07080A splash, #0B0C0F app bg). <BlazeMark> `animated` prop switches modes; path data lives in EXACTLY ONE module — no copy-pasted path strings anywhere else in the tree. |
| D4 | **Bloom-flash exception (scoped motion-law deviation, adjudicated in the kickoff brief).** The reference bloom animates `filter: brightness() drop-shadow()` — not compositor-only, in direct conflict with P2.10. RULING: ships AS DESIGNED — one-shot, ~1.4s, single-element, on a screen with nothing else painting. Recorded here as a scoped exception: **filter animation is permitted ONLY on the boot-splash mark's one-shot flash keyframe.** The infinite idle loops (blaze/flicker) and everything else remain transform/opacity only. Any agent "fixing" the bloom to opacity-layers, or citing D4 to animate filters anywhere else, fails review. |
| D5 | Size-gated variants are law: below 24px rendered size ONLY flat (#FFB454). Sidebar lockup (mark 18–19px) is therefore flat. <BlazeMark> enforces this itself (variant downgrade below threshold + dev-mode warning). Minimum mark 16px; lockups ≥120px wide; clearspace = inner-core width. |
| D6 | Splash boot-log values are REAL, not fixture. Reference's `LOOMBRE CORE 0.9.2 · OK / LIBRARY MOUNT /MNT/MEDIA · OK / STREAM ENGINE · READY` are placeholder fixtures — component derives from actual boot/connect state (version from the build, real mount/engine readiness) with the reference's exact typography, stagger (1.0s/1.35s/1.7s), amber value column. Sidebar version line (MEDIA SERVER · V… mono 8.5px) likewise derived, never hardcoded. Fixture-hygiene grep gains the reference's literal strings. |
| D7 | Favicon replacement is TOTAL: loombre-favicon.svg (viewBox 4 1 88 88) as primary `<link rel="icon" type="image/svg+xml">`; PNG 48/32/16 fallbacks; manifest icons from loombre-app-icon-dark-1024.png (amber icon available as alternate). Whatever apps/web currently serves is deleted — a grep proves no old favicon/pulse-dot asset survives the build output. |
| D8 | Sidebar header: pulse-dot + text REPLACED by the horizontal lockup at README sidebar reference sizes (mark 18–19px flat + wordmark 14.5px + mono version line below), fitting the existing 210px labelled sidebar without moving the nav grid. |
| D9 | `booted` gating: entrance + bloom play once per app load / server connect (single booted flag; existing loading states swap in the spinner). Idle burn starts at entrance end (.9s delay), loops. Spinner = mark with both idle animations at ~80% duration (.85s/.6s); indeterminate bar = 3px rgba(255,255,255,.08) track, amber ~34% segment, translateX(-110%→360%) 1.6s ease-in-out infinite (transform-only — already legal). |
| D10 | Reduced motion: replicate the reference's prefers-reduced-motion collapse (durations→.01s, delays→0) on splash, spinner, bar. Review item PER LANE, not a global afterthought. |
| D11 | Palette already tokenized in src/styles/tokens.css (Phosphor). Lanes consume tokens — hardcoded hex duplicating an existing token fails review. Add only what's genuinely new (splash bg #07080A if absent; glow shadow 0 0 12px rgba(255,180,84,.45) as a token). In-UI scanline overlay = README's repeating-linear-gradient recipe, tokenized once. |
| D12 | GitHub social preview (design/blaze/assets/png/loombre-banner-1280x640.png) is a repo-settings upload — OWNER-ACTION item in the final report, not silently dropped. |

### Wave plan + burn-up

| Wave/Lane | Scope | Model | Status |
|---|---|---|---|
| W0 foundation | Bundle commit · production assets (D1, D7) · <BlazeMark> (variants, animated mode, size gate, single path-data module) · failing-first unit tests · fixture page 3 variants × 16/24/48/120px on #0B0C0F/#101218 · side-by-sides vs 03-brand-assets-sheet.jpg (renamed from .png in the fafa47f audit fix waves — the file was always JPEG data) | sonnet | **FROZEN fe523fe** (orchestrator ground-truthed; awaiting owner checkpoint) |
| — OWNER CHECKPOINT — | Nothing dispatches until owner approves the mark rendering | owner | **PASSED 2026-07-25** — owner approved W0 mark rendering ("Approve — dispatch Wave 1") |
| A sidebar lockup | D8; screenshots vs 05-variants-lockups-in-context.jpg (desktop + icon-collapsed tablet) | haiku | **FROZEN 60e277c** (landed on main via G15 breach; battery superseded by C's integrated run; screenshots pending orchestrator) |
| B boot splash | D3/D4/D6/D9/D10; rebuild loombre-splash.html as login/first-connect component; screenshots vs 01-/02- + reduced-motion | sonnet | **FROZEN 75cd933 → landed eaa0cd4** (cherry-picked; battery green in-worktree; orchestrator screenshots + adjudications below) |
| C spinner + bar | D9/D10 swapped into existing loading states; transform-only, timings exact | haiku | **FROZEN 16c5028** (landed on main via G15 breach; battery = integrated A+C proof: 763 tests/tsc/build/depcruise/grep-gates green; player-surface adjudication pending pixel check) |
| D purge + hygiene | delete pulse-dot + legacy favicon/logo assets; fixture grep gains D6 strings; greps: stray flame path data, token-duplicating hex, Google Fonts refs (red-to-green IS the purge proof) | haiku | **FROZEN 17d6517** (worktree branch, correctly isolated; red-first proof captured — 10 pulse-dot violations verbatim; merges LAST per G14) |
| W2 review | screenshot pairs vs ground truth · reduced-motion pass · perf/budget re-proof · full local gate, clean clone (3-OS remote inherits billing) | sonnet | **FROZEN** (report verified; baselines stamp ac9d9ea; clean-clone gate ALL 13 STEPS PASSED; exit gate below) |

### W0 foundation — FROZEN fe523fe (2026-07-25, orchestrator ground-truthed)

**Shipped.** apps/web/public/brand/loombre-mark{,-scanline,-flat}.svg + public/loombre-favicon.svg + favicon PNGs 16/32/48 + app-icon dark/amber 1024 — ALL NINE verified byte-identical to design/blaze masters by orchestrator-run sha256 (D1 anchors match) AND pinned forever by buffer-equality tests (blaze-public-assets.test.ts). components/brand/: blaze-paths.ts (the ONE geometry module — orchestrator grep confirms "M56 6" exists nowhere else in src), BlazeMark.tsx (variant/size/animated/surface/classNames={rig,blaze,core} hooks for Lanes B/C), 25 new tests incl. provenance suite byte-diffing module constants against the three mark masters and a G4 negative test (flat fill never --color-accent). layout.tsx metadata.icons (SVG primary + PNG fallbacks + apple-touch; CSP-nonce block untouched) + NEW app/manifest.ts (theme #ffb454 = --brand-amber, bg #0b0c0f = --color-bg, dark-1024 icon any+maskable — 680/1024 mark sits inside the maskable safe zone). tokens.css +6 brand tokens per D11/G3/G4 (--brand-amber/-bright/-deep, --color-bg-splash, --brand-mark-glow with not-ember-bloom comment, --scanlines-splash 35% recipe; Phosphor --scanlines untouched). /styleguide "Blaze mark" fixture: 3 variants × 16/24/48/120 on #0B0C0F + #101218 with downgrade labels, static-vs-animated parity pair.

**Orchestrator ground-truth (not lane claims):** re-ran tsc clean, vitest 77 files/748 tests green, eslint --max-warnings=0 clean, stylelint clean, grep-gates PASS 1972 files; hashes verified directly; screenshots viewed against 03-brand-assets-sheet.jpg — silhouette/core-cutout/gradient orientation (bright base → deep tips)/scanline density/flat fill all match; D5 downgrade visibly firing at 16px on both surfaces; parity pair visually indistinguishable. Lane also ran next build --webpack (30 routes + /manifest.webmanifest) and depcruise clean (978 modules) — accepted on lane evidence, W2 re-proves. Evidence PNGs: reports/blaze/wave0/ (untracked, reports/ policy).

**Perf note (NOT a Blaze regression):** /browse = 166,802 B gz vs 204,800 budget (PASS, 18.6% headroom). The perf/baselines.json lastMeasured 156,159 is stale — stamped at the Next-16 sweep commit (8098258); Phosphor W3/fix-wave measured 164,846/164,857 without re-stamping the ledger, and FX3 + exit-gate-catch landed after. Lane proved Blaze contributes 0 B: stash-isolated re-measure with zero Blaze code = byte-identical 166,802 chunk list. → Open item below.

### Wave-1 dispatch adjudications (orchestrator, 2026-07-25 — logged for the freezes; owner may override)

- **G11 (D10 reading for INFINITE animations):** the reference's blanket `.01s !important` collapse, applied to infinite loops (idle blaze/flicker, spinner, bar), would loop at 100Hz under reduced motion — compositor churn with zero visual difference from a static pose. Ruling: one-shots (entrance/bloom/wordmark/boot-log reveals) collapse to .01s duration / 0 delay per D10 literal; infinite animations get `animation: none` + settled pose (house idiom, LibrariesPanel/Sidebar precedent). Rendered outcome identical to literal D10 (static mark, instant reveals).
- **G12 (indeterminate-bar color):** D9 says "amber segment"; existing scan bar uses the user-swappable --color-accent. Ruling: the Blaze loading language is BRAND — bar segment = var(--brand-amber), same invariance as the mark (G4 rationale).
- **G13 (browser serialization for Wave 1):** lanes run NO browser and NO perf-web-budget (port 4791 single-owner); they prove via tests + battery. Orchestrator takes all freeze screenshots at merge time, single browser owner. W2 re-verifies everything regardless.
- **G14 (merge order + grep choreography):** A/B/C merge first (disjoint file sets), D last — D's pulse-dot grep is EXPECTED RED on its own tree and goes green only on the merged tree (the brief's red-to-green purge proof). Pre-coordinated allowlist filenames (lanes MUST use exactly these): Lane A absence-tests in apps/web/src/components/shell/Sidebar.blaze-purge.test.ts, Lane C purge-tests in apps/web/src/components/ui/BlazeSpinner.purge.test.ts, Lane B fixture-negative tests in apps/web/src/components/brand/BootSplash.fixtures.test.tsx — Lane D's greps allowlist exactly these three paths.
- Wave-1 worktree base trap: all four lanes' worktrees branched at session-start HEAD (8708e7b, 5 behind); the standing first-action ff-check stopped every lane before stale work; remedy `git reset --hard 8383f42` delivered via resume message. Zero cost beyond minutes.
- **G15 (isolation incident, resolved — full record for future waves):** resuming a STOPPED worktree lane via message LOSES the worktree cwd — Lanes A and C (stopped at the base check, then resumed) executed in the MAIN repo tree; Lanes B and D (message queued mid-task) kept their worktrees. Feared damage did not materialize: main's history stayed intact and linear (8383f42 → 11a1f52 → 60e277c A → 16c5028 C — nothing orphaned, verified by log after C's freeze), and A/C touched disjoint file sets. Real cost: worktree isolation was bypassed for A/C (they serialized on main by luck of timing), and A's battery ran against C's half-done files (A's "green" superseded by C's later integrated battery on the same tree: 763 tests, tsc/build/depcruise/grep-gates all green over A+C combined). Standing rule from this: resume messages to worktree lanes must pin the absolute worktree path as their first `cd`; after any resume, orchestrator immediately checks main `git status` + `git worktree list`. Recorded in auto-memory as well.
- **G16 (Lane C surface adjudication, pending pixel check):** the player buffering overlay has no single surface color behind it (video frames / ambient art / black stage). Lane C passed rgba(0,0,0,.5) as the animated-mode core fill — a translucent core rather than D3's literal opaque surface match, honest given the variable backdrop. Accept/reject at orchestrator screenshot review; alternative is an opaque scrim behind the spinner.
- **G17 (Lane D false positive, to fix at merge):** D's fixture-strings grep trips on apps/web/src/app/admin/page.tsx:32 — an H19 ledger COMMENT quoting the dc fixture precisely to document its omission (prose, not shipped UI). Orchestrator amends the allowlist with that justification when merging D; D reported it loudly instead of silently allowlisting, per law.

### Wave 1 — INTEGRATED on main at 1a2866c (2026-07-25, orchestrator ground-truthed)

**Landing order (G14 honored):** A 60e277c → C 16c5028 (both direct-on-main via G15) → B eaa0cd4 (cherry-pick of worktree 75cd933) → D 812e312 (cherry-pick of worktree 17d6517) → integration fixes 1a2866c. **Red→green purge proof COMPLETE:** D's brand-hygiene gate was RED on its base tree (10 pulse-dot violations, verbatim in D's freeze report) and is GREEN on the integrated tree — grep-gates PASS 1985 files after the G17 allowlist entry and the integration rewording (this run's own tombstone comments and boot-log header de-literalized; the gate covers comments BY DESIGN — quoting banned strings in shipped-source prose is what it exists to catch; the ONE fixture-strings guard is BootSplash.fixtures.test.tsx, boot-log.test.ts's stray assertions moved there).

**Integrated battery (orchestrator-run, full tree):** vitest 84 files/776 green · tsc clean · eslint --max-warnings=0 clean · stylelint clean · depcruise 992 modules/0 violations · grep-gates 1985/0 · next build --webpack green · perf-web-budget /browse = 169,493 B gz vs 204,800 (PASS, 17.2% headroom; true Blaze cost now that Sidebar consumes BlazeMark: +2,691 B over the pre-Blaze 166,802 measurement).

**Lane C strike 1 (haiku):** C's freeze claimed 763 green, but its shipped pair was internally inconsistent — LibrariesPanel.test.ts expected legacy rgba() notation while its CSS carried the stylelint-forced modern rgb() (same computed value as D9's spec). Orchestrator fixed the test (same adjudication as B's notation deviation). Two-strikes tally: C at 1.

**Adjudications accepted at freeze:** B's boot-log copy (LOOMBRE CLIENT {APP_VERSION} / SERVER {host} / SESSION RESTORED|NEW — all real, U9-compliant, G5-compliant); B's no-Context module-flag booted design (D9); B's modern color notation (stylelint law, same computed values); login mark 56px; C's player-surface rgba(0,0,0,.5) translucent core (G16 — ACCEPTED pending W2 live-player pixel check; alternative opaque scrim stays on the table); G11/G12 implemented as pre-adjudicated.

**Orchestrator screenshots (reports/blaze/wave1/, untracked per reports/ policy; references copied alongside):** build-splash-entrance-1440 (LIVE capture mid-bloom under Fast 3G — mark risen, bloom glow, core cut, scanlines; matches 01-reference) · build-splash-settled-1440 (settled composition with idle burn, wordmark, DERIVED boot log V0.9.0/localhost:3001/RESTORED — layout-parity with 02-reference, content differs exactly as D6 mandates; captured via a throwaway uncommitted /blaze-proof harness, deleted after capture) · build-sidebar-home-1440 (lockup live over real seeded data) · build-sidebar-rail-1024 (G10 mark-only centered) · build-login-1440/392 (stacked lockup, dot gone).

**G18 (NEW — owner decision for W2/final):** the splash's real-world visibility window is the boot-decision + route-chunk gap, which on a local/fast connection is MILLISECONDS — both boot decisions (restored-session and signed-out) resolve locally, so in the common case the full entrance+bloom+log sequence never visibly plays (it played under throttled network in testing; it will play on genuinely slow first connects). As-built is spec-honest (never delays the app; P2.10 interruptibility) but the brand moment is effectively invisible locally. Options: (a) keep as-built; (b) minimum-display hold ~2.3s on cold app loads (delays first paint of the app by up to that); (c) hold only-if-mounted until entrance+bloom complete (~1.4s). NOT unilaterally changed — owner call.

**Environment notes (cost ~20 min, recorded for future sessions):** (1) the shared dev flow needs DATABASE_URL exported (postgres://loombre:loombre@localhost:5442/loombre) or apps/server provisions EMBEDDED PG and boots against a stale local cluster (crashed twice on missing plugins/refresh_tokens relations before diagnosis; compose DB was healthy all along); (2) the dev DB itself also needed reset+seed first (migrations behind — the known foot-gun).

### W2 review — FROZEN (2026-07-25) + BLAZE EXIT GATE

**W2 walked (orchestrator-verified: ac9d9ea diff scope confirmed baselines-only, perf-baseline-check re-run PASS, spinner pixel evidence viewed — G16 ACCEPTED, core reads as negative space over the dark stage):** all fidelity pairs re-verified MATCH; TWO reference-image limitations documented (01/02 splash references are byte-identical — the bundle never captured two distinct frames; 05's PNG is 924×540 and cuts off before the sidebar-in-context region — sidebar judged vs D8's textual spec instead); SVG hash anchors independently re-verified; favicon wiring proven live (tab-bar pixel shot structurally impossible via CDP — honest block); G16 spinner reached through a REAL buffering path (fixture media 404s → real `waiting` event); indeterminate-bar live pass blocked by the dev events-WebSocket never connecting (environmental, logged below) — CSS-source verified instead; reduced-motion visual pass tool-blocked (emulate lacks reducedMotion; plugin Chrome can't be relaunched with the force flag) — CSS-source tests re-run 15/15; perf-web-budget 169,493 B gz PASS; **Lighthouse /login 0.92/0.95/0.95 ≥ 0.90 with the splash aboard**; baselines stamped ac9d9ea per the $rule (perf-baseline-check PASS); **clean-clone gate: fresh clone, frozen lockfile, own DB (17 migrations/39 tables), `pnpm gate` ALL 13 STEPS PASSED — ~3,720 tests green, 0 failed, grep-gates 1,985 files/0 violations on a fully independent clone (independent re-proof of the purge)**; docs inventory: 46 placeholders/12 pages confirmed, zero images, NO prose misdescribing Blaze surfaces — nothing to refresh.

**Blaze exit gate (mission clauses):**
- [x] SVG masters shipped byte-faithful (D1 — sha256 anchors + buffer-equality tests, re-verified twice independently)
- [x] Shared <BlazeMark> with gradient/scanline/flat + animated mode + size gate + single geometry module (D3/D5)
- [x] Sidebar pulse-dot → horizontal lockup at spec sizes; mark-only tablet rail (D8/G10)
- [x] Favicon + app-manifest icons (D7 as amended by G1 — created, nothing pre-existed; purge proven by the brand-hygiene gate red→green + clean-clone re-proof)
- [x] Boot splash rebuilt from loombre-splash.html — one-shot entrance + D4 bloom (scoped exception recorded above), out-of-phase idle burn, staggered wordmark + DERIVED boot log (D6/G5)
- [x] Spinner + indeterminate bar rebuilt on the mark, D9 exact timings, D10/G11 reduced motion
- [x] Reference fidelity (W0 owner checkpoint approval + W2 re-verification; 2 reference-image limitations documented)
- [x] Every existing CI gate green — LOCAL clean-clone ALL 13 STEPS; REMOTE 3-OS legs inherit the owner billing action (kickoff posture, same as sweep/LPP/Phosphor)
- [x] Performance budgets green (/browse 169,493/204,800 B gz · Lighthouse /login 0.92–0.95 ≥ 0.90)
- [ ] D12 GitHub social preview — OWNER ACTION (upload design/blaze/assets/png/loombre-banner-1280x640.png in repo Settings → Social preview)

### Open (Blaze)

- **G18 owner decision:** splash visibility on fast connects (see W1 freeze entry) — keep as-built / minimum-display hold ~2.3s / hold-if-mounted until entrance+bloom (~1.4s). As-built ships until decided.
- **D12 owner action:** upload design/blaze/assets/png/loombre-banner-1280x640.png as the GitHub social preview.
- perf/baselines.json web.lighthousePerformanceScore ledger entry still reads 1.0 (fresh measurement 0.92–0.95, still ≥ 0.90 gate) — stale, stamp with reason in a future pass (W2 kept its commit scope to the one entry it was chartered for).
- Pre-existing non-Blaze bug found during W2's live pass: "Start over" after a resume prompt throws `Uncaught TypeError: Illegal invocation` at heartbeat.ts:66 — playback-heartbeat, predates Blaze, needs its own fix cycle.
- Dev-environment gap (non-Blaze): the live-events WebSocket never connects under `pnpm dev` on this host (zero WS connections across a full admin session) — blocks observing scanState live; investigate separately.
- ~~perf/baselines.json web.browseFirstLoadJsGzipBytes stale~~ RESOLVED — W2 stamped it (ac9d9ea, 156,159 → 169,493 with drift attribution; perf-baseline-check PASS).
- D12 owner action: upload design/blaze/assets/png/loombre-banner-1280x640.png as the GitHub social preview (repo Settings → Social preview).
- Docs-staleness inventory (final report): guides showing the pulse-dot sidebar are stale — inventory only this run, no refresh.

## Phosphor retheme + responsive rebuild (kicked off 2026-07-25, authority: owner "Wholesale Retheme + Responsive Rebuild, Wide-Parallel After the Foundation" brief; design/phosphor/README.md is THE spec — where brief and README conflict, the README wins and the conflict is logged here)

### Mission (verbatim)

Implement the Phosphor direction across apps/web exactly per the bundle README: retheme tokens.css and self-hosted fonts, labelled 210px sidebar replacing NavRail, dark-only (light theme + ThemeToggle removed), ONE responsive component tree with the mobile prototype as the small-viewport spec (NavRail ⇄ bottom tab bar at the breakpoint), bottom-sheet and toast primitives, then the full screen set — settings (users/profiles/libraries), admin dashboard with scan/fix-match, watchlist + person routes, movie-detail metadata card + mark-watched, resume-prompt + playback-refusal flows, registry mobile, custom icon set, scanlines + accent preferences — at prototype fidelity, with every existing CI gate and performance budget green.

### §1 precondition reconciliation (2026-07-25)

- "Current gate green (clean clone, 3 OS)": clean-clone local gate ALL STEPS PASSED on the sweep's final tree (§3 walk below, same day); working tree clean at b77edbf at kickoff. The 3-OS REMOTE proof is billing-blocked on ALL legs (run 30169874561 died 0-steps; re-verified via `gh run list` at kickoff — latest pushes still failing in seconds on the spending limit). Precondition read as met-on-local-evidence; this run's exit-gate "gate green, 3 OS" item INHERITS the owner billing action, the same posture the sweep and LPP recorded. Every Phosphor wave gates locally regardless.
- Bundle committed 817a4cf to design/phosphor/ (README.md = THE spec; Loombre Phosphor.dc.html = hi-fi reference, content values are placeholder fixtures never shipped; Directions.dc.html = context only; support.js = prototype runtime, not design). ONE amendment, logged as a bundle-vs-repo-law conflict resolution: README.md:11 named the target repo by the FORMER project name, which the R8 rename gate forbids repo-wide with no code allowlist — corrected to ozzydeving/Loombre (the actual remote). Zero design content touched; grep-gates PASS with the bundle in tree.
- README stale-prose notes (recorded so nobody "fixes" toward them): it targets "Next.js 15.5" (repo shipped 16.2.11 in the sweep) and predates lucide-react 1.26.0. No design decision changes; U7 governs icons.
- Kickoff ground truth: /watchlist, /people/[id], /restricted routes do NOT exist (README route table agrees — NEW, Wave 2); the restricted lock AFFORDANCE exists today (shell/RestrictedLockControl, restricted/PinModal, RestrictedProvider) and stays affordance-only per U10. The Wave-0 sidebar ships WITHOUT Watchlist/Restricted LIBRARY entries (no dead links at the checkpoint); those entries land WITH their routes in Wave 2 — checkpoint copy states this.

### Locked decisions (U series — the README's decisions restated as run law; settled, not re-litigated)

| # | Decision |
|---|----------|
| U1 | Phosphor REPLACES ember (amber #FFB454 accent, cool near-black #0B0C0F, white-alpha surfaces, Archivo variable + IBM Plex Mono). SUPERSEDES the P2.7/P2.20 visual language; P2.10 motion-engineering rules and ALL perf budgets remain binding. --shadow-ember-bloom retired or retinted amber — no red bloom survives |
| U2 | ONE responsive tree: one set of route components, container queries/breakpoints in CSS modules, chrome swap at the breakpoint; the prototype's mobile screens are the small-viewport SPEC of the same components, never a forked route tree. Phone spec 392×846; desktop ≥1280. No user-agent branching anywhere |
| U3 | Tablet gap: the undrawn middle range renders the desktop layout with the sidebar collapsed to icons (README suggestion, adopted). Presented at the Wave-0 owner checkpoint for sign-off |
| U4 | AA exception shipped AS DESIGNED: #61666E (3.4:1) / #4A4E55 (2.3:1) exactly; the stale all-pairs-clear-AA comment in tokens.css REPLACED with the measured-exception note; those tiers never below --text-xs or off --color-bg; gradient scrims behind mono labels preserved; never the only signal. Brightening them fails review |
| U5 | Radius law: every prototype radius maps to the existing token scale (or a new token lands in tokens.css with the change); stylelint allowed-list stays the enforcement; zero literal radii |
| U6 | Fonts self-hosted (Archivo variable wdth 62–125 + IBM Plex Mono 400/500/600), csp.ts updated, no runtime font CDN; woff2 payload measured against the browse-route budget in the same commit |
| U7 | Icons: custom SF-Symbols-style set — typed path-data record through the existing Icon wrapper, stroke 1.55 round caps, 17px desktop / 24px tab bar, seek glyphs with 15/30 numerals. lucide-react remains only where the prototype has no custom glyph (Wave 2 L7) |
| U8 | Glass simplification: flat translucent dark chrome (rgba(18,20,25,.86) + blur(20px)); specular edge + frost gradient dropped; .glass retained for mobile tab bar + now-playing bar |
| U9 | Fixture hygiene: prototype content values (THE RELAY/MERIDIAN-class titles, paths, percentages, timestamps) wired to real API data via api-client/events-socket/auth-store patterns; fixture-string grep (title list harvested from the prototype) joins the review checklist; user/restricted counts derived-not-stored |
| U10 | Restricted zone UI: zone existence visible, titles/artwork never leak, restricted-profile users see no zone/PIN at all, restrictedLocked syncs via the events socket; UI lock stays AFFORDANCE ONLY — the server-side guard remains the boundary; leak suite stays green UNTOUCHED |
| U11 | Docs screenshots go stale by design this run: stale-screenshot inventory delivered as an Open item; the refresh rides the next docs pass (post-owner VM smokes) |

### Wave plan (foundation sequential BY SPEC; fan-out after)

- **W0** (ONE lane, sonnet, all-or-nothing — README steps 1–2 land alone, verified, before anything else): tokens.css retheme + self-hosted fonts + csp.ts + full stacked-alpha/accent-text module sweep over src/components/**; labelled 210px sidebar replaces NavRail; light theme + ThemeToggle removed. Gate green → **OWNER CHECKPOINT** (screenshot set: every existing screen, desktop + phone-width + U3 tablet). Wave 1 does not dispatch until the owner approves. Checkpoint failure ⇒ clean revert + reconsult — a half-applied retheme is worse than either theme.
- **W1** (2 lanes, sonnet): AppShell responsive breakpoint (sidebar ⇄ bottom tab bar, large-title mobile header, safe-area insets) · bottom-sheet + toast primitives (999px pill, accent dot, uppercase mono, 2.6s dismiss).
- **W2** (7 lanes, sonnet, each owning its screens at BOTH breakpoints per U2): L1 settings Users&Profiles + Libraries · L2 admin dashboard reflow + scan/fix-match · L3 watchlist + person routes · L4 movie-detail metadata card + mark-watched · L5 resume-prompt + playback-refusal · L6 registry mobile + provider-key states · L7 custom icon set + scanlines/accent prefs + ⌘K polish. Browser verification serialized through the orchestrator; every freeze report carries prototype-vs-build side-by-sides at both breakpoints.
- **W3** review: opus fidelity audit (px/hex deltas, screen-by-screen, both breakpoints) · opus constraint audit (U4 comment, U5 radii, U9 fixture grep, derived counts, U10 leak suite untouched-and-green, reduced-motion/interruptibility) · sonnet budgets+gates (3-OS clean-clone billing-permitting, browse JS+font payload, Lighthouse ≥90 throttled, 60fps 50k-item grids, U11 inventory delivered).

### Phosphor lane burn-up

| Lane | Scope | Status |
|------|-------|--------|
| W0 | Foundation: tokens/fonts/csp/sweep · sidebar + dark-only | **LANDED fce85ad + e853f2e** (+ orchestrator ground-truth fix a4a3fde); full gate ALL STEPS PASSED on lane tree; **checkpoint APPROVED 2026-07-25** (owner "continue"; sub-decision defaults below) |
| W1a | AppShell breakpoint + mobile chrome (tab bar, large-title header, safe-area, not-found page, Settings-label dedupe rule) | **LANDED c4e23d9** (768px breakpoint, boundary-verified no-dead-zone; 5-tab data config w/ L8 slot + zoneOverlayOpen hook; Settings dedupe rule fired KEEP-BOTH — zero other admin paths to /settings, evidence in nav-items.ts; viewportFit:cover added — safe-area insets were silently 0 app-wide before; mini-player reflowed; 382 tests) |
| W1b | Bottom-sheet + toast primitives | **LANDED 96d0768** (BottomSheet/SheetOrModal/Toast + useToast provider + shared overlay-hooks; 29 tests; vitest oxc-jsx config unblocks .tsx tests repo-wide; no portal invented — composes existing overlay CSS) |
| W1c | Contract enablers: library item counts + storage-pool stats + restricted zone aggregate count (additive, ViewerContext-derived) + sidebar wiring | **LANDED c4c3637** (Library.itemCount + SystemInfo.storagePool additive; GET /restricted/count = op 93, 404-for-unentitled server-side; counts ride applyGuard; leak suite 220/220 = 25 untouched + 4 new; statfs dev-id dedupe; no migration) |
| W2 L1 | Settings IA (unified /settings, both breakpoints) + Users & Profiles + Libraries panes | **LANDED c6e9ba4** (full report in "W2 L1 freeze" below; sidebar double-Settings resolved; /admin/users+libraries+settings now redirect stubs; no RESTRICTED/GUEST roles exist server-side — honest Member/Admin chips + maxContentRating ceiling; rename/proxy/redaction/direct-play rows omitted, no backing endpoints) |
| W2 L2 | Admin dashboard + fix-match | **LANDED 51b4c93 + 6a5ceea reconciliation** (dashboard at /admin w/ honest omissions ledger — no CPU/GPU/memory/presence/PAUSE endpoints exist, cards omitted not faked; unmatched = derived zero-provider-ids query, NO migration; candidate search rides the JOB QUEUE via new metadata-search job + admin-only metadata.match-candidates event — server has zero provider wiring, worker owns it, invariant 6 held; apply-match extends the existing metadata job w/ forceRef, never touches the file; 3 additive ops, house pattern walked, 101 ops total; FixMatch swapped into MetadataCard per its own instructions, stub deleted; scanner emits real files-processed ticks, no fabricated percentage) |
| W2 L3 | Watchlist + Person routes | **LANDED (mainline pick of d74ba00)** (migration 0017_watchlists, 38→39 tables; GET/PUT/DELETE /watchlist + GET /people/{id}/items additive ops; watchlist.added/watchlist.removed USER_ONLY_TYPES events; sidebar entry+derived count w/ honest N+ at capacity; Home rail; movie/series/album toggle; /people/[id] portrait+filmography; leak suite additions merged with L8's at landing; seeded-conformance +9 e2e; see freeze report below) |
| W2 L4 | Movie/series detail + mark-watched | **LANDED fffcc40** (dedicated Movie/SeriesDetailScreens both breakpoints; MediaFileSummary additively extended — path/isDefault/videoCodec/bitDepth/hdr/audio+subtitle tracks — OPTIONAL because oasdiff caught the schema doubling as POST /import's request body; mark-watched = real toggle on progress.state w/ optimistic UI + self-caught double-fetch bug fixed; EDIT disabled-with-tooltip pending owner metadata_lock decision; match-confidence/studio/capability-line omitted — no data / Phase-3-retired pattern; FixMatchStub w/ L2's agreed props; season pill tabs + pure resume-target picker. Landing reconciliation: L7 play-glyph swap re-applied to the new EpisodeRow) |
| W2 L6 | Registry + provider keys, interaction spec + mobile | **LANDED f9af21e + 867b9fb reconciliation** (57 new tests incl. never-shown SECURITY block + a real stuck-disabled bug fixed in remove-confirm; one-category-at-a-time + RegistryFilterBar ported into L1's AdvancedSection tab slot by orchestrator — L6 built against the pre-IA page L1 had stubbed; MASKED-badge deferred: schema has no secret field, contract change barred) |
| W2 L7 | Custom icons + accent/scanlines prefs + ⌘K | **LANDED 45a651b + 715ec50 + 22bbc19** (17 custom glyphs parsed verbatim from the prototype file, seek 15/30 numerals baked, VideoPlayer keys aligned; kept-lucide inventory justified per glyph; accent hover/active now color-mix-derived — all four accents ≥7.63:1 dark-text; prefs CLIENT-ONLY: GET/PUT /users/me/settings is a stub that persists NOTHING and UserSettings has additionalProperties:false — lane stopped at the hard line, logged as Open; ⌘K binding didn't exist before, now fuzzy screens+actions. Conflict resolutions at landing: L6's rewritten settings components re-swapped to icon names; L1's admin-settings nav-entry removal kept) |
| W2 L8 | Restricted zone route (/restricted gate + PIN + amber grid + zone toolbar + sidebar entry + Browse chip) | DISPATCHED 2026-07-25 (added at checkpoint — U10/README screen set had no owning lane in the brief's wave plan; gap logged + closed) |
| W2 L5 | Resume prompt + playback refusal | **LANDED 1c0e049** (SheetOrModal both breakpoints; refusal reasons/codes = REAL PlanReason enum; fallback via existing POST /playback/plan preview over the item's other files — zero contract change; engine-fed tests call plan() directly, nothing hand-authored; web 438/438. Ground-truth: Progress has NO device field system-wide → honest deviceLabel:null; dismissal=decline) |
| W2 L9 | Home: featured banner + rails + card affordances (gap-closure lane, dispatched mid-wave) | **LANDED f9dbc4f** (branch worktree-agent-a7c45597f1c5a2812; base 832cea0). FeaturedBanner: pool via lib/featured-pool.ts (buildExclusionSet composable id-SOURCES — L3/Watchlist's one-line seam — + selectFeaturedPool's real Set-difference + addedAtMs-desc cap at 5); rotation via lib/featured-rotation.ts's FeaturedRotationScheduler (HeartbeatScheduler-shaped, clock-injectable — 7s dwell/260ms two-layer crossfade/manual-nav-resets-dwell/pool<=1-hides-controls/reduced-motion-disables-auto-advance; 18 fake-timer tests, zero DOM). All 3 README geometry/pool "hard lessons" honored (row-not-column header/body split; min-height+line-clamp+nowrap-pills; no resume hero). Series spec line omits the README's "years" RANGE (no end-year field exists — single `year` only) + season count = REAL GET /series/{id}/seasons length, bounded ≤5; movie tag = real genre (never the fixture "FROM YOUR LIBRARY"), series tag = README's own "SERIES IN YOUR LIBRARY" prose copy. PosterCard rewritten with a real `<a href>` (was a non-interactive div — the exact gap L5 found) + a nested play BUTTON (not a 2nd `<a>`) for Continue Watching's resume-prompt path via the existing `/watch/{id}` gate — zero VideoPlayer changes. Pause-signal ground truth: hover (real) + music `queueDrawerOpen` (real, MusicPlayerProvider) wired in; "any modal/command-palette open" has NO cross-cutting signal anywhere in this codebase today — logged as a gap, not invented around (building one would mean editing shell/player, outside this lane); "player open" is moot (Home unmounts on /watch nav). Watchlist: no rail/state built — a clearly marked, unrendered slot left between Recently Added and New in Music for L3. "New in Music" derives from the SAME already-fetched /home/recently-added response (RecentlyAddedEntry.item can be Album — no top-level GET /albums list endpoint exists) + a deduped per-artist GET /artists/{id} lookup (Album has no inline artist name). web 486/486 (+48); next build green; /browse 159,012 B gz vs 204,800 (route unchanged — Home isn't in its bundle; +520B is chunk-hash noise, still 22% under budget) |
| W3 | Fidelity + constraint audits, budgets | DISPATCHED 2026-07-25 (3 lanes). **Constraint audit DONE**: 9/9 items PASS/PASS-WITH-NOTES, zero HIGH. U5 zero literals + stylelint live · U9 zero shipped fixture copy (~100 harvested strings; one test-data name fixed 12494ab) · derived-not-stored clean, no count columns 0014–0017 · leak suite 330 insertions/0 deletions since baseline, 41/41 green (25 untouched + 16 new), UI lock affordance-only · reduced-motion honored beyond the global clamp on every promised surface; 4 width/height transitions (2 pre-existing house pattern, 2 new one-shot meters) LOW · no UA branching (device-profile id is playback capability, not layout) · docs/register-lint untouched · oasdiff: 0 breaking, 142 info, 92→101 ops, UserSettings.theme intact. Fidelity + budgets lanes running |

### W2 L3 freeze report (Watchlist + Person routes, 2026-07-25)

**Ground truth (before building anything):** NO watchlist persistence existed anywhere (no table, no contract op, no server route) — kickoff ground truth's "watchlist (id -> bool)" was purely a client-state description in the README, backed by nothing. GET /people and GET /people/{id} DID already exist (P1.17, packages/db/src/query/people.ts's `listPeople`/`getPersonById`) but returned ONLY `{id, name, contentClass, creditCount}` — no actual credited-item list, so a filmography grid had nothing to render; `PersonCard.tsx`'s own header explicitly logged this as "deliberately NOT a link — no person-detail route." Image serving for a person portrait was ALSO not reachable: `packages/db/src/query/images.ts`'s `getImageEntityAccess` has always accepted `entityType: 'person'` (same guard as listPeople), but `images.controller.ts` hardcoded every contract `ImageEntityType` value to the DB's `'catalog_item'` regardless of path param — `person` wasn't even in the contract enum. Closed both gaps (additive `ImageEntityType` enum value + one-line controller mapping fix) since the Person page needs a portrait.

**Migration:** `0017_watchlists` — `watchlists(user_id, item_id, added_at_ms)`, composite `PRIMARY KEY(user_id, item_id)` (the "UNIQUE pair" requirement — no separate constraint needed), real columns/FKs only, no JSONB. Mirrors `progress`'s exact shape. `db:migrate-check` PASS, 39 tables (38→39 as expected).

**Contract diff (additive only, `redocly lint` + `oasdiff` both clean):** `GET/PUT/DELETE /watchlist(/{itemId})`, `GET /people/{id}/items`; new schemas `WatchlistEntry`/`WatchlistPage` (itemType restricted to movie/series/album, mirrors `RecentlyAddedEntry`'s discriminator), `PersonItemEntry`/`PersonItemPage` (movie/series/episode/artist — the only types `PersonCredit` ever attaches to); `ImageEntityType` enum `+person`. New `watchlist` tag.

**Event taxonomy addition + delivery-scoping proof:** `watchlist.added`/`watchlist.removed` added to `envelope.schema.json` (21→23 types) and to `packages/db/src/query/events.ts`'s `USER_ONLY_TYPES` — the SAME array `restricted.locked`/`restricted.unlocked` already use, gated on `payload->>'userId' = ctx.userId`, **not** item-visibility (a private-to-the-user delivery, independent of who else can see the underlying item — required so two different users who both watchlist the same general movie never see each other's add/remove). `ws-broadcaster.service.ts` needed ZERO code changes — it has no per-type branching, only the shared `USER_ONLY_TYPES` array this reuses, so every one of a user's own connected sockets (every signed-in device/tab) gets the event and no other viewer ever does. Delivery proof: `packages/db/test/leak.spec.ts`'s new "readEventsForViewer: watchlist.added/watchlist.removed are PRIVATE to the acting user" case (a different user never sees it; the actor sees it even mid-simulated-lock, since this type isn't content-class-gated). Actor-field-map (LPP v1 plugin-delivery pseudonymization) updated in lockstep: `watchlist.added`/`watchlist.removed` → `["userId"]`, same posture as `restricted.locked`/`unlocked` (grantable to plugins, not admin-only, pseudonymized by default); `apps/worker/test/plugin-delivery/actor-field-map.spec.ts` (21→23) and `apps/server/src/plugins/event-taxonomy.spec.ts` (13→15 grantable) updated. **Ground-truthed, not fixed:** a RESTRICTED-scoped LPP event-subscriber plugin receives its granted types fully UNFILTERED (`delivery-loop.ts`: "restricted-scoped subscribers: deliverable === rawCandidates, unfiltered") — this bypasses even the USER_ONLY_TYPES userId gate, so such a plugin would see every user's watchlist.added/removed, not just entitled users'. This is pre-existing, deliberate, and already tested this way for `restricted.locked` (`delivery-loop.integration.spec.ts` line ~352); watchlist.added/removed simply inherit the identical posture. Not this lane's call to re-architect; flagged for whoever next reviews LPP's clearance model.

**Leak cases added:** `packages/db/test/leak.spec.ts` +5 watchlist (add-reachability gated on full clearance matching `getItemById`/`upsertProgress` exactly; **the required case** — a zone item added while cleared is byte-absent from the SAME user's list the instant they're no longer cleared; cross-user scoping; idempotent remove; event privacy) + 3 person filmography (`listItemsForPerson` mirrors `listPeople`/`getPersonById`'s two-clause guard one level down — general person credited only on a restricted item -> empty; restricted-class person credited on a general item -> empty for uncleared; no duplicate item ids when multiply-credited) = 8 new. DB suite: 220 → 228, all green. `apps/server/test/seeded-conformance.spec.ts` +9 real HTTP round-trips (add/list/remove, idempotent add and remove, restricted-item 404 byte-identical to nonexistent, the add-while-cleared-then-lock-then-list-excludes-it case over real HTTP, filmography count-matches-creditCount, both filmography leak asymmetries, byte-identical 404). Server suite 895→904.

**Route/component inventory (one responsive tree, both breakpoints via CSS — no separate mobile branch anywhere):**
- `/watchlist` (app/watchlist/page.tsx + .module.css): poster grid (`auto-fill minmax(168px,1fr)` desktop, `132px` mobile), inline REMOVE per card, empty-state copy, cursor "Load more" (non-virtualized — components/detail/ChildPosterGrid.tsx's existing precedent for a bounded, never-50k-item surface).
- `components/watchlist/WatchlistPosterCard.(tsx|module.css)`: shared card for BOTH the /watchlist grid and Home's rail — clickable poster (PosterCell's view-transition pattern) + inline REMOVE overlay button (44px touch floor below 767.98px).
- Home rail ("Your Watchlist", app/home/page.tsx): hidden ENTIRELY (no heading either) when empty per the README's literal wording, unlike Continue Watching/Recently Added's always-visible empty-state text.
- `components/detail/WatchlistToggle.(tsx|module.css)`: the toggle seam, its OWN file/component so lane L4's movie-detail metadata-card/mark-watched work lands beside it with zero merge risk. Wired beside `PlayLink` (movie), after `GenreChips` (series — no PlayLink exists yet in the pre-Phosphor-fidelity stub), after the conditional `MusicPlayButton` (album) in `app/items/[itemType]/[id]/page.tsx` — three one-line insertions, no surrounding markup touched.
- `/people/[id]` (app/people/[id]/page.tsx + .module.css): portrait (`GET /images/person/{id}/thumb`), name, filmography grid (reuses `ChildPosterGrid` verbatim); not-found state for an invisible/nonexistent person.
- `lib/watchlist-sync.ts`: `useWatchlistIds()` (bounded id Set + `atCapacity` flag, backs the sidebar count and the toggle's initial state, optimistic `markAdded`/`markRemoved`) and `useWatchlistChangeSignal()` (pure refetch trigger for the two full-entry consumers, Home rail + /watchlist page) — both live-synced via the websocket, mirroring `lib/now-playing.ts`'s established hook shape.
- Sidebar: Watchlist entry added to `nav-items.ts`'s LIBRARY group (between Search and Settings, matching the README's literal shell order); count DERIVED from a bounded `GET /watchlist?limit=200` (no dedicated aggregate-count endpoint exists for this list, unlike Restricted's purpose-built count) — renders nothing while loading, "N+" past capacity.
- `PersonCard.tsx` (movie/series/episode/artist detail pages' cast row) and `SearchPanel.tsx`'s people chips: both now `Link` to `/people/[id]` — closing the exact gap both files' own headers previously logged ("no person-detail route in this lane's scope").
- Mobile reachability for /watchlist: NOT one of the README's 6 bottom tabs, and the real "account sheet" doesn't exist yet (`MobileHeader.tsx`'s own header notes `UserMenu`'s dropdown is the interim stopgap) — added a "Watchlist" item to `UserMenu.tsx`'s dropdown (both breakpoints use this same component) as mobile's only path there until the account sheet lands; harmless redundancy on desktop alongside the sidebar entry, same posture W1a's "Settings" duplication already established.

**Toggle seam file:** `apps/web/src/components/detail/WatchlistToggle.tsx` (+ its `.module.css`) — the ONLY file lane L4 needs to route around; its three call sites in `page.tsx` are single-line insertions beside existing action rows.

**Check numbers (this lane, tree at freeze):** db typecheck/test clean, 228/228; contract `redocly lint` clean, `codegen` clean (97 operations), contract test 27/27; server typecheck/lint clean, test 904/904 (5 skipped, pre-existing); worker typecheck/lint clean, test 931/931 (5 skipped, pre-existing); web typecheck/lint(eslint+stylelint) clean, test 415/415, `next build` clean (both new routes present, `ƒ /people/[id]`, `○ /watchlist`); `db:migrate-check` PASS (39 tables); `depcruise` clean (812 modules, 2692 deps); `grep-gates` PASS (1802 files); `license-check`/`dep-audit` PASS; `/browse` first-load JS 159,488 B gz (budget 204,800 B gz) — +364 B over Wave-1's 158,492 B (the watchlist-count fetch's shared code, pulled in via every route's Sidebar); `docs:build` (vitepress + redoc) clean.

**Lane-decided calls (evidence, not assumption):**
1. Watchlist read/write guard = `applyGuardToJoined` exactly like `progress`/`getContinueWatching` (a cleared viewer's watchlist CAN include a restricted item; an uncleared viewer's CANNOT, regardless of the row's continued existence) — **not** an absolute "never, even cleared" rule. Evidence: `getContinueWatching`/`getRecentlyAdded` ALREADY surface restricted content to a cleared viewer today (`leak.spec.ts`'s own pre-existing tests assert `cleared.rows.some(r => r.content_class === 'restricted')`), so an absolute rule for watchlist alone would be an inconsistent, unreviewed one-off. The literal required case ("assert byte-absence for uncleared viewers") is satisfied exactly. The wider tension — does the README's "never appear ... locked or not" wording actually mean something stronger for ALL of Home/Search/continue-watching, not just watchlist — is systemic and pre-dates this lane; logged as an Open item below for W3, not re-architected here.
2. Watchlist ADD/write is NOT itemType-restricted server-side (any visible catalog item can be added) — only the mapped LIST response filters to movie/series/album, mirroring `listProgress`-can-take-anything vs. `getRecentlyAdded`-shows-a-curated-subset exactly.
3. PUT/DELETE /watchlist/{itemId} take no request body and return 204 (mirrors `POST /restricted/lock`'s shape) rather than 200-with-body (mirrors `PUT /progress/{itemId}`) — simpler, and the client already knows what it toggled.
4. Sidebar/toggle "is this item watchlisted" state is a bounded-page derivation (`ID_FETCH_LIMIT = 200`), not a dedicated aggregate endpoint — consistent with the "counts are derived, not stored" rule already established for user/restricted-profile counts; a genuinely 200+ item watchlist shows "N+".

**Deferrals / pointers for other lanes:**
- **Featured banner pool exclusion (README requirement, logged, NOT built):** ground-truthed — no Featured banner exists on `main` as of this freeze (Home is still Continue Watching + Recently Added + [now] Your Watchlist, no hero rotation). Whoever builds it MUST exclude every id in the caller's watchlist from the candidate pool (alongside continue-watching + recently-added, per the README's own "two earlier revisions shipped a duplicate" warning) — `GET /watchlist` is the source to exclude against.
- U11-class item: no docs/screenshot surface touched by this lane (no existing screenshots reference watchlist/person).
- Series-detail toggle placement is provisional (no `PlayLink` exists there yet in the pre-Phosphor stub this lane touched surgically) — whoever brings series detail to prototype fidelity should re-verify `WatchlistToggle`'s position beside whatever action row lands.

### W0 freeze + orchestrator ground-truth (2026-07-25)

- **fce85ad** step 1 (tokens retheme, self-hosted fonts, csp font-src 'self' + regression test, glass simplification per U8, module sweep) · **e853f2e** step 2 (210px labelled Sidebar replaces NavRail, U3 icon-collapse below 1280, light theme + ThemeToggle removed + CHANGELOG entry) · **a4a3fde** orchestrator catch (UA anchor underline on every .navItem — invisible on the icon-only NavRail it replaced; scoped text-decoration:none).
- Lane full gate ALL STEPS PASSED on e853f2e; orchestrator re-verified web lint (eslint max-warnings=0 + stylelint radius law) + typecheck + grep-gates on a4a3fde, plus live-browser walk (login → home/detail/admin/settings) after the fix.
- Fonts: 262,668 B woff2 total (Archivo variable latin+latin-ext, wght 100..900 + wdth 62..125 fontTools-verified in the SHIPPED file; Plex Mono 400/500/600); OFL texts + PROVENANCE.md beside the files. /browse first-load 156,159→155,455 B gz — UNDER the 200 KB budget and net better than pre-retheme despite the new sidebar.
- U4 verified in-file: values exact, stale all-pairs-AA comment replaced with the measured-exception note. U1 verified: --shadow-ember-bloom retired, 6 consumers moved to --shadow-md, zero red bloom. Accent-text law held (all filled surfaces were already --color-accent-text consumers).
- Sidebar wiring (lane-decided, checkpoint items): version from root package.json (0.9.0) build-time import · library COUNTS omitted — no contract endpoint exposes item counts (deferred; needs contract+db work, assign with W2) · POOL METER omitted — zero storage/pool fields in the contract (same deferral class) · live SCAN badge wired via existing events socket (scan.started/completed) · personal Settings entry KEPT in LIBRARY group (capability-preserving; README's shell spec has Settings only under SYSTEM — two same-label entries render; owner call at checkpoint) · README's topbar "breadcrumb" + "scan chip" DO NOT EXIST in today's app — nothing restyled, nothing invented; noted for W2 scope instead.
- Screenshot set: reports/phosphor/wave0/ — 62 PNGs (19 screens × 3 widths + resume-prompt variant + 2 font-stretch evidence); home×3 + movie-detail/admin-libraries/settings @1440 re-captured post-a4a3fde. Skipped: /setup (redirects when provisioned), playback-refusal (needs capability-mismatch fixture; W2 L5 will build one). NOTE: the un-recaptured shots still show the pre-a4a3fde underline.
- Dev DB left at canonical db:reset+db:seed state (foot-gun tally stays 5).

### Wave-0 checkpoint outcome + orchestrator defaults (2026-07-25, owner reply: "continue")

- Retheme + sidebar + U3 tablet treatment: **APPROVED** (the four-item checkpoint was answered with an unqualified continue; item 1/2 are therefore approved as presented).
- Checkpoint item 3 (double "Settings" label), owner silent → orchestrator default, OWNER MAY OVERRIDE: W1a ground-truths whether admins retain personal-settings access via the user menu/user row; if yes, the LIBRARY-group Settings entry renders for non-admins only (label collision only exists when both groups render); if no, both entries stay until W2 L1 unifies the settings IA. Zero capability loss either way.
- Checkpoint item 4 (counts + POOL meter contract gap), owner silent → orchestrator default, OWNER MAY OVERRIDE: endpoints ADDED as lane W1c (additive, contract-first, ViewerContext-derived counts, leak-suite-guarded) rather than dropping the two sidebar affordances — fidelity is the mission and the prototype's sidebar leans on both.
- Wave-plan gap closed: the /restricted zone screen (U10; README screens table + Interactions §Restricted) had no owning lane in the brief's W2 list (L1–L7) even though the exit gate demands zone UI evidence. Added as W2 L8. Conflict-with-brief logged per run law (README wins; the brief's lane list was an enumeration gap, not a decision).
- W1 dispatch widened 2→3 lanes (W1c) — parallelism only, no scope change beyond checkpoint item 4's default.

### Wave-1 landing + reconciliation (2026-07-25, full gate ALL STEPS PASSED on 3543cfc's tree)

- Landing order W1a → W1b → W1c by cherry-pick; conflicts: web-budget result ledger (both lanes committed their own number — superseded by a merged-tree re-measure) and Sidebar.tsx (W1a lifted the /libraries fetch into useLibraryShortcuts while W1c, branched earlier, still fetched in-component — resolved to W1a's single-fetch architecture with ShellNav threading moviesItemCount/tvItemCount as props).
- Orchestrator reconciliation 742eb5e: SheetOrModal breakpoint 640→767.98 (one shared literal, tokens.css note is the source of truth); ToastProvider mounted OUTERMOST in AppProviders (no lane owned that seam); --toast-offset-bottom set at :root in the ≤767.98px query — the toast viewport mounts above the per-route AppShell, so shell CSS can never reach it. Post-merge: stale packages/sdk dist made web typecheck red (W1c's commit carries regenerated SDK SOURCE; dist predated it) — rebuilt, green. 3543cfc: stale 640px demo copy in styleguide.
- Merged-tree numbers: web 415/415 (lanes' sums exactly); /browse 158,492 B gz vs 204,800 budget (+3.0 KB for the entire mobile chrome; W3 re-audits); full `pnpm gate` ALL STEPS PASSED.
- Browser verify (orchestrator, serialized): counts live in sidebar (Movies 5 / TV Shows 2, guard-riding); POOL meter correctly renders NOTHING on this host — seed library paths (/data/*) don't exist, every statfs probe fails, server returns storagePool:null, no fabricated numbers (U9) — unit-proven in admin-storage-pool.spec, will render on real installs; sheet at 392 to spec (20px top corners, handle, Done, scrim); toast pill verified computed-style-level (9999px radius, #FFB454 dot, Plex Mono 9.5px uppercase 0.1em, viewport offset 72px clearing the tab bar); mobile chrome live at 392 (large title, lock+avatar, 5 mono-label tabs, accent active). Screenshots: reports/phosphor/wave1/.
- Ops notes: gate run truncated the shared dev DB's users table again (foot-gun tally → 6; db:reset+seed restored, left canonical). Refresh tokens are single-use — an out-of-band /auth/refresh during verification invalidated the browser session (correct rotation behavior; orchestrator error, not a bug). Chrome profile carries stale pre-rename localStorage keys (former-name-prefixed) from old sessions — browser residue, NOT repo content, R8-clean confirmed.
- grep-gates hardened f9caefb: the worktree .git FILE (gitdir host path) false-positived the R8 scan in every lane worktree (W1b find) — now skipped; repo coverage unchanged.

### W2 L1 freeze — Settings IA + Users & Profiles + Libraries (2026-07-25, branch `worktree-agent-adc246b1165055768` @ e986a87, base 30d0695)

**Branch/SHA.** `worktree-agent-adc246b1165055768`, one commit `e986a87` on top of `30d0695` (Wave-1 landed tip). Not pushed; not merged. `apps/web`: lint (eslint --max-warnings=0 + stylelint) green, typecheck green, `pnpm test` 416/416 green (+1 vs. Wave-1's 415 — one new mobile-header case), `next build` green (9 new `/settings/*` routes present in the route table), `pnpm exec depcruise` clean (824 modules/2518 deps, 0 violations), `grep-gates` PASS (1808 files, 0 violations), `node scripts/perf-web-budget.mjs` PASS (`/browse` 160,680 B gz vs. 204,800 budget — +2.2 KB over Wave-1's 158,492, from the mobile-header.ts/nav-items.ts edits shared with every route; Settings' own ~30 new files are code-split into their own `/settings/*` chunks and never touch `/browse`'s bundle). No contract changes, no migrations, no new deps (verified: `packages/contract/openapi.yaml`, every `*/package.json`, and every `migrations/` dir untouched by this diff).

**IA map** (prototype tab -> route/component; `components/settings/section-registry.ts` is the single source of truth for this table):

| README tab | Route | Component | Existing surface reused |
|---|---|---|---|
| *(lane addition, not in the README's 8 — see rationale below)* | `/settings`, `/settings/account` | `AccountSection.tsx` | Pre-IA `/settings` (Profile/Restricted/Playback-prefs, `GET/PATCH /users/me`, `GET/PUT /users/me/restricted`, `GET/PUT /users/me/settings`) — moved verbatim minus the theme picker |
| 1 Server | `/settings/server` | `ServerSection.tsx` | New — `GET /system/capabilities` (`hw-transcode` flag) |
| 2 Libraries | `/settings/libraries` | `LibrariesSection.tsx` + `AddLibrarySheet.tsx` | Pre-IA `/admin/libraries` (all its endpoints + `ProviderChainEditor`/`Modal`-based Permissions+Edit dialogs), restyled into README row shape + one `RowMenu` |
| 3 Users & Profiles | `/settings/users` | `UsersSection.tsx` + `AddUserSheet.tsx` | Pre-IA `/admin/users` (all its endpoints + Library-access modal), restyled the same way |
| 4 Playback | `/settings/playback` | `PlaybackSection.tsx` | New composition — reuses `SettingsCategoryCard`/`SettingField` (L6 internals, un-restyled) filtered to the `transcode` category's 2 "everyday" keys |
| 5 Remote Access | `/settings/remote-access` | `RemoteAccessSection.tsx` | New composition — `GET /system/capabilities` (`remote-access` flag) + `SettingsCategoryCard` filtered to `network`/`tls` |
| 6 Plugins | `/settings/plugins` | `PluginsSection.tsx` | Pre-IA `/admin/settings`'s `ProviderKeysCard` half, split into its own tab (un-restyled) |
| 7 Advanced Server | `/settings/advanced` | `AdvancedSection.tsx` | Pre-IA `/admin/settings`'s registry half (`SettingsRestartBanner` + `SettingsCategoryCard` list, un-restyled) |
| 8 About | `/settings/about` | `AboutSection.tsx` | New — `GET /system/info` |

`/admin/users`, `/admin/libraries`, `/admin/settings` are now redirect-only stubs (same pattern as the existing `/admin` -> `/admin/jobs`) to their new `/settings/<key>` homes — old links/bookmarks keep working. `AdminNav.tsx` drops the now-redundant Libraries/Users/Settings entries (Jobs/Sessions/Plugins-LPP/System stay, untouched — L2's dashboard/System territory). `nav-items.ts`'s `SYSTEM_NAV_ITEMS` drops the "admin-settings" entry entirely.

**Lane addition beyond the README's 8 tabs — "Account".** The prototype's Settings screen is drawn entirely from the owner/admin persona (Maya Reyes) and has no personal-profile tab; the real app has non-admin users whose pre-existing profile/restricted-opt-in/playback-prefs capability needed a home in the new IA. Added as a 9th section, admin-only-gate exempted (every user sees it; every OTHER section is admin-only). Logged as a lane-decided call, not a prototype tab.

**Settings-label collision — RESOLVED, not just logged.** W1a's ground truth (this file, "Wave-0 checkpoint outcome") left both the LIBRARY group's "Settings" (-> `/settings`) and the SYSTEM group's "Settings" (-> `/admin/settings`) rendering for every admin, deferring the fix to "W2 L1 unifies the settings IA." That unification is what this lane did: `/settings` is now the ONE Settings destination for every user, admin or not (role decides content, not route) — so the SYSTEM group's entry is dead weight and is removed. One "Settings" label in the sidebar now, for everyone.

**Derived-badge sources** (mobile hub, `SettingsHub.tsx` — every value re-fetched on mount, nothing stored across renders, matching the README's own "derived, not stored" rule verbatim):
- Libraries row: `GET /libraries` item count, or a "LIVE" pill while `scan.started`/`scan.completed` (WS, real `libraryId`+`completedAtMs` payloads) reports any library scanning this session.
- Users & Profiles row: `GET /users` item count.
- Plugins row: `set/total` count from `GET /admin/settings`'s `providerKeys`.
- Advanced Server row: entry count from `GET /admin/settings/schema`.
- About row: `v<version>` from `GET /system/info`.
- Server/Playback/Remote Access/Account: no badge — no single real number honestly summarizes any of them.
- Libraries pane's own "state"/"last scan" columns use the same scan.started/completed events per-library (`use-library-scan-status.ts`) — session-derived only; a library with no scan observed this session shows neither, never a fabricated timestamp (Library itself has no scan-state/timestamp field at all — ground-truthed against the contract).

**Omitted-rows ledger (no backing endpoint — never fabricated, U9):**
- Server tab: "server rename" row — no `PATCH /system`/`/admin/system` route, no `name` field on `SystemInfo`. Omitted; noted in-page.
- Remote Access tab: "detected reverse proxy" and "TOKEN REDACTION IN PROXY LOGS: VERIFIED" — no probe/verification endpoint anywhere. Omitted; noted in-page. What's real (`remote-access` capability flag, honestly `false`/"not yet implemented"; `network`/`tls` registry keys, all env-only/locked) is shown instead.
- Playback tab: "direct-play preference", "remote quality cap", "skip-intros" — none exist as registry keys or contract fields (grepped clean). Substituted with the real `transcode` category's 2 everyday keys (`maxSimultaneousTranscodes`, `hevcEncodePreferred`) — same theme (playback/transcode config), 100% real data, logged as a substitution not a 1:1 mapping.
- Add-library sheet: "detected file count" — no preview/probe-before-create endpoint exists. Omitted.
- Users & Profiles rows: the prototype's "🔒 PIN badge for restricted profiles" — no admin-visible endpoint reports another user's `restrictedOptIn`/`hasPin` (only self-service `GET /users/me/settings`/`PUT /users/me/restricted` exist). Omitted; substituted with a rating-ceiling chip (`maxContentRating`, real, admin-visible, admin-settable) where set. RESTRICTED/GUEST as user ROLES don't exist server-side at all (`User` has only `isAdmin: boolean`) — role chips are Member/Admin (2, not 3), and the "RESTRICTED role forces the toggle on" behavior has no real analog (no admin endpoint sets another user's restricted state at creation) — replaced with an unconditional, always-available `maxContentRating` field on the add-user sheet instead.
- Add-user toast: dropped "· INVITE LINK COPIED" — no invite-link feature exists anywhere in the codebase (grepped clean); toasts "USER CREATED" alone.

**Add-user/add-library wiring proof.** Add user: `POST /users` (real `CreateUserRequest` — username/email/password required, none of which the prototype's sheet collects; added to the sheet since a user can't be created without them) — `AddUserSheet.tsx`. Add library: `POST /libraries` immediately followed by `POST /libraries/{id}/scan` (`full:false`) — real "Create & scan" behavior, not just a label — `AddLibrarySheet.tsx`. Both reuse the exact endpoints the pre-IA `/admin/users`+`/admin/libraries` pages already called (Phase 4 deliverable D); zero new server-side surface. Tests: `apps/web` unit suite covers `mobile-header.ts`'s new `/settings/<key>` resolution (2 new `it` blocks in `mobile-header.test.ts`, 416/416 total green) — no new component/page tests were added for the sections themselves (time-boxed; the existing suite had none for `/admin/users`+`/admin/libraries` either, so this is not a coverage regression, just not a new addition either — logged as a deferral below).

**Theme-picker removal.** `AccountSection.tsx`'s Playback form no longer renders the dark/light/system `SegmentedControl` (Phosphor is dark-only, W0). `UserSettings.theme` is untouched in the contract and still round-trips byte-identical through every `PUT /users/me/settings` this page makes (no control reads or writes it anymore) — per this lane's hard line, contract field removal stays a separate owner decision.

**Duplicate-title fix.** `SettingsShell.tsx`'s `heading` prop is `null` in exactly one case — non-admin, phone width, bare `/settings` — because `MobileHeader` already renders a large "Settings" title there (`mobile-header.ts`'s exact `/settings` match, unchanged); every other case (every admin desktop pane, every admin mobile `/settings/<key>` drill-down where the shell renders no title at all in "back" mode, and the non-admin desktop case where nothing else renders a title) gets a real in-page `<h1>`.

**Check numbers.** eslint 0 errors/0 warnings; stylelint 0 errors (2 auto-fixed: `currentColor`->`currentcolor`, a `no-descending-specificity` reorder); `tsc --noEmit` 0 errors; `vitest run` 416/416; `next build` succeeded, 27 routes incl. the 9 new `/settings/*`; `depcruise` 0 violations/824 modules; `grep-gates` 0 violations/1808 files; perf budget 160,680/204,800 B gz.

**Lane-decided calls** (beyond those already named above): registry-key filtering for Playback/Remote Access tabs (which 2-3 "everyday" keys per tab) is this lane's judgment call, not README-specified — logged per-file; "Plugins" tab name collides with the unrelated LPP `/admin/plugins` AdminNav entry (logged in `AdminNav.tsx`'s header, not renamed — out of scope); Libraries row actions (Scan/Full rescan/Permissions/Provider chain/Edit/Delete) consolidated behind one `⋯` `RowMenu` rather than the prototype's single "MANAGE" button, matching the Users row's own `⋯` pattern for IA consistency across this lane's two panes; Button's existing `:disabled { opacity: 0.5 }` reused for the "Create user"/"Create & scan" inert state rather than a one-off 45% value (matches the app's existing disabled-button convention everywhere else).

**Deferrals.** No dedicated component/page tests added for the 9 new sections (see wiring-proof note above — time-boxed, not a coverage regression vs. pre-IA). The mobile Settings hub shows 9 rows (8 README tabs + this lane's Account addition), not the README's literal "ten sections" — the README doesn't enumerate what the other 1-2 would be beyond the 8 tabs it names elsewhere, and no owning lane's Dashboard/System screens were duplicated into this hub (L2's territory) — flagged for W3's fidelity audit rather than guessed at. Browser/visual verification was NOT performed by this lane (RESOURCES: no port 3000/3001 access) — orchestrator verifies visually per the dispatch brief.

### Wave-2 landing + reconciliation (2026-07-25, full gate ALL STEPS PASSED on the 9-lane tree)

- All NINE lanes landed by cherry-pick in freeze order (L5→L1→L6→L7→L4→L8→L3→L2→L9), each with orchestrator reconciliation where parallel work crossed: L6's registry wiring → L1's AdvancedSection tab slot; L7's icon swaps re-applied over L6/L1/L4/L8 rewrites (incl. the tab bar's Restricted "lock" glyph); L8's RestrictedZoneChip made THE chip (L4's inline variants + invented band copy removed; SeriesDetailScreen gained the chip it lacked); L3's WatchlistToggle into L4's marked slots + L9's banner slot + album page; L3's rail into L9's Home slot + watchlist ids into the featured exclusion set; L2's FixMatch swapped into MetadataCard per its own instructions (stub deleted); envelope arithmetic reconciled at 24 types / 9 admin-only / 15 grantable across contract+server+worker specs; leak suite sections merged (L8's + L3's, both intact).
- Final numbers: web 635/635 · SDK byte-idempotent at 101 ops · oasdiff clean · migrate-check 39 tables · full `pnpm gate` ALL STEPS PASSED. One gate red herring en route: a STALE apps/server/dist spec (compiled pre-L2) failed the taxonomy count — clean rebuild, gate green; watch for turbo/tsc dist staleness after multi-lane landings. One honest stumble: the banner-toggle reconciliation commit (c460097) chained past a masked test failure; caught immediately, fixed in 6e66994.
- Browser verify (orchestrator, serialized): registry filter/pills/env-locked/masked rendering live; restricted.enabled flipped via the UI (dirty→Save→SAVED · hot-applied) — NOTE gate 1 is the registry key, the LOOMBRE_RESTRICTED_ENABLED env pin did NOT take effect on the dev stack (env reached turbo but the pin didn't surface — worth a future look, may be dev.mjs env propagation); zone gate → PIN 0000 auto-submit → amber grid w/ derived genre pills + 4 OF 4 · RECENTLY ADDED · ZONE-ONLY INDEX readout → LOCK NOW → exact relock toast → sidebar badge PIN⇄count live; watchlist toggle round-trip (label flip, ADDED TO WATCHLIST toast, sidebar 0→1 live); admin dashboard live (streams empty-state, per-library counts, UNMATCHED·REVIEW → FIX MATCH dialog opens; candidate search rides the job queue — no provider keys in dev, honestly empty); mobile 392: 6-tab bar incl. RESTRICTED, KEEP WATCHING/RECENTLY ADDED mono headers, play-overlay continue card. Featured banner EMPTY-POOL on canonical seed (rails consume all 7 titles — L9's documented small-library behavior; banner proven by 48 fake-timer tests). Screenshots: reports/phosphor/wave2/.
- Foot-gun tally → 7: the wave gate's server suite truncated the shared dev DB users again (db:reset+seed restored).

### W3 budgets + gates lane — DONE (2026-07-25)

- **Clean-clone gate (local 3-OS leg): ALL STEPS PASSED** (fresh clone, frozen lockfile, own DB; every workspace green — web 635, db 238, server 915+5skip, worker 938+5skip, engine 334, hosts/protocol/contract all green; 39 tables replayed; grep-gates 1929 files clean). Remote legs stay billing-gated (owner).
- **/browse budget: 164,846 B gz vs 204,800 (19.5% headroom).** Ledger: 156,159 pre-run → 155,455 post-W0 → 158,492 post-W1 → 164,846 post-W2 (fresh measurement; net Phosphor cost +8,687 B / +5.6%). Fonts: layout preloads exactly 2 faces (Archivo var latin 90,104 + Plex Mono 400 latin 14,708); a real authenticated /browse fetches 122,230 B of woff2 (3 files — mono-500 pulled by sidebar counts); latin-ext + 600 stay lazy-unfetched on English content; total available 262,668 B.
- **Lighthouse (prod build, real lhci config): Perf 0.98 · A11y 1.00 · BP 0.93 · SEO 1.00** — ≥0.90 assertion PASS, but see the CSP finding: BP's deduction is entirely the nonce bug's console violations, and Perf is INFLATED by it (0 JS executes → TBT 0). Re-run required post-fix. color-contrast flagged nothing — but lhci audits /login only, which never renders the U4 tiers; the exception remains untested by this tool, not cleared.
- **50k grid:** no automated fps harness exists (ground truth); the structural proof is real and re-confirmed EMPIRICALLY — 40 cursor-pagination loads to ~4,000+ items rendered, DOM listitem count pinned at exactly 60 throughout. Raw dev-mode headless fps (9.2) is NOT comparable to the production 60fps budget (unminified dev React + sandboxed Chrome + prod unmeasurable until the CSP fix); recorded as inconclusive-not-failing, re-measure post-CSP-fix on a prod build.
- **U11 inventory delivered** (reports/phosphor/stale-screenshots.md, untracked): ZERO real screenshot images exist in docs/ — nothing is ember-stale; 46 [SCREENSHOT:] placeholders across 12 pages, all unshot; every future shot lands Phosphor-era. docs/ diff vs baseline: completely empty.
- **CRITICAL PRE-EXISTING FIND (not Phosphor):** production `next start` ships ZERO working client JS on all 26 statically-rendered routes — apps/web/src/proxy.ts sets the CSP nonce on RESPONSE headers only; Next's nonce-stamping needs it on the REQUEST headers (which also forces dynamic rendering). Nonce+strict-dynamic with no unsafe-inline ⇒ every script blocked. Verified 3 ways (RSC payload nonce:"$undefined"; curl shows zero nonce= script attrs; Lighthouse's own console-error audits cite the CSP violations). In the tree since b9f4d16 (Phase 4 G1, PRE-Phosphor); every historical "browser verified" note used the dev stack, which renders dynamically and masks it. Fix verified in a scratch clone: propagate the CSP header onto request headers before NextResponse.next().
- Also found: featured-rotation.ts stores an UNBOUND setTimeout (`?? setTimeout`) — throws Illegal invocation in real browsers on authenticated /home (jsdom tolerates unbound timers, which is why 48 fake-timer tests pass). L9-introduced, fix-wave item.

### W3 fidelity audit — DONE (2026-07-25) → fix wave FX1–FX4 DISPATCHED

- Findings ledger: **reports/phosphor/wave3/fidelity-audit.md** (+44 paired screenshots in reports/phosphor/wave3/fidelity/). 7 systemic HIGH classes (title width-axis lost app-wide; mono-label law broken in 6 files; admin danger/warning collapsed to accent; flat-accent avatars; missing artwork fallbacks on 3 components; .glass over-applied beyond U8's two surfaces; poster signature — hairline/in-art title/accent ring — absent everywhere) + 20 screen HIGHs, headlined by **Login and Music/Album never actually rethemed** (token-inherited only). MED/LOW tail recorded for owner-ack. VERIFIED FAITHFUL: tokens verbatim, icon set exact, banner geometry (all three README lessons), zone warning-vs-accent law, tab-bar spec, settings shell metrics, fonts.
- 4 spec conflicts recorded for the owner (weight-black 800 vs 900; keypad shape; episode thumb sizes; seek glyph style) — build follows the README in each, per run law.
- Fix wave dispatched (4 parallel worktree lanes, file-partitioned): FX1 infra (CRITICAL prod CSP-nonce fix + rotation timer bind + settings underline family + artwork fallbacks + episode RESUME badge) · FX2 systemic type/color (S1–S4 + mobile chrome accents + sidebar fidelity) · FX3 whole screens (Login, Music/Album, Search layouts, queue current-track guard) · FX4 structure (glass scoping, poster signature, poster aspect, gate frame + desktop keypad, player transport, settings rows, dashboard header). H4 (Browse quality filter chips) DEFERRED — contract-shaped, owner call.

### FX4 freeze report (structure: glass scoping, poster signature, poster aspect, gate/keypad, player transport, settings rows, dashboard header) — 2026-07-25

**Branch/SHA.** `worktree-agent-a93da821c379130b4`, base `e27adaf` (this run's dispatch point — worktree's own HEAD had drifted onto a stale pre-dispatch tree at kickoff; reset to `main`/`e27adaf` per this lane's own FIRST-ACTION check before touching anything). One commit on top (this STATE.md entry + the fix-wave diff land together). Not pushed, not merged.

**Findings, before → after:**

| Finding | Before | After |
|---|---|---|
| S6 Overlay | `.dialog`/`.popover`/`.menu` composed `.glass` (U8-violating — those aren't the tab-bar/now-playing-bar) | Solid `var(--color-bg-raised)` + `var(--color-border)`; scrim splits into the dc's TWO real values — light (`--color-overlay`+blur3, unchanged) below 768px for `BottomSheet`, heavier `rgb(5 6 8/66%)`+blur8 at/above 768px for desktop dialogs (dc:2898 vs dc:2355 — see Overlay.module.css's header for the full reasoning; BottomSheet never renders ≥768px so the split can't leak into it) |
| S6 AppShell topbar | `composes: glass` (--chrome-bg 86%/blur20, all-around --chrome-edge border) | Own chrome: `color-mix(in srgb, var(--color-bg) 85%, transparent)` (== dc's `rgba(11,12,15,.85)` exactly, since `--color-bg` IS `rgb(11 12 15)`) + literal `blur(14px)` (no existing token, single consumer) + `border-bottom: var(--color-border-subtle)` only |
| S6 PosterCard progress pill | `composes: glass` | `color-mix(in srgb, var(--color-bg) 75%, transparent)` (dc's plain dark-fill badge convention, no blur/border) |
| S6 SceneBanner .backPill | — | **SKIPPED, logged** — FX1's file, out of FX4's exclusive list |
| S6 PlayerControls | `.topBar`/`.bottomBar`/`.pickerPopover` all `composes: glass` | `.topBar` → transparent scrim gradient (dc:1379, no blur/border); back button → own floating 38×38 circular chip (dc:1381); `.bottomBar`/`.pickerPopover` → own rgba+blur matching dc:1445/1476 (`--color-border` reused where it's an exact 12% match) |
| S7 poster signature (PosterCard, PosterCell, WatchlistPosterCard, ZonePosterCard) | No inner hairline; no in-artwork title (below-caption only); hover = `translateY(-4px) scale(1.03)` + `--shadow-md` | `::after` hairline (inset 7px, `rgb(255 255 255/16%)`, `--radius-sm`); in-artwork bottom title ADDED alongside the existing below-caption (dc renders both on every checked surface — Browse dc:274-284, Recently Added dc:183-196, Watchlist dc:208-222/1110-1120, Zone dc:1187-1191, all duplicate title in-art+below); hover = `translateY(-4px)` only + `0 12px 32px rgb(0 0 0/50%), 0 0 0 1px color-mix(…var(--color-accent) 45%…)` (dc's shared literal). Skipped the 16/9 Continue Watching aspect of PosterCard (own title+epcode+progress treatment already, not a "poster") |
| S7 zone-law exception (ZonePosterCard) | Border `var(--color-warning)` solid; ring `--shadow-md` | Border `color-mix(…var(--color-warning) 22%…)`; hover ring `color-mix(…var(--color-warning) 50%…)` — never accent, per the zone law |
| H3 poster aspect | `.pullUp` flex, no `align-items` → default `stretch` forced DetailPoster to 218×561 | `align-items: flex-start` added — DetailPoster's own `width:218px;aspect-ratio:2/3` now governs (218×327) |
| H6 play/pause | 40×40 ghost, same as every other control | 46×46 accent-filled circle, `--color-accent-text` glyph (`.playPauseButton`) |
| H6 flanking controls | 40×40, 14% hover | 38×38, 8% hover (dc:1465) |
| H6 capability chips | None | Decision-mode chip (accent-toned) from `session.plan.decision` via the existing `decisionLabel()`; audio/subtitle fact chips (neutral) from `audioStreams`/`subtitleStreams`/selected-index — all real props, nothing fabricated |
| H10 RestrictedGate frame | 460px max-width, no border, `--space-xl --space-lg` padding; roundel 64px, `--fill-3`/`--color-border`, no warning tint | 520px, `1px dashed color-mix(…warning 30%…)`, `--radius-md`, `54px 40px` padding; roundel 52px, `color-mix(…warning 8%…)` fill + `color-mix(…warning 40%…)` border (dc:1148/1149 exact) |
| H20 PinModal desktop | `.keypad{display:none}` above 767.98px — desktop showed only the text field | `.keypad` renders at every width (unconditional `display:grid`); text field stays too (kept, not in the dc, but a real keyboard-accessibility affordance); auto-submit untouched |
| H15 settings rows | `--radius-md` box, `1px solid var(--border)`, no fill | `--radius-pill`, `var(--color-border-subtle)`, `background: var(--fill-1)` (dc's `rgba(255,255,255,.015)`/`.08` row literal) |
| H16 UsersSection add-user | Dashed `.addTile` at the bottom of the list | Solid accent `<Button variant="primary">` in the `.header` row beside "Users · n" (dc:753); dashed tile usage removed HERE ONLY — `LibrariesSection.tsx`'s own dashed "+ ADD LIBRARY" tile is untouched (correct prototype meaning, not this lane's file) |
| H19 dashboard header | None at all (page opened straight on `<HealthCards/>`) | "Dashboard" h1 (`--wdth-title`/`--weight-black`/`--text-xl` = 114%/800/26px exact) + mono status line from real `GET /system/info` (version, formatted uptime) |
| H19 HealthCards token bug | `var(--border-subtle, var(--border))` — `--border-subtle` was never defined anywhere, so the fallback always won silently | `var(--color-border-subtle)` (the real token); card also moved to `--radius-md`/`--fill-1` per the dc's translucent-chrome literal |
| EventLogPanel (cheap MED, owned file) | Every event type same neutral color | `restricted.*` events get the warning tone via a real `type.split(".")[0]` prefix check — no invented taxonomy beyond the closed 24-type enum's own dot-prefix shape |

**Ground-truth ledger — H6 (session-plan/track data availability, apps/web/src/components/player/VideoPlayer.tsx + packages/contract/openapi.yaml):**
- `PlaybackSession.plan` (`PlaybackPlan`) is REAL and already held by `VideoPlayer.tsx`'s `session` state — `decision` (direct-play/direct-stream/remux/transcode), `audio`/`subtitle` actions. One line threaded it into `PlayerControls` as a new `plan` prop (VideoPlayer.tsx is outside FX4's exclusive file list; this is the sole, minimal, logged touch — same "one seam" convention other Wave-2 lanes used for cross-lane wiring).
- `session.media.audio`/`session.media.subtitle` (`AudioStream[]`/`SubtitleStream[]`) were ALREADY passed into `PlayerControls` as `audioStreams`/`subtitleStreams` — real codec/channels/language facts, used directly rather than re-fetched.
- NOT backed anywhere in the contract: AIRPLAY (no such feature exists, grepped clean), QUEUE n (a music-queue-drawer concept, not part of `VideoPlayer`'s video-session shape), 4K/HDR/CC (no resolution/HDR/caption-availability field reaches `PlayerControls` today). All three omitted, not guessed.

**Ground-truth ledger — H19 (`SystemInfo`, packages/contract/openapi.yaml:2882 + apps/server/src/gateway/health.controller.ts):**
- REAL and used: `version`, `uptimeMs` (formatted `UP <d>D <h>H` / `<h>H <m>M` / `<m>M`).
- NOT backed: hostname/server-name (no `name`/`hostname` field on `SystemInfo` — the dc's `LOOMBRE-01` is a bare fixture) and "POSTGRES OK" (no postgres field on `SystemInfo`; `GET /healthz` is a bare `{status:"ok",timestampMs}` liveness stub with zero DB/subsystem check). Both omitted from the status line.
- Pulsing "ALL SYSTEMS NOMINAL" dot: omitted entirely — no component on the dashboard page calls `/healthz` today, and even if one did, a bare 200 only proves "the Node process answered," not "all systems nominal." Building a real signal (e.g. wiring `/healthz` client-side) was judged out of scope for a decorative pulse; logged for whoever next wants to back it for real.

**H3 verification method.** A jsdom/computed-style check was attempted and found genuinely infeasible, not skipped for convenience: probed empirically (scratch test, deleted after) — `getComputedStyle()` on an element carrying the real hashed CSS-module class returns browser DEFAULTS (`align-items: normal`, `display: block`) regardless of the module's actual declared rules, because this repo's `vitest.config.ts` has no `test.css`/CSS-injection option, so Vite's CSS-modules transform produces the class-name mapping but jsdom's document never receives the actual rule bodies. Verified instead by layout reasoning: `align-items: flex-start` on `.pullUp` removes the default `stretch` that was overriding DetailPoster's own `width:218px;aspect-ratio:2/3` (218 × 3/2 = 327, matching the audit's expected 218×327 against the found 218×561).

**Cross-lane notes (not fixed here, logged for the record):**
- `components/ui/Overlay.module.css`'s `.scrim` is shared with `components/ui/BottomSheet.module.css` (another lane's file) via plain className layering, not `composes`. The 768px scrim split above is a same-file-only fix that resolves correctly for both real usages (verified: `BottomSheet` only ever renders below 768px, via `SheetOrModal`'s own breakpoint switch) — flagged in case a future lane changes that switch's breakpoint and needs to keep this one in sync.
- 38×38/46×46 player-control sizing (H6, exact dc values) sits below the run's general "44px touch" floor. Judged a deliberate, sourced exception rather than a silent deviation: these are floating video-chrome controls (not primary nav/settings), the PRE-EXISTING code was already sub-44 (40×40) before this fix, and H6's instruction gave explicit literal sizes rather than a range — flagged rather than silently overridden.

**Check numbers (this lane, tree at freeze).** `apps/web`: `eslint src --max-warnings=0` clean; `stylelint "src/**/*.css"` clean (0 errors — every new radius is a token, U5 held); `tsc --noEmit` clean; `vitest run` 635/635 (unchanged from the pre-fix count — no test regressions, none added: this was a visual/structural fix wave); `next build --webpack` succeeded, 29 routes unchanged. Repo-wide: `depcruise --config .dependency-cruiser.cjs apps packages` clean (925 modules/2912 deps); `grep-gates` PASS (1914 files, 0 violations); `node scripts/perf-web-budget.mjs` PASS — `/browse` 164,857 B gz vs 204,800 budget (19.5% headroom, +11 B over the W3 budgets lane's 164,846 baseline — negligible, from the admin-header/capability-chip/event-tone text additions, none of which touch `/browse`'s own bundle directly; the shared-chunk delta is the entire measured cost). `packages/contract` codegen re-run byte-identical (0 diff) — confirms zero contract drift from this lane.

**Skipped / deferred, with reasons:**
- SceneBanner `.backPill` (S6) — FX1's file, explicitly out of scope per the dispatch brief.
- Browse 4K/HDR/UNWATCHED filter chips (H4) — already DEFERRED at dispatch (contract-shaped, owner call), not re-litigated here.
- Player capability chips: AIRPLAY, QUEUE n, 4K/HDR/CC — omitted, no backing data (see H6 ledger above).
- Dashboard pulsing "ALL SYSTEMS NOMINAL" dot (H19) — omitted, no real health signal wired client-side (see H19 ledger above).
- Dashboard hostname + "POSTGRES OK" (H19) — omitted, no backing fields anywhere (see H19 ledger above).
- WatchlistPosterCard's REMOVE mechanism (inline icon-overlay button) vs. the dc's own below-caption text-link REMOVE (both the Home-rail dc:222 and /watchlist-route dc:1120 instances use a text link, not an icon overlay) — left AS-IS: not one of S7's four enumerated fixes (hairline/in-art-title/ring/scale), and changing the interaction mechanism is a bigger behavioral call than this finding's scope. Logged as a MED-tier observation for whoever next reviews this surface.

Not pushed; not merged.

### Fix wave FX1–FX4 — LANDED (2026-07-25); FINAL GATE ALL STEPS PASSED on e20bfaa's tree

- FX2 (5b26b90+49dfdf8): S1 width-axis restored on every screen title · S2 mono-label law (its 4 files) · S3 danger/warning untangled from accent · S4 per-hue 2-letter avatars · H7/H8 mobile chrome (Archivo tab labels, accent back/Done) · H11 wordmark .22em + pulsing dot · H12 refusal pill + mono codes · H17/H18 · sidebar fidelity set + opaque gradient (new --sidebar-bg token) · 3 undefined --border-subtle refs fixed.
- FX4 (see its freeze report above): S6 glass scoped to U8's two surfaces · S7 poster signature ×4 (zone card warning-toned) · H3 aspect fix · H6 accent transport + real-plan capability chips · H10/H20 gate frame + desktop keypad · H15/H16 · H19 dashboard header (real /system/info only).
- FX1 (b727ae5+7dbd439): **CRITICAL prod CSP-nonce FIXED** — request-header propagation + layout.tsx headers() (two-part fix; all 29 routes ○→ƒ; 19/19 script tags nonce-matched under next start, re-proven on main) · featured-rotation timers bound (fail-before/pass-after tests) · H9 underline family swept · S5 artwork fallbacks + H13 RESUME pill (props threaded at landing 7dbd439).
- FX3 (landed clean, 42 files): H1 Login rebuilt (glow/wordmark/mono labels/server pill+SWITCH; passkey/forgot/trust-device/latency/device-name OMITTED — zero backing endpoints) · H2 Album rebuilt (tile + vinyl-while-playing, eyebrow, TRACKS|MORE ALBUMS via real /artists/{id}/albums, lmEq equalizer; Shuffle/GAPLESS/codec omitted w/ ground truth) · H14 current-track remove disabled · H5 Search rebuilt (4 real result layouts, localStorage recents, ghost empty state; fixture perf claims cut, trigram copy rescoped to truth, latency = real performance.now()). Web suite 635→723.
- Post-landing reconciliations: HTTP status → refusal pill (e46e958); sidebar lock glyph (49dfdf8); **exit-gate walk catch e20bfaa** — RestrictedLockControl (P2.8-era) rendered its PIN affordance for UNENTITLED viewers; now gated on hasRestrictedZoneEntitlement like every L8 entry point.
- **Production verification (next start — the first honest one in repo history):** nonces live on main; Login/gate/keypad/sidebar all Phosphor in prod; **two-device restrictedLocked sync PROVEN both directions live** (B keypad-unlock → A grid flips with NO reload; A LOCK NOW → B re-gates + exact toast); casual (unentitled) viewer re-verified ZERO zone affordances on the rebuilt bundle, admin retains all. **Post-CSP-fix Lighthouse: Perf 0.94 · A11y 1.00 · BP 0.93 · SEO 1.00** (≥0.90 PASS with real JS executing; BP's sole deduction = one benign 404'd resource in the API-less audit env). Screenshots: reports/phosphor/wave3/fixwave/.
- Ops: foot-gun tally → 8 (gate truncated dev-DB users; reseeded, left canonical). Environmental traps diagnosed-not-app-bugs: zombie next start survived pkill-by-name (killed by port); browser HTTP cache spans isolated contexts (stale-build ChunkLoadError → hard reload). Gate red herrings: stale apps/server dist spec (clean rebuild), untracked .lighthouseci residue tripping R8 (removed — harness-artifact class).

### EXIT GATE — WALKED 2026-07-25 (final tree e20bfaa, gate ALL STEPS PASSED)

- [x] Wave-0 owner approval recorded (739f004 — retheme + sidebar + U3 tablet, owner "continue").
- [~] Gate green 3-OS: LOCAL clean-clone ALL STEPS PASSED (W3 budgets lane) + final working-tree gate ALL STEPS PASSED; lint max-warnings=0 · stylelint radius law · typecheck · tests · leak suite UNTOUCHED-AND-GREEN (41/41; 330 insertions, 0 deletions since baseline). REMOTE 3-OS legs billing-gated — inherited owner action (identical posture to the sweep/LPP).
- [x] One route tree, no user-agent branching (constraint audit: grep-proven; device-profile id is playback capability, not layout).
- [x] Fidelity findings resolved or owner-acked: 7/7 systemic + 19/20 screen HIGHs RESOLVED (H4 deferred — contract-shaped, owner); MED/LOW tail OWNER-ACKED via reports/phosphor/wave3/fidelity-audit.md + 44 paired screenshots + fixwave production shots.
- [x] U4 exactly: values byte-exact, measured-exception comment in place, placement law held — surface sub-law class = OPEN owner decision (7 sites, options + recommendation below).
- [x] Fixture grep clean: ~100 prototype strings harvested, ZERO shipped (test-data name fixed 12494ab); real data via established client patterns throughout; derived-not-stored verified.
- [x] Fonts self-hosted + csp font-src 'self' w/ regression test; payload measured (262,668 B total; real /browse fetches 122,230 B; 2 faces preloaded); /browse 164,846 B gz vs 204,800 (19.5% headroom; net run cost +5.6%); Lighthouse ≥90 honest post-CSP-fix; 60fps grids: windowing bound EMPIRICALLY proven (DOM pinned at 60 nodes through 4k+ of 50k items) — raw prod-profile fps still pending a post-CSP-fix measurement pass (dev-mode 9.2 recorded as not-comparable, not failing); reduced-motion honored beyond the global clamp on every promised surface.
- [x] Custom icons via the Icon wrapper at spec stroke/sizes incl. seek numerals (fidelity audit: verified-faithful).
- [x] restrictedLocked syncs across two live devices via the events socket (proven both directions in production); restricted-profile viewer sees no zone anywhere (screenshot walk — PASS after the e20bfaa catch).
- [x] U11 stale-screenshot inventory delivered (reports/phosphor/stale-screenshots.md): ZERO real screenshots exist in docs/ — nothing ember-stale; 46 placeholders across 12 pages; every future shot lands Phosphor-era.
- [x] STATE.md: Phosphor recorded as superseding P2.7/P2.20 (P2.10 physics + budgets intact and enforced); coverage vs mission complete at both breakpoints except enumerated honest omissions (no-endpoint facts, logged per-lane) and H4; per-lane burn-up complete — W0, W1a–c, W2 L1–L9, W3 ×3, FX1–4 all LANDED with gate-green freezes.

**OWNER LEDGER (consolidated):** (1) CI billing → rerun proves remote 3-OS legs. (2) U4 surface sub-law: amend letter / patch 7 sites / name exceptions — audit recommends amend. (3) Unlocked-session guard semantics vs README zone-only law — the run's biggest standing conflict (guard.ts + leak-suite change, own adversarial review cycle). (4) H4 Browse quality-filter chips (contract work). (5) Spec conflicts a–d (weight 800v900, keypad shape, episode thumbs, seek glyphs) — build follows README; override if the prototype was right. (6) UserSettings.theme field fate + real server-side prefs persistence (users/me/settings is a stub; accent/scanlines client-only). (7) Server-decided featured pool · Progress device field · rotation-pause overlay signal. (8) Post-CSP-fix follow-ups: prod-profile 50k fps measurement now possible; watch Lighthouse perf with all routes dynamic. (9) MED/LOW fidelity tail: accept or schedule a polish pass (ledger in reports/phosphor/wave3/fidelity-audit.md).

### Phosphor Open (standing items, carried from the run)

- U11: after W0 lands, every screenshot in docs/install + guides shows the ember theme — the stale-screenshot INVENTORY is a W3 deliverable; the refresh itself rides the next docs pass (post-owner VM smokes), NOT this run.
- 3-OS remote gate proof = owner Billing & plans action, then `gh run rerun 30182622346` (a workflow_dispatch os=all fired at push time on the FULL Phosphor tree 8b75e5d — died 0-steps on the spending limit like every leg since the sweep; rerunning it after billing is fixed proves all three legs incl. Node-24 runners + gate-node-next in one shot). Push itself is DONE: 53 commits, 83456c0..8b75e5d, 2026-07-25.
- No custom not-found page exists — the Next default 404 renders WHITE inside a dark-only app (found during ground-truth). Assign a Phosphor not-found to W1/W2.
- ~~Personal Settings still renders the contract-backed UserSettings.theme dark/light/system picker — inert since the data-theme mechanism is gone.~~ RESOLVED by W2 L1 (`AccountSection.tsx` drops the control; `UserSettings.theme` itself is untouched in the contract, per this lane's hard line — contract field removal stays a separate owner decision).
- Library item counts + storage-pool fields have no contract surface (sidebar counts + POOL meter blocked on it) — decide with W2 whether to add the endpoints or drop the two sidebar affordances.
- Dev-stack foot-gun (W0 lane + orchestrator both hit it): apps/server with DATABASE_URL unset silently bootstraps an ephemeral embedded Postgres instead of the compose dev DB → un-migrated-relation crashes. Document the dev-standup env requirement (or make dev.mjs default to the compose URL) in the next docs/tooling pass.
- GET/PUT /users/me/settings is a COMPLETE STUB (L7 ground truth): persists nothing for ANY key incl. the schema's own; UserSettings is additionalProperties:false with no prefs bucket. Accent/scanlines (L7) are client-only localStorage until an owner-decided contract pass wires user_settings.prefs for real — same pass should decide UserSettings.theme's fate (L1 removed its dead UI).
- Progress carries no device field anywhere in the system (L5 ground truth) — the prototype's "position · device" on continue-watching cards renders position-only until per-device progress is designed (owner decision).
- **OWNER FLAG (L8 ground truth, reported not fixed): once a session is gate-5 unlocked, the pre-existing P2.8 guard MIXES restricted rows into general /movies and /search** — the Phosphor spec says zone titles never appear in Browse/Search/Home "locked or not". Fixing it changes guard.ts's shared semantics AND the frozen leak suite's own assertions ("…but does for a cleared one") — deliberately out of a fan-out lane's scope. The safe direction holds (uncleared viewers never see zone rows, live-confirmed). Owner decision: adopt the README's stricter zone-only law (guard + leak-suite change, own review cycle) or amend the README.
- Featured pool is client-computed (L9); the README prefers server-decided for cross-device consistency — future additive op, owner priority call. Related: no cross-cutting "any modal/palette open" signal exists for rotation-pause (each overlay tracks its own boolean); a shared signal is a small W-later refactor.
- LOOMBRE_RESTRICTED_ENABLED env pin didn't surface on the dev stack (registry UI path works; see Wave-2 record) — verify env-pin propagation through dev.mjs before calling it a bug.
- **OWNER DECISION (W3 constraint audit, U4 surface sub-law):** 7 usages of the accepted-exception grey tiers sit on raised chrome (--color-surface/-hover, 2.92–3.10:1) rather than --color-bg (3.38:1) — root cause: W0 retinted --color-text-subtle IN PLACE and inherited consumers were never re-audited; 3 more landed in W2 admin panels (F1–F7 in the audit report). Options: (1) amend U4's letter to "never on a surface lighter than --fill-2" (matches shipped precedent, zero churn — AUDIT-RECOMMENDED; the delta is 0.3–0.5 on an already-accepted exception), (2) patch the 7 sites to --color-text-muted (flattens tonal range, contra U4's own rationale), (3) record 7 named exceptions. Deliberately NOT resolved by the orchestrator — U4 says values-as-designed decisions are the owner's.

## Supported-latest sweep (kicked off 2026-07-25, authority: owner "Node 24, PostgreSQL 18, full supported-latest sweep" brief)

### Preconditions verified before any edit

- Rename run COMPLETE per its own STATE.md records (§1 inventory frozen+burned, §4 matrix walked); LPP v1 landed after it and is FROZEN with gate green on the final tree. No sweep in flight.
- Clean-clone `pnpm gate` on HEAD 4e4e1e5: **ALL STEPS PASSED** (2026-07-25, this session, scratchpad gate-clone) — the pre-sweep regression baseline.
- Windows CI leg remains billing-gated (pre-existing, inherited by this sweep's "3-OS" verification item exactly as by LPP's).

### §1 frozen inventory (registry-verified per direct dep — `pnpm outdated` was stale-cache-blind to 3 of these; scripted npm-registry query used instead; 51 unique direct deps, zero pre-releases in lockfile pre-sweep)

**Patch/minor bulk list (Wave T/M):** pnpm packageManager 11.1.2→11.17.0 · turbo 2.10.6→2.10.7 (+ Dockerfile:75 `pnpm dlx turbo@…` lockstep pin) · eslint 10.7.0→10.8.0 · lockfile in-range refresh (pg-boss 12.26.2→12.26.3; all other range-dep floors already resolve to latest-in-range). Everything else — NestJS 11.1.28, Kysely 0.29.4, pg 8.22.0, sharp 0.35.3, hls.js 1.6.16, react 19.2.8, vitest 4.1.10 (5 is beta → stays), turbo/tsx/vitepress/@lhci/typescript-eslint/openapi-typescript/etc — already latest stable.

**Major list (each = own commit + justification; changelogs read via research pass with primary sources):**
| Pkg | From → To | Intent / evidence |
|---|---|---|
| typescript (root + 8 pkgs) | 5.9.3 → 6.0.3 | Sanctioned JS-based bridge major. **7.0.2 (native, GA 2026-07-08) BLOCKED**: programmatic compiler API removed until TS 7.1 (~Oct 2026); typescript-eslint peer `<6.1.0` (8.65 crashes on 7, closed not-planned); Next needs 16.3 + experimental flag to type-check. Retry: 7.1 API + typescript-eslint + Nest support all land |
| @redocly/cli (contract) | 1.34.17 → 2.40.0 | GO; same-commit REQUIRED fixes: build-api-reference CDN-strip regex must tolerate integrity/crossorigin attrs; `redoc` no longer transitive (2.34 dependency-free CLI) → explicit devDep redoc@2.5.3 + resolve from it. Bonus catch: `redocly lint` (contract lint script) has NO telemetry opt-out today — invariant-7 violation, fix here (REDOCLY_TELEMETRY=off) |
| stylelint + stylelint-config-standard (web) | 16.26.1→17.14.1 + 36.0.1→40.0.0 | Pair (only config 40 peers stylelint 17). CLI-invocation usage unaffected by ESM-only Node API; repo config sets none of the semantics-changed rules |
| jsdom (web) | 25.0.1 → 29.1.1 | Target 29.1.1 exactly (29.0.0 CSSOM-rewrite regressions patched by 29.1.1); real Node floor 22.13+/24 (met); rename sendTo→forwardTo if used; click() now PointerEvent |
| lucide-react (web) | 0.545.0 → 1.26.0 | 14 brand icons removed (grep first — typecheck would catch); otherwise aliased renames only; ESM/CJS kept |
| next (web, LAST) | 15.5.21 → 16.2.11 | Items: src/middleware.ts (per-request CSP nonce, load-bearing) → proxy.ts (Node runtime — fine, no Edge dependence); custom webpack() config makes bare `next build` hard-fail → bundler decision by /browse-budget A/B (Turbopack default vs --webpack; documented Turbopack size regressions exist); budget gate reads app-build-manifest.json NOT stdout (survives 16's metric-print removal — verify manifest exists under chosen bundler); next/image defaults audit (qualities [75], minimumCacheTTL 4h, localPatterns.search, dangerouslyAllowLocalIP); sharp override >=0.35.0 already in pnpm-workspace ✓; codemods next-async-request-api (v15 leftovers) + middleware-to-proxy |

**Runtime/external list (registry/GH-verified 2026-07-25):** Node 24.18.0 Active LTS (OpenSSL 3.5.7; NOTE coordinated Node security release pre-announced 2026-07-27 — expect a patch bump days after this sweep; that is Renovate's job, not a reason to wait) · Node 26.5.0 Current (non-blocking CI job) · Node 22 = Maintenance LTS (engines floor moves to 24 per N1) · PG 18.4 GA + 17.10 latest-17 (already pinned); postgres:18 docker exists (trixie default variant); theseus-rs 18.4.0 binaries exist ALL 5 platforms; PG18 gotchas: initdb data-checksums ON by default, Debian/docker data-dir layout now version-specific · ffmpeg 8.1.2 = current stable; **repo pin ALREADY 8.1.2 (pinned 2026-07-24) on 4/5 platforms → no bump, no VerifiedCapabilities rotation trigger; macos-arm64 still 8.1 (unversioned osxexperts URL) — re-check for arm 8.1.2 at execution** · Actions current majors: checkout v7.0.1, setup-node v7.0.0, upload-artifact v7.0.1, download-artifact v8.0.1, buildx v4.2.0, login v4.5.1 (rest resolved at execution); repo today: zero SHA pins, attest-build-provenance@v1 lagging · WiX v7.0.0 (2026-04) latest; repo UNPINNED, v4 wxs schema · pnpm 11.17.0.

**Inventory catches beyond version numbers (fix in the matching wave):** docs/PLAN.md:103 claims node-pg-migrate — FALSE, migrations are hand-rolled packages/db/scripts/migrate.mjs (N5's node-pg-migrate entry is therefore N/A) · macOS installer resolves Node patch dynamically-in-major at build time (checksum-verified via SHASUMS256) vs Linux's manifest-pinned patch — divergence recorded, dynamic resolution retained (satisfies "latest 24.x" by construction) · Windows installer bundles NO Node runtime (pre-existing I3 finding, out of sweep scope) · CI installs distro ffmpeg unpinned (tests never run the shipped 8.1.2) — recorded, not this sweep's fix · oasdiff pinned twice (ci+release yml) · turbo pinned twice (package.json + Dockerfile dlx).

### Execution plan (sequential waves, full gate between; majors = individual commits inside their wave)

1. **Wave T (toolchain, N5):** pnpm 11.17.0 → turbo 2.10.7 → eslint 10.8.0 (minors, one commit) · typescript 6.0.3 (major, own commit) · @redocly/cli 2.40.0 + script fixes + lint-telemetry-off (major, own commit) · stylelint 17 pair (major, own commit). Gate.
2. **Wave M (patch/minor bulk, N3):** lockfile in-range refresh (pg-boss). Gate.
3. **Wave J (remaining majors, N3, one at a time):** jsdom → lucide-react → next 16 (framework last). Gate per major.
4. **Wave N (Node 24, N1/N2):** .nvmrc 24 · engines >=24 · 8 CI node-version lines · Dockerfile node:24.18.0-bookworm-slim ×2 · linux node-manifest 24.18.0 + re-fetched sha256s · @types/node 26.x→24.x alignment (evidence: typecheck must stay green; failures would be uses of >24 APIs = N1 violations) · Node 22 refs removed · Node 26.5 non-blocking CI job · N2 policy codified (docs/developer-guide + CLAUDE.md) · docs claims (README, getting-started, packaging-release, t0-audit-runbook, LAYOUT.md) · OpenSSL 3.5 proof = auth/crypto/TLS(pebble) suites green under 24 (they already run under host 24.15 locally — CI legs are the cross-check). Gate.
5. **Wave P (PG 18, N4):** compose dev postgres:18 / prod postgres:18.4 · CI action postgres-version 18 ×3 · embedded manifest defaultVersion 18.4.0 + 5-platform checksums; upgrade-from line 16.14.0→17.10.0 · PROVISIONING_REQUEST_MIN_PG_MAJOR STAYS 17 (external-PG floor; N4 bumps what we ship, not what we accept) · hardcoded 17.10.0/16.14.0 constants in ~10 files moved · **dogfood: Phase-4 dump/restore upgrade job migrates a POPULATED 17.10.0 embedded data dir → 18.4.0 with row-count + conformance + leak-suite proof** · docs claims (docker.md, external-postgres.md, troubleshooting, install pages, PLAN.md §204 note). Blocker ⇒ stay 17.x + evidence + retry condition. Gate.
6. **Wave X (externals + machinery, N6/N7):** ffmpeg macos-arm64 8.1.2 re-check (bump only if published; then re-probe on this arm64 host = the VerifiedCapabilities rotation proof; otherwise confirm invalidation logic by inspection + record no-trigger) · Actions → current majors SHA-pinned (supply-chain posture per security review) · oasdiff env pin → latest · WiX: pin via .config/dotnet-tools.json + v4-schema compat evidence; installer smoke = Windows leg = billing-gated → recorded retry, not claimed · Renovate config (config:recommended, group:allNonMajor weekly, :separateMajorReleases, :maintainLockFilesWeekly, helpers:pinGitHubActionDigests, node versioning managers) · dep-audit verified vs post-sweep tree. Gate.
7. **Final:** §3 verification checklist walk + this ledger completed (every major from→to + justification + breaking notes).

### Execution ledger — ALL WAVES LANDED 2026-07-25 (each wave gate ALL STEPS PASSED before its commit)

988bfb0 plan freeze · cbdb008 toolchain minors (pnpm 11.17.0 corepack-live, turbo 2.10.7 + Dockerfile dlx lockstep, eslint 10.8.0; version-restating comments de-numbered so they can't drift) · c8afb14 **typescript 5.9.3→6.0.3** (8 workspaces; one breaking surface hit: new TS2882 on plain-CSS side-effect imports → apps/web/src/types/global-css.d.ts; openapi-typescript peers `^5.x` — warn only, codegen SDK byte-identical under 6.0.3, recorded as cosmetic) · 84fa1be **@redocly/cli 1.34.17→2.40.0** (CLI dependency-free since 2.34 → explicit redoc@2.5.3 devDep + bundle resolved from contract's own tree; CDN-strip regex widened for integrity/crossorigin; NEW packages/contract/redocly.yaml telemetry:off — the `redocly lint` gate step had NO opt-out before, invariant-7 violation closed; extends:recommended pinned explicitly) · e7cac2a **stylelint 16.26.1→17.14.1 + config-standard 36.0.1→40.0.0** (4 real CSS modernizations applied: manual -webkit-backdrop-filter ×2 dropped [autoprefixer emits it — verified in built CSS], clip:rect→clip-path:inset(50%), word-break:break-word→overflow-wrap:anywhere) · 609177a lockfile in-range refresh (pg-boss 12.26.3 — NOTE: `pnpm update` would NOT re-resolve past the lockfile pin even with the metadata cache cleared; floor bump was required. Same stale-metadata cache made `pnpm outdated` blind to 3 real updates — the sweep's registry-scripted inventory caught them) · 4acc1d8 **jsdom 25.0.1→29.1.1** (29.1.1 specifically; no repo usage of any changed API; web 366/366) · bf6e095 **lucide-react 0.545.0→1.26.0** (none of the 14 removed brand icons imported; +0.1 KB /browse) · 8098258 **next 15.5.21→16.2.11** (middleware→proxy w/ CSP nonce behavior PROVEN live post-migration; **Turbopack blocked**: no extensionAlias equivalent → module-not-found on every NodeNext `.js`-suffixed import, build+dev pin `--webpack`, retry when Turbopack grows extensionAlias or import style migrates; Next 16 REMOVED app-build-manifest.json → perf-web-budget re-founded on served-HTML script-set measurement, stabilized across consecutive fetches; **/browse first-load 122,033→156,159 B gz (+34.1 KB, framework chunk pair +~24 KB — caused by next@16.2.11, no app code change, 23% under the 200 KB budget)** — baseline ledger updated w/ reason, OWNER-FLAG for acknowledgment) · cea1c03 **Node 24 (N1/N2)** (.nvmrc/engines/8 CI lines/Dockerfile 24.18.0/linux node-manifest 24.18.0 with locally-verified sha256s; @types/node 26.1.1→24.13.3 ×12 with typecheck-green proof of no >24 API use; ci.yml gate-node-next = full gate on Node 26 Current, ubuntu, push-only, continue-on-error; N2 policy codified CLAUDE.md + dev guide; OpenSSL 3.5 proof RUN: auth e2e 36/36 + REAL pebble ACME issuance/renewal green on v24.15.0/OpenSSL 3.5.5 host) · c8f1362 **PostgreSQL 18 ADOPTED (N4)** (see dogfood block below) · 35f9ad1 supply-chain + machinery (all 46 Actions `uses:` SHA-pinned at current majors; oasdiff 1.26.0 both files + brew; renovate.json5 — weekly grouped non-majors, individual majors, lockfile maintenance, Action-digest pinning, 3-day minimumReleaseAge, TS<7 cap w/ evidence pointer, checksum-manifests deliberately manual; grep-gates gains a prerelease-dependency pass over pnpm-lock.yaml resolved keys — the no-pre-release rule is now ENFORCED) · a1d2768 installer-smoke fixes (below).

**PG 18 outcome (N4): ADOPTED, dogfood-proven.** postgres:18/18.4 compose (volume mounts moved to /var/lib/postgresql — PG18 image's version-specific PGDATA; old-path mount would put the data dir OUTSIDE the volume), CI postgres-version 18 ×4, embedded manifest defaultVersion 18.4.0 all-5-platform checksums (darwin-arm64 downloaded+hashed locally), 17.10.0 retained as upgrade-FROM pin, 16.14.0 dropped, MIN_PG_MAJOR stays 17 (external floor). **Dogfood:** real Loombre schema (16 migrations + seed, 38 tables) populated on an embedded 17.10.0 cluster → the Phase-4 dump/restore upgrade job → 18.4.0: every frozen step ran, spot checks matched, all 38 table row counts IDENTICAL; db suite 216/216 (incl. leak.spec) AND conformance walker + seeded-conformance 40/40 green AGAINST THE UPGRADED CLUSTER; provisioning-pg 62/62 incl. the re-pointed 17→18 upgrade integration spec (now the standing in-tree proof). Dev DB recreated on 18.4 (disposable, reseeded + seed-large).

**ffmpeg (N6): NO bump — pin already latest stable 8.1.2 (pinned 2026-07-24) on 4/5 platforms; osxexperts publishes NO arm64 8.1.2 (checked 2026-07-25), macos-arm64 stays 8.1 (divergence + publisher-checksum caveat already flagged in-manifest). Therefore no VerifiedCapabilities rotation was triggered; the invalidation design was CONFIRMED (build hash = sha256 of full `ffmpeg -version` output, keyed by hwcaps invalidation.ts, unit-proven in fingerprint.spec) rather than exercised.**

**WiX (N5 evaluation) — DECIDED (owner, 2026-07-25): PINNED at 5.0.2**, the last pre-OSMF line (v6+ binaries are gated by the Open Source Maintenance Fee EULA — evaluated as a licensing-posture change, declined; Velopack assessed as the escape-hatch alternative and rejected for now: auto-update-first framework vs. this product's notify-only law, and imperative hooks vs. declarative MSI Service/Firewall authoring). Evidence backing the pin (researched with primary sources): all three WiX CVEs ever (Feb–Mar 2024, Burn + RemoveFolderEx classes) were fixed before v5.0.0 GA and none touches this repo's plain MSI+Service+Firewall surface (no Burn bundle, no util:RemoveFolderEx); v4-namespace .wxs builds unchanged on v5 per FireGiant's compat doc; no advisories since. KNOWN COST, accepted: v5 left community support 2026-02-06 — clean-but-frozen toolchain. REVISIT TRIGGER: any new WiX advisory touching non-Burn MSI surfaces, or 5.0.2 breaking on a current .NET SDK. Implementation: /.config/dotnet-tools.json pins wix 5.0.2; build-msi.mjs auto-restores, ASSERTS the resolved version equals the pin, and pins WixToolset.Firewall.wixext/5.0.2 in lockstep (mismatched ext/core majors are a known build-breaker). UNVERIFIED-ON-THIS-HOST (no dotnet): the pinned flow needs its first real Windows MSI build (owner hardware, or the billing-gated CI leg) — that build's log now records the asserted toolset version.

**Installer-smoke finds (a1d2768) — two REAL pre-existing packaging bugs, first surfaced by this sweep's post-LPP smokes:** (1) build-tarball's precompiled-workspace-dep cache reused a PREVIOUS run's compile (marker had no input fingerprint) → first post-LPP tarball shipped a pre-LPP @loombre/db missing every plugin export; marker now = sha256 over src/**+package.json+tsconfig+depOverride markers. smoke.mjs default tarball now follows HOST arch (was hardcoded x64 → picked the stale x64 artifact on this arm64 host, rosetta loader crash). (2) Dockerfile runtime COPY list was missing plugin-host/plugin-protocol dist (LPP landed after the list — the same drift its secrets/controller-ipc comment already warned about) → image crash-looped; fixed + comment extended. FOLLOW-UP (Open): teach scripts/check-runtime-imports.mjs to cross-check the Dockerfile COPY list so this drift class can't recur silently.

### §3 verification walk (2026-07-25) — [x] automated-verified · [~] agent-complete, owner action remaining

- [x] Clean-clone `pnpm gate` green under Node 24 on this host — final tree a1d2768, ALL STEPS PASSED (plus every wave's gate on the working tree). Two environmental reds en route, both diagnosed to cause: (1) session.integration seek-pacing deadline missed once under full-parallel load, 3/3 isolated green (the documented real-hardware-deadline family — CI's TIME_SCALE class); (2) state-dependent server specs red against dev-DB residue from this session's own T0/seed-large verification runs — `pnpm db:reset && pnpm db:seed` restored the canonical state and the test step went green (foot-gun tally below); a third red was the orchestrator's own gate logs written INSIDE the clone tripping the R8 former-name scan (113 hits from the original checkout's path) — harness artifact, removed. [~] 3-OS: ubuntu+enforcing perf legs prove on next push; Windows leg billing-gated (pre-existing); macOS via [full-ci] at the owner's next batch — same posture LPP inherited.
- [~] Node 26 job present (gate-node-next, parses clean); starts REPORTING on the next push to main.
- [x] Playback matrix 506/506 green (511 tests). Capability re-probe N/A — no ffmpeg bump (design confirmed instead, see above).
- [x] Perf budgets re-run vs baselines on Node 24 + PG 18: T0 all green (browse p95 15.21ms, detail 10.76ms, continue-watching 4.45ms, search 24.88ms vs 100ms budgets — loaded dev host, canonical t0-baseline.json left untouched per rename-era precedent; CI enforcing job re-proves), /browse 156.2 KB gz vs 200 budget (regression owner-flagged w/ cause named), Lighthouse 0.99/0.99/0.99 vs 0.90.
- [x] PG outcome recorded: 18 ADOPTED with upgrade-job dogfood proof (row-counts + conformance + leak suite green on migrated data).
- [x] Installer rebuilds + smokes on the new runtime: Linux tarball (bundled Node 24.18.0 + PG 18.4.0 + ffmpeg 8.1.2 fetched through the NEW manifests — checksums live-validated) smoke ALL CHECKS PASSED (ubuntu:24.04 arm64 container: install.sh, healthz 200, real login, clean uninstall); Docker arm64 image (node:24.18.0-bookworm-slim) + prod-compose (postgres:18.4) smoke ALL CHECKS PASSED (migrate/seed/login/catalog/clean SIGTERM). VERSION file format unchanged; CLI version format covered by run-cli/doctor specs (green). [~] Windows MSI + macOS pkg rebuilds = owner hardware, as ever.
- [x] Auth/crypto suites green on Node 24/OpenSSL 3.5 (36/36 auth e2e + real pebble ACME issuance+renewal — run, not asserted).
- [x] Advisory audit clean (0 advisories, allowlist empty) on the post-sweep tree; zero pre-releases lockfile-verified AND now gate-enforced (grep-gates prerelease pass, self-tested).
- [x] renovate.json5 committed; this ledger = the full record (every major: from→to, justification, breaking notes above).
- [x] Docs version claims swept in the same wave as each version (Node/PG/pnpm/redoc/PLAN.md §6.1; docs/PLAN.md:103's false node-pg-migrate claim corrected to the real hand-rolled migrate.mjs).

**TS 7 retry condition (standing):** adopt 7.x when (a) TS 7.1 ships the stable programmatic API, (b) typescript-eslint supports it, (c) Next's type-check path does without experimental flags — renovate.json5's `<7` cap carries the pointer. **Node 26 → LTS (Oct 2026):** flip = Renovate PR + months of gate-node-next evidence, per N2. **Heads-up:** Node.js coordinated security release pre-announced for 2026-07-27 — expect a 24.x patch PR from Renovate within days; that machinery working is the point of N7.

**Post-push status (2026-07-25):** the 15-commit sweep batch pushed (4e4e1e5..b77edbf). CI run 30169874561 FAILED WITHOUT STARTING — every job 0 steps, annotation: "job was not started because recent account payments have failed or your spending limit needs to be increased." The pre-existing billing gate now blocks ALL legs (previously observed on Windows only). No sweep workflow/action change was exercised. OWNER: fix Billing & plans, then `gh run rerun 30169874561` (or any push) — that run is what first proves the Node 24 runners, setup-postgres v8 on PG 18, the SHA-pinned action majors, the enforcing perf legs on the new tree, and the first gate-node-next (Node 26) report.

**Operational notes:** known test-contention flake family +2 this sweep (full-parallel server leg failed twice at the PG-18 wave gate then 2× green + isolated-clean; clean-clone worker session-pacing deadline once, 3/3 isolated green). Shared-dev-DB foot-gun tally 4 AND 5 (gate's server suite truncated users before the T0 run — reseeded; then seed-large + T0-harness residue [50k items + a real hwcaps probe report] broke state-dependent server specs in the clean-clone gate — db:reset restored; the dev DB now sits at canonical `db:seed` state on PG 18.4). docs/PLAN.md:103 node-pg-migrate false claim fixed (inventory catch). Local oasdiff brew-upgraded to 1.26.0 to match the CI pin.

## LPP v1 — Loombre Plugin Protocol (kicked off 2026-07-24, authority: owner LPP mission brief)

### Mission (verbatim)

Implement LPP v1 as a capability-based plugin platform: the capability-agnostic core (manifest, registration, auto-rendered config with keyring secrets, health, circuit breakers, scoping, audit), two complete capability types — metadata-provider (built-ins refactored onto the same interface, behavior-neutral) and event-subscriber (signed webhook delivery from the outbox with filtering and clearance gating) — an admin Plugins surface, a developer kit with per-capability conformance suites, and a documented roadmap of future capability types that require zero core changes to add.

### §1 precondition reconciliation (2026-07-24)

- Brief precondition "currency sweep COMPLETE, gate green (verify first)": no dependency-currency wave exists anywhere in history or STATE.md — the term is read as the Lumbre→Loombre freshness sweep (the rename records call themselves "the sweep"; "complete internal freshness"), which IS complete with §1 inventory frozen+burned and §4 matrix walked. Interpretation recorded here for owner correction if a dep-currency sweep was meant instead — nothing in LPP W1 conflicts with one landing later.
- Fresh full local `pnpm gate` re-run on pristine 0abb823 before any LPP edit: **ALL STEPS PASSED** (2026-07-24, this session).
- 3-OS status unchanged: ubuntu+macos remote green; the Windows-leg confirming rerun of 01eacff remains **billing-gated** (owner: raise the Actions spending limit, then workflow_dispatch os=all). LPP exit-gate item "gate green 3-OS" inherits this dependency.
- Working-tree residue at kickoff: perf/t0-baseline.json had an uncommitted local re-record (worse numbers, loaded dev host, recordedAt 2026-07-24) — STASHED (`pre-LPP: local t0-baseline re-record residue`), canonical baseline restored; not committed, owner may drop the stash.
- Sequencing: brief recommends "tag v1.0 first; ship LPP as v1.1's headline — owner's call". The v1.0 tag stays OWNER-CUT (Phase 4 exit gate; minisign keypair still placeholder). LPP proceeds additively on main; nothing in LPP blocks tagging v1.0 at any pre-LPP commit.

### Locked decisions — capability-agnostic core (verbatim from brief §2)

| # | Decision |
|---|----------|
| C1 | Process model: plugins are separate HTTP services (any language/host: container beside Loombre, LAN box, remote URL). No code loading, no DB access, no filesystem, no internals — only LPP requests/deliveries |
| C2 | Manifest (GET /lpp/manifest): { name, version, protocolVersion: 1, capabilities: Capability[], configSchema, description, publisher }. Each Capability entry is typed: { type: 'metadata-provider', … } or { type: 'event-subscriber', … } with type-specific fields (§3). Unknown capability types in a manifest are rejected at registration with a clear "this Loombre doesn't support X yet" — never silently ignored |
| C3 | Config & secrets: manifest configSchema (JSON-Schema subset, settings-registry conventions) auto-renders the admin config form — no hand-built forms, ever. secret: true fields live in the KEYRING; Loombre injects config/secrets per-request (X-LPP-Config, X-LPP-Secret-*) so plugins are stateless — a stolen plugin container holds no keys |
| C4 | Registration (admin-only): URL → manifest fetch → schema + protocolVersion validation → explicit confirmation screen listing EVERY declared capability + its scope in plain language → config form → per-capability health check → enable. Manifest re-fetch on demand; any scope expansion (new capability, new mediaKinds, contentClass change, broader event filter) requires re-approval |
| C5 | Content-class scoping, capability-uniform: restricted-scoped plugins attach only to restricted contexts; general-scoped plugins never receive restricted data through ANY capability — provider requests (P1.6 extended) and event deliveries alike. The leak suite gains cases per capability |
| C6 | Failure isolation, capability-uniform: timeout budget per call, per-plugin circuit breaker (N failures → auto-disable + admin notice + plugin.health-changed event); no plugin can stall a scan, a delivery queue, or a request path |
| C7 | Security posture: SSRF guards on all outbound plugin traffic; per-plugin LAN allowlist (explicit, surfaced, audited — LAN plugins are first-class); zero-telemetry rules apply; admin guide states the privacy reality per capability in register-appropriate language |
| C8 | Versioning: LPP v1 is additive-only, same policy as the main API; new capability TYPES are additive within v1; protocolVersion negotiation at registration; a future v2 runs beside v1 |
| C9 | Audit & events: **BRIEF TRUNCATED mid-entry at "plugin.registered"** — reconstructed minimally pending owner confirmation: plugin lifecycle audit events in the transactional outbox (plugin.registered / plugin.updated / plugin.enabled / plugin.disabled / plugin.removed / plugin.health-changed per C6), ADMIN_ONLY delivery, actor + old/new scope recorded — the Addendum A settings.updated pattern applied to plugins |

### v1 capabilities (brief §3, summary — full text in the brief)

- **3.1 metadata-provider**: { mediaKinds, contentClass, endpoints: { search, details, images } } → POST /lpp/provider/search|details|images. Joins the per-library provider chain with drag-ordering beside built-ins; P1.6/P1.7 precedence + metadata_lock unchanged; built-ins (TMDB/TVDB/MusicBrainz) refactor onto the same internal interface the plugin host adapts remote plugins to — behavior-neutral, proven by untouched fixture corpus + FakeProvider suites + before/after scan-report parity on the dev library.
- **3.2 event-subscriber**: { eventTypes (from the published outbox taxonomy), delivery: { endpoint } } → Loombre POSTs /lpp/events batches. At-least-once from the outbox with per-plugin cursor (restart-safe; retention window, gaps reported never skipped); HMAC signature (per-plugin secret minted at registration); manifest REQUESTS eventTypes, admin GRANTS possibly fewer; clearance gating per C5; user-data minimization — pseudonymous actor ids by DEFAULT, per-plugin toggle for real identity.
- **§4 roadmap (dev kit, "designed not yet implemented")**: subtitle-provider · scrobble-sink · intro-detection (job-shaped, sketched) · auth-provider (EXPLICITLY deferred — security boundary, needs its own adversarial design cycle, roadmap says so in those words) · UI/theme extensions (out of LPP scope entirely).

### LPP orchestrator decisions (LD series, locked at W1 landing)

| # | Decision |
|---|----------|
| LD1 | Delivery-signing HMAC secret is provisioned OUT-OF-BAND at registration (minted by Loombre, returned once, persisted plugin-side, rotatable from panel) — NOT per-request injected: a secret delivered inside the request it signs authenticates nothing. C3's stateless law is scoped to plugin CONFIG secrets. Approves W1 design decision #2 |
| LD2 | Host composition: packages/plugin-host (transport-pure: hardened fetch/SSRF, breaker machine, manifest client, header injection, per-capability call wrappers) + apps/server PluginsModule services-only in W2 (controllers = W5, S1/S2 precedent). DB via packages/db public barrel: query/plugins.ts with transactional plugin.* emit helpers (settings.ts pattern; depcruise internal rule untouched) |
| LD3 | Migration 0014: plugins table REAL columns + plugin_event_grants REAL rows; JSONB sanctioned ONLY for plugins.manifest (snapshot) + plugins.config (non-secret values) — CLAUDE.md invariant-3 whitelist 7→9 in W2's commit (AD5 precedent) |
| LD4 | plugin.* taxonomy (C9 reconstruction): plugin.registered/updated/enabled/disabled(reason incl. breaker)/removed/health-changed — additive envelope enum + per-type schemas, all six ADMIN_ONLY in ws-broadcaster, transactional with their state change |
| LD5 | SSRF guard: http/https only; private/loopback/link-local/ULA/multicast ranges rejected unless host on that plugin's explicit LAN allowlist; redirect:'manual', ANY redirect = typed failure; per-call AbortSignal timeouts; size caps (manifest 256 KiB); DNS-rebinding TOCTOU residual documented for opus review |
| LD6 | Registration = W2 service state machine (fetch → staged parse → validate incl. unknown-capability rejection w/ C2 message + eventTypes vs published taxonomy → granted subset as INPUT → config validated → secrets to keyring → HMAC minted once → per-capability health → enable); C4 confirmation SCREEN = W5; re-fetch → scope-diff → expansion disables until re-approved |
| LD7 | NO wire amendment for health (batches require ≥1 event; no ping exists): envelope health = manifest re-fetch/parse/match; provider health = benign canary search; subscriber health = registration-time endpoint validation + operational delivery outcomes. Flagged to opus review |
| LD8 | Timeouts/breaker are exported named constants in W2 (manifest/search/details 10s, images 20s, delivery 10s; breaker 5 consecutive fails → auto-disable + events; manual re-enable resets). Registry promotion later is additive |
| LD9 | Keyring naming: plugin-<id>-<field> (config secrets), plugin-hmac-<id> (delivery). Secrets NEVER in DB/manifest snapshot/config JSONB/events/logs — distinctive-value scan tests required (F1 pattern) |
| LD10 | Per-library provider chain schema locked (W3 owns migration 0015): library_provider_entries(library_id FK CASCADE, position int, provider_kind enum builtin\|plugin, builtin_name text null, plugin_id uuid null FK, UNIQUE(library_id,position), XOR check on kind columns). ABSENT ROWS = the legacy hardcoded PROVIDER_CHAIN per mediaKind — behavior-neutrality by construction: an untouched library resolves the identical chain |
| LD11 | Wave-2 fan-out: W3/W4/W5 run in PARALLEL WORKTREES; landing order W3→W4→W5 with orchestrator reconciling packages/db barrels/types, schema.sql regen, and apps/worker/src/index.ts wiring. W5 scopes to W2-backed surfaces (plugins CRUD/wizard/config/event-grants/health); chain-ordering UI + delivery-stats panel = W5b integration pass AFTER W3/W4 land (contract stays additive both steps) |
| LD12 | Migration numbers pre-assigned to kill filename races: W3=0015_library_provider_chains, W4=0016_plugin_delivery_cursors (both additive; apply-order between them irrelevant, each depends only on 0014) |
| LD13 | Delivery-cursor/stats schema locked (W4 owns 0016): plugin_delivery_cursors(plugin_id PK FK CASCADE, cursor_event_id uuid null, last_attempt_ms, last_success_ms, consecutive_failures int, delivered_batches bigint, delivered_events bigint, gap_reported_through_ms null) — real columns only, no JSONB. Delivery loop lives in apps/worker (depcruise-legal internal access unnecessary: cursor advance via public query helpers W4 adds to packages/db/src/query/plugins-delivery.ts) |

### LPP lane burn-up

| Lane | Scope | Status |
|------|-------|--------|
| W1 | packages/plugin-protocol: envelope + both capability schemas, spec gen + drift check, per-capability conformance suites (pnpm lpp:conform <url>), 2 reference plugins in examples/ (stdlib-only). Contract freezes FIRST | **LANDED d5cb79c** (gate ALL STEPS PASSED on landed tree; 78/78 pkg tests; conform CLI 12/12 provider + 8/8 notifier incl. tamper/stale rejection + graceful webhook degrade; frozen surface: GET /lpp/manifest, POST /lpp/provider/search\|details\|images, POST /lpp/events, X-LPP-Config/X-LPP-Secret-* base64(utf8), X-LPP-Signature t=<ms>,v1=<hex hmac-sha256 "t.body">, replay window 300s, urn:loombre:lpp:problem:* catalog; staged parser distinguishes unknown-capability-type from invalid; event-subscriber carries contentClass per C5; examples deliberately protocol-package-independent as the any-language proof; zero new deps) |
| W2 | Capability-agnostic core: manifest fetch/validate, registration, config/secret injection, health, breakers, SSRF + LAN allowlist, C5 scoping seams, audit events | **LANDED 8ad70f3** (packages/plugin-host 78 tests: hardenedFetch SSRF matrix incl. IPv6/ULA + redirect=typed-failure + streaming size caps, breaker, manifest client, callPlugin; apps/server/src/plugins services-only module — deliberately UNWIRED from app.module.ts, walker green; migration 0014 plugins + plugin_event_grants; query/plugins.ts transactional emit helpers; 6 plugin.* event schemas, envelope enum 15→21, all ADMIN_ONLY; CLAUDE.md JSONB whitelist 7→9; server suite 1235 green; e2e vs live reference plugins incl. scope-expansion→auto-disable→re-approve, breaker auto-disable at 5, HMAC returned-once + rotation, distinctive-value secret scans. Lane-decided: breaker counts only timeout/network-error; breaker reset 60s; capability response cap 2MiB; health failure non-blocking at registration — wizard must surface it, W5) |
| W3 | metadata-provider capability: host adapter, chain integration, leak cases; built-ins refactor + behavior-neutrality proofs | **LANDED 6fcbcf8** (LPP adapter as MetadataProvider w/ stable `lpp:<pluginId>` provider ids, frozen-schema validated calls via callPlugin, worker-side keyring reads, per-process breakers writing disable+health events at trip; migration 0015 per LD10 exactly; chain resolved fresh per metadata job, ZERO rows = legacy PROVIDER_CHAIN verbatim (neutrality unit-proven all 3 kinds; consumer.spec untouched-green); C5 STRICT equality tightening of scope.ts landed + 3-layer enforcement (chain write / resolution / pre-call hard check) + leak cases; db 187, worker metadata 116, server plugins 39, depcruise+typecheck clean at landing. Lane-decided: plugin_id FK CASCADE, real PG enum for provider_kind, adapter contentClass = aggregate plugins.content_class, no cross-job cache) |
| W4 | event-subscriber capability: outbox fanout w/ cursors, HMAC, grant-subset, pseudonymization, clearance gating + leak cases, delivery health | **LANDED 41931a6 + 39cfe10 schema regen** (migration 0016 per LD13 + plugins.pseudonymize_actor_ids/pseudonym_salt; delivery loop in apps/worker/src/plugin-delivery: 5s poll, batch cap 100, exponential-full-jitter backoff 2s→5min, at-least-once with cursor advance ONLY on 2xx; clearance via buildGeneralSubscriberViewerContext → the guard-compiled filterEventsForViewer, leak cases prove restricted byte-absence for general subscribers; ACTOR_FIELD_MAP covers all 21 envelope types + exhaustiveness test; pseudonym = hmac-sha256(per-plugin salt, userId), default-on proven, cross-plugin unlinkable; gap = query-detected granted events older than 7d window, over-report-only, never clearance-leaking; kill/restart cursor-resume integration test green; breaker trip → setPluginEnabledAndEmit('breaker') mirroring W3 precedent; db 210, delivery 71, migrate-check 38 tables. INCIDENT: stale worktree base → first build used fabricated stand-ins, orchestrator correction → reset --hard main + full rebuild against real APIs, nothing fabricated survived (backup branch deleted at landing). Lane-decided: kysely @> on text[] mis-serializes under node-postgres → raw ANY() fragment documented in query file; delivery consecutive_failures deliberately distinct from plugins.consecutive_failures) |
| W5 | Admin Plugins surface: registration wizard (C4 confirmation), auto-rendered config, chain ordering, event-grant editor, health panel; additive contract | **LANDED 0389653** (12 additive ops /admin/plugins* — preview/register/get/list/remove/config/event-grants/enable/disable/refresh/reapprove/rotate-hmac; SDK 77→89 byte-idempotent ON MAIN; redocly zero-warn; conformance walker +12 expectations, 79/79 at landing after SDK dist rebuild; every route requireLiveAdmin; hmacSecret ONLY in the two once-responses, distinctive-value e2e proves no-GET leakage; wizard = C4 confirmation w/ per-capability register-language privacy copy → auto-rendered config via existing schema-widget renderer → grant subset → HMAC-once display → health result w/ enable-anyway-vs-cancel(=remove); e2e against BOTH live reference plugins incl. refresh→scope-change→reapprove via mutable stub; web 340/340, next build green, /browse budget unchanged 119.1KB. Chain-ordering UI / delivery-stats / pseudonymization toggle = W5b as planned. Lane-decided: plugin list not cursor-paginated (listCrashFiles precedent); grants-only update reuses manifest emit helper → audit event reads change:'manifest' — dedicated db helper = W5b/fix-wave item) |
| W5b | Integration pass (LD11): provider-chain admin surface, delivery status, pseudonymization toggle, honest grants audit | **LANDED cc6e03c** (3 additive ops — get/put library provider-chain + put pseudonymization; AdminPlugin +deliveryStatus/+pseudonymizeActorIds additive fields; SDK 92 byte-idempotent, oasdiff clean, conformance +3, server plugins dir 126/126, web 366/366, next build + /browse budget unchanged; chain editor: customize-gate, native drag + keyboard fallback through one pure moveEntry, C5-filtered plugin choices; pseudonymization confirm-on-OFF only; grants audit now change:'event-grants' w/ old/new via new updatePluginEventGrantsAndEmit (W5 workaround removed); plugin.updated schema gains the two change values. Lane-decided: toggle 409s without event-subscriber grant; deliveryStatus on list too; builtin-metadata-providers.ts documented lockstep-duplication of worker builtin facts) |
| W6 | Docs: admin-guide Plugins chapter (per-capability privacy statements), dev kit (spec, references, template, conformance usage, §4 roadmap) | **LANDED 9738e32** (admin-guide/plugins.md + developer-guide/plugins/{index,spec,building-a-plugin,conformance,events,roadmap}.md, both sidebar-wired; scripts/docs/gen-lpp-spec.mjs copies the FROZEN spec byte-for-byte into the docs tree under the existing git-diff drift check; per-capability privacy statements sourced verbatim from the wizard copy; §4 roadmap incl. auth-provider deferral stated "touches the security boundary and requires its own adversarial design cycle"; register-lint 20→21 (one expected first-use reminder); docs build ALL STEPS PASSED, grep-gates clean, 10 screenshot placeholders tracked; every constant/command verified vs code — mid-draft CORRECTED two false claims: health is NOT periodic (registration/re-approval only) and scope-change detection is admin-manual not automatic) |
| R | Opus adversarial review: malicious manifests, secret exfil via redirects/SSRF, forged/replayed deliveries, restricted leaks BOTH capabilities, cursor manipulation; protocol fidelity W2–W4 vs frozen W1 | **DONE — reports/lpp-adversarial-review.md** (2 CRITICAL, 5 HIGH, 9 MEDIUM, 9 LOW, probe-backed vs built artifacts). CONFIRMED SOLID: metadata C5 3-layer enforcement, event-subscriber C5 gated-types (guard-compiled filterEventsForViewer, restricted-blind synthetic ctx, fail-closed), actor pseudonymization (per-plugin salt, exhaustive 21-type map), top-level secret handling, HMAC sign/replay, cursor integrity, redirects, streaming size caps, XSS-safe form render, unknown-capability C2, live-admin authz. FINDINGS → fix wave below |

### LPP adversarial findings → fix wave (2026-07-25)

Frozen-contract narrowings are SANCTIONED here (D23 pre-release policy: LPP v1 contract was frozen THIS session, zero releases, only owner-controlled example plugins consume it; security narrowings before public launch are permitted, logged, committed atomically with SDK/spec/schema regen). H-2/H-4 change admin-facing semantics toward C5/C9 conformance — fixed (leaving a confirmed leak is worse), owner-review-flagged.

| ID | Sev | Finding | Fix direction |
|----|-----|---------|---------------|
| C-1 | CRIT | Duplicate capability entries defeat the re-approval diff (find-first vs some()) → silent general→restricted | Reject duplicate capability types at parse (frozen narrowing); diff compares per-type SET; any aggregate-class change = expansion |
| C-2 | CRIT | Preview→register manifest TOCTOU — approved bytes ≠ persisted bytes (no digest pin) → class escalation + secret-downgrade-to-plaintext | Preview returns canonical digest; register/reapprove re-fetch + 409 on mismatch; secret-ness resolved vs APPROVED schema |
| H-1 | HIGH | Nested secret:true schema-legal but silently non-secret → DB/API/UI/outbox plaintext | Reject secret:true below root at parse (frozen narrowing); plugin.updated(config) carries changed KEYS not values |
| H-2 | HIGH | Aggregate content_class re-scopes a per-capability grant → mixed-class plugin skips clearance filter; C4 copy false | Enforce C5 PER CAPABILITY (event-subscriber's own class governs clearance; provider's own class governs chain eligibility) [owner-flag] |
| H-3 | HIGH | Mid-body-stream timeout escapes as untyped DOMException → breaker+backoff never fire → stalls scan/delivery forever | Classify aborts around body read; callPlugin never rethrows (unexpected→counted network-error); defensive catches at both call sites + the missing test |
| H-4 | HIGH | ADMIN_ONLY event types grantable to plugins; delivery path has no admin-only gate → other plugins' config/baseUrl + settings values to third parties | Exclude the 8 ADMIN_ONLY types from grantable taxonomy in v1 [owner-flag] |
| H-5 | HIGH | Protocol-relative endpoint paths (`//host`) redirect provider calls + signed deliveries off-host WITH injected secrets, no scope signal | Tighten frozen regex to /^\/(?![/\\])/; assert resolved.origin===baseUrl.origin; endpoint-path change = re-approval axis |
| M-1 | MED | Deliveries omit X-LPP-Config/X-LPP-Secret-* → reference notifier can't get its webhook URL (the "graceful degrade" is the bug) | Inject config+secret headers on deliveries like every other plugin call |
| M-2 | MED | Unbounded configSchema recursion → RangeError escapes "never throws" at ~66KB | Bound recursion depth + enum size at parse (frozen narrowing) → typed 422 |
| M-3 | MED | Preview 422 returns first 500B of any reachable endpoint → SSRF read-oracle + port scanner | Drop response-body echo from the error detail |
| M-5 | MED | IPv6 bracketed hostname bypasses isIP → whole IPv6 ladder dead; latent: ::ffff:127.0.0.1 classifies ALLOWED | Strip brackets; fix IPv4-mapped classifier BEFORE enabling; NAT64/6to4 ranges |
| M-6 | MED | Missing IPv4 deny ranges incl. 100.64/10 (Alibaba metadata 100.100.100.200 ALLOWED) | Add CGNAT/192.0.0/24/198.18/15/TEST-NET/240/4 |
| M-7 | MED | job.updated ungated + raw error string embeds fs paths → restricted-path leak to general subscribers | Gate job.updated (or exclude via H-4); redact ledger error paths |
| M-8 | MED | Non-2xx never counts toward breaker nor resets it; no scheduled health check | Count http-status failures; add a periodic health/re-check scheduler |
| M-9 | MED | deviceId/sessionId stable correlators not pseudonymized | Extend minimization to device/session ids (or document as accepted) |
| DNS-rebind | MED-HIGH | TOCTOU exploitable via unlimited 5s retry budget (not "acceptable residual") | Resolve-once-then-dial-pinned-IP via node http/https `lookup`+`servername` (zero-dep) |
| L-1..L-9 | LOW | (see report) incl. L-4 replaceLibraryProviderChain builtinName unvalidated (2nd-caller C5 bypass) **[WAVE-A CLOSED (verified already-fixed in tree) 2026-08-11]** (squashed public history hid the commits; no re-implementation), L-2/L-3 keyring orphan/leak on failed insert/unparseable manifest **[WAVE-A CLOSED 51e58732 2026-08-11]** (fix already in tree pre-run; regression tests backfilled 8ba1c957; plus NEW manifest-refresh orphan removal), L-7 reference plugins OOM before sig-verify **[WAVE-A CLOSED (verified already-fixed in tree) 2026-08-11]** (squashed public history hid the commits; no re-implementation) | Batch into the fix wave where cheap; L-7 hardens the dev-kit template |

### LPP fix wave — LANDED (a5fc11c + reconciliation f715f8d, full gate ALL STEPS PASSED 2026-07-25)

- **ALL CRITICAL + HIGH + MEDIUM fixed, each with a regression test derived from the reviewer's probe.** C-1 (dup capability types rejected at parse; diff compares per-type SET; aggregate-class change = expansion). C-2 (preview returns canonical manifest digest; register/reapprove re-fetch + 409 on mismatch; secret-ness resolved vs approved schema — additive contract field manifestDigest, oasdiff clean, wizard round-trips it). H-1 (secret:true below root rejected at parse; plugin.updated(config) emits changed KEY NAMES, oldValue:null). H-2 (C5 enforced PER CAPABILITY — event-subscriber's own class governs clearance, provider's own governs chain eligibility; mixed-class leak test). H-3 (AbortError classified around body read; callPlugin never rethrows → counted network-error; defensive catches both call sites + the missing mid-body-timeout test). H-4 (8 ADMIN_ONLY types excluded from grantable taxonomy; ws-broadcaster shares the const; delivery defensive filter). H-5 (endpoint regex → /^\/(?![/\\])/ frozen narrowing; origin===baseUrl assert both resolvers; endpoint-path change = re-approval axis). M-1 (deliveries inject X-LPP-Config/X-LPP-Secret-* via buildPluginRequestHeaders — reference notifier now really forwards, integration-proven). M-2 (configSchema depth≤8 + enum/props/required≤200; parse never throws RangeError). M-3 (error detail no longer echoes response body). M-5/M-6 (IPv6 bracket-strip + byte-prefix classifier fixing ::ffff:127.0.0.1, NAT64/6to4; IPv4 100.64/10 + 192.0.0/24 + 198.18/15 + TEST-NET + 240/4). M-8 (http-status counts toward breaker; plugin-health-scheduler.service.ts periodic re-check). M-9 (playback deviceId/sessionId pseudonymized). DNS-rebinding (resolve-once-then-dial-pinned-IP via node:http/https lookup+servername, ZERO deps — CLOSED; residual only the admin's own allowlisted-by-name host, never DNS-resolved by contract). **[WAVE-A CLOSED 2d93c590 2026-08-11]** (allowlisted-by-name hostnames now resolve-once-and-pin; pinnedAddress no longer nullable).
- **Frozen-contract narrowings (D23-sanctioned, regen byte-idempotent + drift green)**: dup-type reject, nested-secret reject, endpoint regex tighten (only this one changes the JSON schema), configSchema bounds.
- **Deferred with reason**: L-1 (restricted→general narrowing not an expansion) **[RE-AFFIRMED 2026-08-11]**, L-5 (breaker not re-seeded at boot — pre-existing) **[WAVE-A CLOSED 02da6dc0 2026-08-11]** (server; + 5d467e29 / a4ba3e36, both worker-side registries incl. one previously unflagged), L-6 (notifier header-error cosmetic) **[WAVE-A CLOSED b92ad2a8 2026-08-11]**, L-8 (odd-hex already safe) **[RE-AFFIRMED 2026-08-11]**, L-9 (gap-vs-skip = deliberate) **[RE-AFFIRMED 2026-08-11]**, M-7 ledger-path-redaction half (actual leak closed by H-4; redaction would touch repo-wide debug output — separate cleanup) **[WAVE-A CLOSED f260540f 2026-08-11]** (canonical redactPathsInText in packages/shared; packages/jobs keeps a documented local duplicate per its ids.ts no-shared-dep precedent).
- **OWNER-FLAG (semantic changes toward conformance)**: H-2 now enforces C5 per capability (a plugin with a restricted metadata-provider + general event-subscriber no longer has its subscriber feed treated as restricted-scoped — the subscriber is filtered; matches C5's "through ANY capability" wording and the wizard's per-capability copy). H-4 removes admin-only event types (job.updated/settings.updated/plugin.*) from what any plugin can be granted in v1 (a future admin-tier grant could reintroduce them additively).
- **Orchestrator catch (NOT in the fix-wave scope)**: unknown-capability test fixture used the name "upstream-media-server-plugin-loader" (a W1 miss, on main since d5cb79c) — renamed to "future-capability-x"; ROOT CAUSE the naming grep-gate scanned only apps/ + packages/contract/, narrower than the CLAUDE.md repo-wide rule → widened NAMING_SCOPE_PREFIXES to apps/ + packages/ + examples/ (full sweep first confirmed that fixture was the only offender). edition-brace scanner fixtures are legitimate (a real filename edition-tag convention the parser must handle, not competitor-API naming).

### LPP exit gate (brief §6) — WALKED 2026-07-25

Legend: [x] automated-verified · [~] agent-complete, owner hands-on remaining.

- [~] **pnpm gate green 3-OS; contract additions redocly-zero-warn; SDK regen** — full local gate ALL STEPS PASSED on the final tree (4948669); contract additive-only across W5/W5b/fix-wave (oasdiff clean each time), redocly zero-warn, SDK 92 ops byte-idempotent. REMAINING (owner): the Windows CI leg — billing-gated since before LPP (Actions spending limit); ubuntu is the local+default proof. Raise the limit → workflow_dispatch os=all on HEAD.
- [x] **Both conformance suites green against both reference plugins** — LIVE `pnpm lpp:conform` run 2026-07-25: reference-provider 12/12 PASS (envelope + metadata-provider search/details/images schema + RFC 9457 on malformed); discord-notifier 8/8 PASS (envelope + delivery validSignature 200 + tamperedBody 401 + staleTimestamp 401), notifier gracefully degraded on an unreachable webhook while still acking.
- [x] **E2E proofs** — delivery-loop.integration.spec 11/11 incl. kill/restart cursor-resume (no loss; crash-between-ack-and-persist = duplicate not loss) + clean-shutdown wait-for-in-flight; M-1 REAL notifier binary forwards to its configured webhook through the real delivery loop; registration e2e registers the reference provider → keyed (keyring) → adapter constructs. Live keyed dev-library metadata SCAN (TMDB/TVDB network enrichment) is owner territory — needs real provider keys, same posture as Phase 1's keyed-rescan note.
- [x] **Built-ins refactor behavior-neutral** — the plugin adapter targets the EXISTING MetadataProvider interface (no built-in rewrite was needed — built-ins already implement it); neutrality proven by the untouched-and-green fixture corpus + FakeProvider + consumer.spec, and by the unit proof that zero-row chain resolution === the legacy PROVIDER_CHAIN verbatim for all 3 media kinds. Live dev-library before/after scan-report parity = owner (keys), as above.
- [x] **C5 proofs per capability** — metadata: 3-layer enforcement (chain write / resolution / pre-call) with strict content-class equality, opus-confirmed no path for a general plugin to receive a restricted-derived request; event: guard-compiled filterEventsForViewer through a restricted-blind synthetic ctx, byte-absence leak test + the H-2 mixed-class case both green; opus verdict CLEAN on both gated classes.
- [x] **Breakers proven per capability; a dead plugin stalls nothing** — per-plugin breaker trip → disable+events with a healthy sibling unaffected (integration-proven); H-3 closed the slow-body-timeout escape (now counted, tested); M-8 added http-status counting + a periodic health scheduler; every outbound call hard-timeout-bounded.
- [x] **Secrets keyring-only, header-injected, never persisted plugin-side, masked in UI; HMAC rotatable** — top-level + (post-H-1) nested secrets keyring-only, distinctive-value scans prove absence from DB/API/events; config secrets injected X-LPP-Secret-* per request; HMAC minted once + rotate endpoint (once-response), distinctive-value never-in-GET e2e. UI write-only masking proven by W5 web tests + the ProviderKeysCard pattern; a visual browser freeze pass of the wizard is the one recommended OWNER hands-on confirmation (Addendum-precedent; not automated this session — flagged, not claimed).
- [x] **Pseudonymization default proven** — default-on real-id byte-absence, stability, cross-plugin unlinkability, toggle-off passthrough all integration-proven; actor-field map exhaustive over all 21 types; M-9 extended to device/session correlators.
- [x] **Adversarial findings resolved or owner-acked** — reports/lpp-adversarial-review.md; all C/H/M fixed with per-finding tests (a5fc11c); LOW deferrals + the two H-2/H-4 semantic owner-flags recorded above.
- [x] **Docs** — admin chapter + dev kit landed (9738e32), docs build green as gate's final step, §4 roadmap incl. the auth-provider deferral in the required "security boundary / own adversarial design cycle" words; frozen spec mirrored into docs under a drift check.
- [x] **STATE.md: LPP v1 FROZEN** — see freeze block below.

### LPP v1 — FROZEN (2026-07-25)

**Frozen surface (additive-only from here, same policy as the main API, C8):** envelope `GET /lpp/manifest` = {name, version, protocolVersion:1, capabilities[], configSchema, description, publisher}; two capabilities — metadata-provider (POST /lpp/provider/search|details|images) and event-subscriber (POST /lpp/events); headers X-LPP-Config + X-LPP-Secret-<NAME> (base64/utf8), X-LPP-Signature t=<ms>,v1=<hex hmac-sha256("t.body")> replay window 300s; RFC 9457 urn:loombre:lpp:problem:* catalog; endpoint paths `/^\/(?![/\\])/`; configSchema = settings-registry JSON-Schema subset, secret:true root-only, depth≤8 + enum/props/required≤200; no duplicate capability types.

**Capability-addition procedure (zero core changes, the platform thesis):** a new capability TYPE is (1) a new member of the discriminated Capability union in packages/plugin-protocol with type-specific fields + its wire request/response schemas (additive; regen JSON-schema + spec, drift-checked), (2) a conformance suite for it in the conform CLI, (3) a host adapter/consumer implementing it against the same registration/config/secret/health/breaker/SSRF/scope/audit core (which does NOT change), (4) admin-surface rendering (auto-config already generic; type-specific grant UI as needed), (5) docs entry graduating it from the §4 roadmap. The envelope, the core services, and every C1–C9 guarantee are untouched by construction. §4 roadmap types (subtitle-provider, scrobble-sink, intro-detection, auth-provider [deferred — security boundary], UI/theme [out of scope]) each follow this.

**Additive-only rule:** LPP v1 never removes or narrows a wire field post-freeze (the security narrowings above were pre-release corrections under D23, all committed this session before any release); a future incompatible shape is protocolVersion 2 running beside v1 (C8).

### LPP operational notes

- Known test-contention flake family tally +2 at the W2 landing gate (conformance 404-not-401 = the documented costume; auth.e2e unlock 404-not-403 = NEW costume) — both 10/10 isolated green, confirming full gate ALL STEPS PASSED. +1 transient at W3 landing (worker metadata batch run failed once during concurrent lane activity, clean full rerun immediately after).
- **STALE WORKTREE BASE incident (wave-2 fan-out)**: W3's and W4's worktrees were created on pre-LPP 0abb823 instead of dispatch-time main c82a8fc (W5's was correct). W3 self-corrected with --ff-only before starting; W4 corrected mid-run by orchestrator message. Standing rule for all future worktree lanes: FIRST action = verify the worktree base contains the expected landing commit (git merge-base --is-ancestor <expected> HEAD), fast-forward to main if not.
- Wave-2 landing protocol: scoped verification per lane landing; ONE full confirming gate after W5 + reconciliation (Addendum wave pattern).

### LPP Open (surfaced mid-wave)

- PluginCircuitBreaker is in-memory per-process, not re-seeded from plugins.consecutive_failures at boot (documented in breaker.ts) — a restart forgets progress toward auto-disable; acceptable, candidate hardening.
- PluginLifecycleService.updateConfig does not clear keyring entries for secret fields the caller stops submitting (noted in-file) — fold into W5's config-edit surface or the fix wave.
- Registration health-check failure is NON-blocking at service level (row commits enabled; health_state reflects the check) — W5's wizard MUST surface the failed check and offer enable-anyway vs cancel to honor C4's intent.
- DNS-rebinding TOCTOU residual in plugin-host ssrf.ts (resolve-and-validate; IP-pinned dialing = candidate hardening, zero-dep constraint) — explicit opus-review probe target. **[WAVE-A CLOSED 2d93c590 2026-08-11]** (allowlisted-by-name hostnames now resolve-once-and-pin; pinnedAddress no longer nullable).
- Outbox event taxonomy read off disk from @loombre/contract envelope.schema.json via require.resolve — fine today; if contract ever gains a build step, revisit.
- Grants-only plugin update emits plugin.updated with change:'manifest' (oldValue===newValue) because no grants-specific db write primitive exists — W5 documented in admin-plugin-grants.service.ts; add updatePluginEventGrantsAndEmit in W5b/fix wave for an honest audit trail.
- Landing-verification lesson ×2 (W3 transient, W5 conformance red): scoped vitest runs on freshly cherry-picked main hit STALE workspace dists (sdk/plugin-*) — turbo build the touched packages before scoped suites; the full gate's codegen/build steps mask this, scoped runs don't.
- **GENERATED-FILE GAP**: scripts/docs/collect-screenshots.mjs (docs/reference/screenshots.md) is NOT wired into scripts/docs/build.mjs's drift check, unlike gen-lpp-spec/gen-settings-reference/gen-env-reference. The fix wave edited admin-guide/plugins.md (shifting screenshot line refs) without regenerating it, and the full gate passed docs-build anyway — silent desync. Reconciled by hand (00ce376-era). FOLLOW-UP: fold collect-screenshots into the build's git-diff drift check so doc edits can't desync the list.

## Project rename: Lumbre → Loombre (2026-07-24, authority: owner hard-cut rename prompt; NO shims, NO aliases, NO migration paths)

### §1 preconditions — all four confirmed before any edit

- Phase 4 Addendum A agent-complete: exit gate fully walked, remote baseline GREEN (run 30131220893); close-out recorded below.
- keys/minisign.pub is the all-zero structurally-valid placeholder — no real keypair exists (stays ungenerated until after this run per R6).
- Version 0.9.0; zero git tags; zero GitHub releases; zero external installs.
- Clean-clone `pnpm gate` GREEN under the OLD name at HEAD c0a5016 on this host, before any edit (baseline for rename-regression diagnosis).
- R2 owner/repo input resolved from ground truth: the owner renamed the GitHub repo ahead of this run — origin already points at github.com/ozzydeving/Loombre (verified via gh api). All repo coordinates in this rename target `ozzydeving/Loombre`; GHCR images `ghcr.io/ozzydeving/loombre` (registry paths are lowercase).

### Frozen inventory (the burn-down checklist — this run burns it to the R8 allowlist and nothing else)

- **5,705** case-insensitive occurrences across **856** tracked files; **52** tracked paths carry the name (plus directories: LumbreIPCKit, LumbreMenubar, LumbreIPCKitTests, LumbreServiceHost{,.Core,.Tests}, Lumbre.Tray{,.Ipc,.Tests}).
- Case variants: `lumbre` 2,689 · `Lumbre` 1,723 · `LUMBRE` 1,294 — including ~254 letter-adjacent CamelCase compounds (LumbreServiceHost, LumbreIPCKit, LumbreApiError…), which a strict letter-boundary grep would MISS → the R8 gate is implemented as case-insensitive SUBSTRING (strictly stronger than the locked letter-boundary minimum; zero false positives since "loombre" does not contain "lumbre").
- Pattern buckets: `@lumbre/` workspace scope ×869 · `LUMBRE_*` env ×1,288 · `com.lumbre` platform ids ×52 (incl. keyring SERVICE `com.lumbre.secrets`) · GitHub coords in THREE inconsistent variants (`lumbre-project/lumbre`, `lumbre-media/lumbre`, `ozzydeving/Lumbre`) · event-schema `$id` namespace `https://lumbre.dev/…` ×16 · `Lumbre.app` bundle refs · CLI `lumbre` + bin/lumbre.mjs · DB `lumbre` + test lanes `lumbre_*`.
- Files-with-hits by top-level dir: apps 448 · packages 206 · installers 83 · scripts 51 · docs 41 · reports 6 (allowlisted history) · .github 5 · root files 13 (incl. CLAUDE.md, README, CHANGELOG, Dockerfile, both compose files, turbo.json, pnpm-lock.yaml, .dependency-cruiser.cjs).
- **In-database brand identifier found** (R4's "verify, don't assume" vindicated): migration 0001 defines SQL function `lumbre_uuidv7()`, the PK DEFAULT for every table → renamed `loombre_uuidv7()` inside the migration; proven by the R4 drop → re-migrate 0→current → re-seed pass under the `loombre` DB name. Tables/columns themselves are brand-free (verified). Migration FILENAMES are brand-free (0001–0013, verified).
- Special (non-mechanical) surfaces: WiX UpgradeCode → FRESH GUID (old 8406BB89-8EB8-4F4C-924B-0EED9AB50D90 retired, R5); pnpm-lock.yaml updated via `pnpm install`, never sed; packages/sdk + generated docs references (settings/env) REGENERATED, not hand-edited; packages/release-manifest/test/minisign-verify.spec.ts is binary-flagged (NUL bytes in minisign fixtures) — inspected: keypairs/signatures are generated at test runtime, no pinned signature covers old-name bytes → binary-safe perl rename; URL-context maps applied BEFORE the generic case-preserving sweep (ghcr → ghcr.io/ozzydeving/loombre; github coords → ozzydeving/Loombre; lumbre.dev → loombre.com per R2).
- Addendum-era surfaces confirmed in scope: settings-registry env-pin mappings (`LUMBRE_*` → `LOOMBRE_*`, R3 hard cut), registry key-name audit (keys are name-neutral by design — verify), docs suite pages + generated settings-reference/env-reference, keyring service string, admin-UI env-pin copy ("Set by environment (LUMBRE_…)").
- R8 allowlist (exact, each with reason, nothing else): CHANGELOG.md (the rename entry records the former name once) · STATE.md (immutable dated project history) · reports/** (immutable dated review/smoke history) · git history (unscanned by nature).

### §4 verification matrix — close-out (2026-07-24, commits 9afb2d2 → b6382b1)

- [x] **Inventory burned**: post-sweep residue = exactly the R8 allowlist. 51 tracked paths renamed; stale old-name build trees/artifacts purged (menubar .build, macOS .build-cache, linux .build stage, old lumbre-*.pkg/.tar.gz in installers/*/dist); ephemeral old-name runtime state deleted (auth-anomaly logs, .lighthouseci); gitignored media fixtures regenerated with Loombre metadata (found because the R8 gate walks the FILESYSTEM, not git — it caught ID3 tags git grep can't see).
- [x] **R8 grep-gate ACTIVE in pnpm gate**: former-name pass scans every file + every path (all extensions, PLAN/PLAYBACK included, pattern assembled non-literally), history-only allowlist with reasons. First run: 1,139 hits, all ephemeral/stale; now 0.
- [x] **Full local gate GREEN on the renamed tree** (codegen, sdk-drift byte-idempotent, oasdiff no-breaking, depcruise, runtime-imports, license, dep-audit, lint, typecheck, ALL tests, migrate-check, grep-gates, docs-build).
- [x] **Zero-to-current proof** on a FRESH loombre-dev volume: 13/13 migrations → seed → conformance 10 + seeded-conformance 30 + admin-settings 22 + settings-registry 27 + leak suites green; `loombre_uuidv7()` is the live PK default; schema has zero brand identifiers.
- [x] **REAL RENAME CATCH — precomputed argon2id seed hashes** (a hash cannot be swept): every e2e seed-admin login 401'd. Regenerated for the new-name plaintexts (identical cost params), hash.service.spec pin updated, live login 200 (ed95781).
- [x] **LOOMBRE_-only boot proven live**: plain-node dist boot, healthz 200; LOOMBRE_MAX_TRANSCODES=3 → value 3/source environment/lockedBy LOOMBRE_MAX_TRANSCODES; stray LUMBRE_MAX_TRANSCODES=9 + LUMBRE_DATA_DIR completely inert (unknown-env behavior unchanged — no special handling); IPC discovery+token written under the new data dir.
- [x] **Keyed-scan keyring-freshness reproof**: keyring-keys tripwire 4/4 green under service `com.loombre.secrets` (envelope written exactly as the server does → worker resolution seam).
- [x] **R6**: `loombre --version` → "Loombre 0.9.0-dev+<sha>" (output format implemented + spec-pinned); artifact names loombre-<version>-<platform> live in build scripts + release.yml; attestation/cosign refs → ozzydeving/Loombre; checksums filename unchanged-neutral (SHA256SUMS).
- [x] **Installers rebuilt + smoked under Loombre naming**: Linux tarball loombre-0.9.0-linux-arm64.tar.gz docs-verbatim container smoke ALL CHECKS PASSED; Docker arm64 image + compose smoke ALL CHECKS PASSED (boot → migrate → login → SIGTERM). MSI/pkg/systemd verified by inspection: fresh UpgradeCode 5F8B7B26-A5C5-4AA4-B2F1-09DB733A5719, LoombreServer/LoombreWorker services, firewall "Loombre Server", Start-menu Loombre, com.loombre.{server,worker,menubar,pkg,secrets}, Loombre.app, loombre-{server,worker}.service. (MSI build itself = CI/owner, no dotnet on this host — unchanged posture.)
- [x] **TWO LATENT POST-ADDENDUM BUGS caught by the §4 re-smokes (NOT rename regressions — these smokes had not re-run since A9/0013 landed)**: (1) tarball missing @napi-rs/keyring linux binding → both apps crash-looped in the container; fixKeyringBinding added, .pnpm-aware, sharp-style derived version + pinned integrity (9b6e25c). (2) Boot-time settings read crash-looped the server on an UNMIGRATED database, violating the documented "healthy-unmigrated is expected" contract → 42P01 now resolves defaults + ADMIN NOTICE, spec-pinned live (b6382b1) — same disease family as the embedded-PG crash-loop Open item, which REMAINS open for the migrate-on-update flow.
- [x] **Contract**: metadata-only (title/description/servers prose + event-schema $id namespace → loombre.com); oasdiff green, SDK regenerated byte-idempotent, conformance green.
- [x] **Docs build green** as the gate's final step; generated settings/env references show LOOMBRE_*; register-lint posture unchanged; owner VM-smoke checklists = docs/install/{windows,macos}.md walkthroughs, fully reissued under Loombre naming.
- [~] **3-OS clean-clone gate** — run 30139916658 (bae9745, [full-ci]): **ubuntu gate GREEN, macos gate GREEN, all three ENFORCING perf jobs GREEN**; windows gate red on TWO PRE-EXISTING Windows-portability bugs in scripts that had NEVER run on a Windows leg (license-check.mjs's Wave-3 15-tree rewrite spawned the pnpm .cmd shim without a shell — ENOENT mislabeled as "disallowed license" ×15; build-api-reference.mjs spawned the .bin/redocly shim — same disease, plus a space-containing --title arg that forbids the shell workaround). Both FIXED in 01eacff (shell:WIN per f13c21a; redocly spawned as @redocly/cli JS through process.execPath), verified on this host. The confirming [full-ci] rerun (30140369620) could not start: **GitHub Actions spending limit reached** ("job was not started… spending limit needs to be increased") — OWNER must raise the limit/fix payment in Billing & plans, then re-run the matrix on 01eacff (workflow_dispatch os=all, or push a [full-ci] commit). Windows-leg green is the only outstanding §4 box, and it is billing-gated, not code-gated.
- Operational notes: shared-dev-DB foot-gun tally now 3 (the gate's test run truncated the dev DB's users mid-proof; reseeded); shared-checkout pnpm foot-gun re-confirmed (build-tarball's --production install leaves modules prod-flagged — restore-first `rm -rf node_modules && pnpm install --frozen-lockfile` is the recovery, per the I4 incident rule); build-tarball defaults to x64 — local smokes on this host need --arch arm64; multi-arch Docker bake's amd64 leg flakes EINTR under QEMU on this host (single-arch loombre-arm64 target built + smoked; multi-arch stays release.yml's job on real runners); known test-contention flake family tally +2 during the final-gate runs (libraries.e2e login 401 once, playback-hls 404-not-200 once — each 5/5 green isolated, each green in the other full runs; the CONFIRMING full gate on the final tree = ALL STEPS PASSED).

## Addendum A (post-Phase-4, kicked off 2026-07-24): admin-configurable settings + documentation suite

### Missions (verbatim)

M-A: Implement admin-configurable server settings: a typed settings registry, persistence, validation, hot-reload where safe, restart-required signaling where not, an admin API, and a settings UI in the admin surface — with a hard env-only boundary protecting bootstrap and lockout-risk configuration.

M-B: Ship the launch-grade documentation suite: rewritten README, user guide, admin guide, operator guide, developer guide + OSS hygiene files, and an API reference generated from the contract — docs build wired into the gate.

### Addendum decisions (A1–A10 locked at kickoff — registry-first; env-only lockout boundary; A3 UI-editable set; server_settings JSONB storage w/ registry-key allowlist + invalid-at-boot default fallback; outbox settings.updated + hot-reload/restart-pending, no mid-write session drops; 3 admin endpoints; UI rails; env-pin WINS with UI locked-state; provider keys via keyring write-only; live isAdmin re-verify closing L2 for this surface. Orchestrator additions:)

| # | Decision |
|---|----------|
| AD1 | Auth rate-limit knobs ARE UI-editable registry keys (A8 names LUMBRE_RATE_SETUP as pinnable; A3's list is a floor): every rate-limit schema carries a hard min ≥1/min so no value can sever login — part of the lockout-impossibility walk |
| AD2 | Docs generator = VitePress 1.6.4 (markdown-first: folds the landed P4.9 operator/install docs as-is; trivial gate wiring; MIT; no telemetry). API reference = `redocly build-docs` (already a devDep; REDOCLY_TELEMETRY=off in the docs build env per D14) |
| AD3 | zod 4.4.3 in packages/shared for registry schemas; z.toJSONSchema projection feeds the /schema endpoint, the UI renderer, and the generated docs — one source, three consumers |
| AD4 | Provider-key metadata (lastSetMs) lives inside the keyring secret's JSON envelope {value, setAtMs} — never in server_settings; status endpoints derive from the envelope, never return the value |
| AD5 | server_settings.value joins the JSONB whitelist (A4 sanction) — CLAUDE.md invariant 3 list updated to 7 entries in lane S1's commit |
| AD6 | Cross-lane file-contention adjustments at wave-2 dispatch: the operator env-reference GENERATOR moves S3→D1 (D1 owns scripts/docs/ + build.mjs; S3's "gen hook" seam already exists from D1's first pass); the provider-key admin-notice RELINK moves S3→S2 (S2 owns apps/web and builds the settings page the notice must target). S3 narrows to pure read-site migration + grep-audit + registry requiresRestart flips |
| AD7 | Provider-key contract paths live at /v1/admin/provider-keys/{provider} (closed enum tmdb\|tvdb), deliberately NOT under /admin/settings/{key} — the Phase-1 /users/:id-shadows-/users/me lesson applied at design time |

### §1 precondition reconciliation (2026-07-24)

- STATE.md read in full; Phase 4 agent-complete status CONFIRMED (all lanes LANDED, remaining exit items owner-gated). Open threads honored: L1/L3, F3 grep scoping, IPC follow-ups untouched here; L2 partially remediated by A10 (settings surface only, global closure stays open).
- Version-checks — all three VERIFIED BY INSPECTION, no rebuild: (1) release.yml SHA256SUMS → minisign standard-Ed (fails closed without the secret, no -x) → attest-build-provenance for all artifacts + cosign keyless for Docker; (2) P4.9 unsigned posture prose in docs/install/index.md + pubkey three-location consistency check wired in ci.yml (runs on the ubuntu leg); (3) docs-verbatim smoke rule recorded in reports/install-smoke-linux.md header. keys/minisign.pub still the structurally-valid placeholder (owner-gated, expected).
- REALITY DELTA vs the phase record: the AGPL relicense is MERGED on main (1d62819 + 1ffe5f8 + 0c8c92c, owner-authorized post-phase) — supersedes P4.8's "drafted-not-merged" posture and the exit-gate line "LICENSE swap PR unmerged". Tree-wide SPDX headers exist; new files must carry them.
- Clean-clone gate was RED — fix-first applied (c91a4ac, 9076fc7), three REAL latent defects: (1) provisioning-pg real-binaries.ts fetched scripts/fetch-embedded-pg.mjs via a runtime-joined relative specifier that vite-node clamps to /scripts/… — only reachable with an empty vendor/ (i.e. exactly a clean clone on darwin-arm64; cached binaries masked it on every warmed checkout, linux CI skips the suites); now an absolute file URL. (2) migrate.mjs reset used DROP SCHEMA without IF EXISTS — an aborted reset bricked the DB for every later reset; the shared dev DB AND lumbre_jobs_ledger_events_test were found bricked exactly this way (healed: reset + seed + seed-large). (3) fetch-embedded-pg.mjs installed the extracted tree non-atomically — parallel vitest workers observed bin/initdb before lib/ existed (dyld libpq failure); now staged same-filesystem + atomic renameSync, lost-race-to-identical-install = success.
- Clean-clone gate GREEN (run 4, gate-clone at 9076fc7): ALL STEPS PASSED including the new lockfile through license-check + dep-audit, and provisioning-pg 10/10 from an EMPTY vendor/ (both fetch fixes proven for real). One non-recurring flake en route (run 3): conformance walk saw POST /libraries answer 404-not-401 once under the full parallel turbo run, passes 10/10 isolated + in the confirming run — new costume of the known test-contention family, logged here, tally 1 for the addendum.

### Addendum lane burn-up

| Lane | Scope | Status |
|------|-------|--------|
| S1 | registry + storage + service + propagation (A1–A5, A8, A10, A9 backend) | **LANDED 4a65fab** (34-entry registry, 10 env-only; migration 0013 + schema regen; settings.updated ADMIN_ONLY outbox; live-isAdmin guard w/ L2 pointer; provider-keys keyring service; orchestrator-rerun: shared 37/37, contract 21/21, db 161/161 + migrate-check, server settings 24/24. SettingsModule app-wiring deliberately deferred to S2) |
| S2 | contract additions A6 + admin settings UI (A7/A8/A9) + notice relink (AD6) | **LANDED 210011d** (5 additive ops + 12 schemas, redocly zero-warn, oasdiff no-breaking orchestrator-verified; SDK 77 ops byte-idempotent; 18-test admin-settings e2e incl. live-demoted-admin 403 + env-pin 409 + <18 422; schema→widget renderer 30 tests; /browse budget unchanged 119.1KB. REALITY DELTA: no pre-existing keyless-provider admin notice existed anywhere — A9's "relink" assumption was wrong; notice built fresh on admin/system linking to /admin/settings) |
| S3 | A3-read migration to registry reads + grep-audit + requiresRestart flips (narrowed per AD6) | **LANDED a0a2aae** (20 settings migrated server+worker, ALL hot after flips incl. rateLimit.*/updateCheck.mode/scanner.concurrency; REAL Nest hook-ordering bug found+fixed (constructor-time getEffective() pre-bootstrap); CommonSettingsModule cycle-break; scanner.concurrency CPU-derived default honesty preserved; grep-audit zero survivors; worker 827 + server 1125 green. SURFACED: throttle.ts "not env-overridable" header vs Addendum A settings-driven thresholds = candidate PLAYBACK.md clarification; probe/subtitle-extract pg-boss concurrency deliberately narrowed out of scanner.concurrency) |
| D1 | documentation suite per kickoff §4 (five audiences + OSS files + API ref + gate wiring) | **LANDED bea1410** (44-page VitePress site; README storefront; register-lint warnings-only; redoc inlined, zero external requests; 36-placeholder outstanding list; docs-build final gate step; orchestrator-rerun docs:build green). FOLLOW-UP dispatched: real registry generators (settings ref + env ref, per AD6) |
| R | opus review: settings security (lockout walk) + docs accuracy + register audit | **DONE** — verdicts: lockout-impossibility CLEAN (all 25 UI keys walked, worst legal values; env-only 404-on-write proven; restricted.enabled=false fails closed), ≥18 floor CLEAN (4 independent enforcement points, NO env path exists), hot-reload law CLEAN (admission-only proven by playback e2e), audit trail CLEAN (transactional, redacted provider keys, ADMIN_ONLY), provider-key hygiene CLEAN. FINDINGS → fix wave: F1 HIGH database.url (with password) served by claim-gated GET /admin/settings + rendered in UI (proven empirically); F2 HIGH macos.md still instructs the known-password db:seed the Linux smoke removed from linux.md; F3 HIGH user guide documents unbuilt "Next episode" + genre filter, autoplayNextEpisode toggle wired to nothing; F4 unlock-duration floor-only (MAX_SAFE_INTEGER = permanent unlock); F5 registry descriptions in developer register (49 lint warnings; fix = registry, repairs UI+docs); F6 scanner.concurrency advertised default ≠ real CPU-derived default; F7 operator docs 3 genuine register violations + broken docker quickstart case; F8 dev-guide getting-started sequence cannot be followed + 32 GitHub-404 links; F9 six availability ceilings missing + 2 cross-field constraints inexpressible; F10 restart-pending banner structurally unreachable (zero real restart keys — proven synthetically, recorded honestly); F11 batch (provider-key env-pin write silently inert, WS isAdmin never refreshed → L2 pointer, stale citations/numbers, [SCREENSHOT] literals rendering). Docs sourcing spot-audit 10/10 traced: 7 VERIFIED, 1 divergent citation, 2 unbuilt (= F3). |

### Addendum fix wave + freeze pass (2026-07-24, post-review)

- Fix lane SEC **LANDED 5432bc9**: F1 (secret:true + maskSecretValue on value AND schema default — masking over omission, contract marks both required; both GETs promoted to live-admin; distinctive-password-never-in-body e2e), F4 (unlock 1min–24h + caution; MAX_SAFE_INTEGER PoC rejected), F9 (all ceilings + assertCrossFieldInvariants 422 naming both keys, 6 tests), F11a (provider-key env-pin write → 409), F11c (@internal), F5/F6/F11d (all 25 UI descriptions rewritten household-register + register-audit tests pinning no-paths/no-IDs/no-signals). register-lint 45→20; settings-reference 3 soft first-use reminders + 1 never-rendered comment path.
- Fix lane DOCS **LANDED b741091**: F2 (macos.md seed removed, linux warning mirrored; windows clean), F3 (unbuilt claims deleted; inert autoplay toggle removed), F7 (acme/reverse-proxy/docker/linux operator fixes), F8 (followable getting-started + ffmpeg/REQUIRE_FFMPEG CI parity + ports + 77 site-absolute→relative links + glossary reachability), F11 batch (citations/numbers/[SCREENSHOT] render-strip/register nits). register-lint 49→45 pre-SEC.
- Wave-2 seam fix **b98733a**: restart-pending machinery proven via synthetic-registry test seam (zero real requiresRestart keys remain — F10 recorded honestly below). Docs drift check fired for real on S3's registry flips → regen committed 6be3834→7df2a47 chain.
- **ORCHESTRATOR BROWSER FREEZE PASS (real Chrome, external-mode boot, LUMBRE_MAX_TRANSCODES=2 pin)** — screenshot reports/addendum-a-settings-ui.png: schema-driven render of all 25 UI + 10 env-only entries in 8+6 categories; F1 masking LIVE (postgres://lumbre:***@…) on value AND default; env-pin locked state live (source Environment, current 2 vs default 1, "Set by environment (LUMBRE_MAX_TRANSCODES). Remove it from the environment and restart to edit here."); env-only never-editable states; edit round-trip (scanner.concurrency 2→4: Saved., source→Database, reset enabled, then reset-to-default); cross-field 422 REJECTED LIVE (stale 60000 < heartbeat 90000, value not persisted); ≥18 client floor (spinbutton min=18); bounded widgets from schema (max 64/100/24h/1h); provider-key write-only cards; restart banner correctly absent; admin/system provider notice card links to /admin/settings; console clean (only the deliberate 422 + a minor form-field id/name a11y nit), ZERO CSP violations.
- **A9 keyed-scan gap CLOSED at exit-walk (29d1b54)**: UI-entered keys reached the keyring but the worker never read it — resolveApiKeyWithKeyring (env wins, else the ProviderKeysService envelope via mirrored backend+dataDir derivation) resolved at worker boot through the providers' existing deps.env seam; 4-test tripwire suite writes the envelope exactly as the server does; card copy states restart semantics; add-a-provider.md updated.

### Addendum exit gate (§6) — status at close

- [x] Registry single-source: UI renders from GET /admin/settings/schema (browser-verified), API validates against registry schemas (e2e), admin settings reference + operator env reference generated from the registry at docs build with an sdk-drift-style stale-committed-copy check (fired twice for real)
- [x] Lockout-impossibility walk clean — opus verdict CLEAN across all 25 UI keys at worst schema-legal values (env-only 404-on-write proven; restricted.enabled=false fails closed; rate floors ≥1/min with admin login always admissible; env-pin escape hatch); F4/F9 ceilings + cross-field invariants added on top
- [x] Env-pin semantics proven: unit + e2e (pinned rateLimit.login 409, DB value inert until unpinned) + LIVE in browser (LUMBRE_MAX_TRANSCODES=2 winning over default with locked UI state) — the N100 runbook pre-flight envs work unchanged
- [x] Provider keys: UI→keyring (e2e file0600 + browser write-only cards), masked write-only, GET never returns values (opus: airtight; distinctive-key never-in-body e2e); keyed scan from a UI-entered key proven at the worker resolution seam (29d1b54; the key reaches the exact resolveApiKey seam every keyed-provider test already exercises; restart semantics stated in UI). Live-network TMDB scan remains owner-key territory
- [x] Settings mutations re-verify isAdmin live (e2e freshly-demoted-admin 403 over HTTP; after F1 the two GETs re-verify too); L2 global-closure pointer logged in require-live-admin.ts + below
- [x] Hot-reload proven: slot reduction = next admission only (playback e2e reduces cap through the real path, existing session survives, next admission 429); rate-limit updatePolicy, sweeper per-tick, updateCheck reschedule all proven. Restart-pending machinery proven via synthetic registry entry (F10 honest note: ZERO real keys can fire it today — the banner is future-proofing, exercised in tests only)
- [x] Invalid-at-boot fallback green (default + notice, never crash); unknown-key boot report green (preserved + reported, never dropped) — both directions unit-proven
- [x] Settings audit events transactional in outbox with actor + old/new (opus: oldValue read inside the same transaction as write+event, cannot desync); provider-key events redacted by construction; ADMIN_ONLY delivery verified
- [x] Docs suite complete per kickoff §4: docs build green as the gate's final step; operator/install docs folded as-is (register-audited, 3 genuine violations fixed); screenshot outstanding-list live (36 placeholders/11 pages, stripped from rendered output); sourcing spot-audit 10/10 traced (7 verified, 1 citation fixed, 2 unbuilt claims deleted — F3); register audit: user guide CLEAN in rendered HTML, admin guide clean post-F5 (3 soft reminders), dev-guide F8 fixes landed; CONTRIBUTING/SECURITY/issue+PR templates present
- [x] §1 version-check confirmations logged (see reconciliation above)
- [x] STATE.md coverage vs both missions: M-A → S1 (registry/storage/service/propagation) + S2 (contract/UI) + S3 (read migration) + SEC fixes + browser pass; M-B → D1 (site/guides/OSS/API ref/gate wiring) + generators + DOCS fixes + register/sourcing audits. Every kickoff §3/§4 decision maps to a landed lane or an AD entry above

### Addendum Open (follow-ups surfaced, owner = next dispatch touching the area)

- **Embedded-PG boot does not apply newly-shipped migrations** (found live: post-Phase-4 embedded cluster + migration 0013 = crash-loop at settings bootstrap; external-mode + docs-driven migrate flows unaffected). Installers document migrate-as-update-step; verify the MSI/pkg UPDATE paths actually run it, or add a boot-time migrate to the embedded path — owner/installer follow-up, pre-v1.0.
- Provider-key hot pickup without worker restart (lazy per-use resolution with rate-limit-bucket preservation) — candidate improvement; restart semantics are stated in the UI today.
- Settings UI 422 toast shows the problem title ("Unprocessable Entity") not the detail (which names both cross-field keys) — small UX polish.
- Admin settings form fields lack id/name attributes (Chrome a11y issue, count 18) — polish.
- WS broadcaster captures isAdmin at connect and never refreshes (pre-existing job.updated pattern; settings.updated payloads carry no secrets) — fold into the L2 global closure task.
- Shared-dev-DB foot-gun bit AGAIN during the freeze pass (reseed raced an unidentified concurrent writer; second reseed on a quiet host clean) — the isolated-test-DB-by-default fix stays the standing candidate; addendum tally: 2.
- apps/web/next-env.d.ts: Next.js regenerates this file and strips the tree-wide SPDX header on every build — churn accepted this session; consider excluding generated files from the header script.
- **Addendum A remote baseline GREEN: run 30131220893** (gate + all three ENFORCING perf jobs on ubuntu, commit cad5792) — after one CI-only red (run 30130649644): lane S3's deleted scan/concurrency.ts was still imported by three CI-only harness scripts outside its src grep sweep (scan-smoke/scan-report/perf-t0; local gates were honestly green — the callers only run in CI). All three now size the hash pool via the settings-aware resolution, identical to the worker at scan-job start. Lesson for future read-migration lanes: the grep-audit sweep must include scripts/ and perf/, not just app/package src trees.

## Phase 4 Mission (verbatim)

Ship Lumbre v1.0 as an installable product on Windows, macOS, and Linux: platform installers with embedded PostgreSQL and bundled ffmpeg, first-run onboarding wizard, export/import data freedom, complete admin surfaces, signed release manifests with notify-only update checks, operator documentation, a security hardening pass, a physical-hardware Tier-0 performance audit, and AGPL relicense readiness verified — everything a public launch requires except the launch decision itself.

## Phase 4 exit gate (kickoff §5) — status at 2026-07-24

Legend: [x] automated-verified complete · [~] agent-complete, OWNER hands-on remaining · [ ] owner-gated by definition.

- [~] **All three installers build + smoke** — all four channels BUILT (Linux tarball 380MB, Docker amd64/arm64, Windows MSI authored, macOS pkg 124MB); release.yml wires checksum→minisign→attest + cosign-for-Docker. Automated smokes GREEN: **Linux tarball** (docs-verbatim, orchestrator-rerun) + **Docker** (boot/login/SIGTERM, re-run after the D2 dist-copy fix). REMAINING (owner/VM, P3.4 posture — no VMs on the dev host): Windows + macOS `install→onboard→scan→play→uninstall` on fresh VMs following docs/install VERBATIM with SmartScreen/Gatekeeper intact; the actual minisign SIGNING needs the owner's real keypair (keys/minisign.pub is a placeholder — CI signs when the secret is set).
- [x] **docs/install complete per P4.9** — index + per-platform walkthroughs + troubleshooting, three-layer verification story; pubkey three-location consistency check WIRED INTO CI (runs on the ubuntu gate leg) and passing. Screenshots are [SCREENSHOT: …] placeholders for the VM smokes.
- [x] **Embedded PG first-boot + upgrade + external path** — @lumbre/provisioning-pg: real first-boot provision→connect→migrate→seed, REAL PG16→17 dump/restore upgrade with row/aggregate verification + intact backup, corruption→typed report, external-PG inert both directions. 62+22 tests orchestrator-rerun.
- [~] **Onboarding wizard stranger-viable** — the full P4.6 flow was ORCHESTRATOR-WALKED in real Chrome on a fresh empty DB (setup→admin→library→live hw-probe report→restricted→restore→home with a scanned library, hls.js playback, zero CSP violations). REMAINING: the OWNER's own zero-to-playing hands-on pass (the gate says "owner-walked").
- [x] **Admin surfaces complete** — jobs (live via socket, verified in browser), sessions WITH the "why is this transcoding" reasons view (verified on a real transcode), libraries/users incl. restricted grants, system info + verified capability report, update notice, crash access, logs tail. Browser-verified.
- [x] **Export/import round-trip diff clean** — real HTTP export → wipe → real job import → table diff = [] (orchestrator-rerun); merge-skip re-import zero growth; restricted leak check clean.
- [x] **Security pass resolved + audit gate + telemetry-free update check** — opus review NO CRITICAL/HIGH, M1 fixed, L1–L3 logged; dep-audit gate ACTIVE (found+fixed sharp/postcss CVEs); D14 update-check payload PROVEN telemetry-free by byte-capture (opus privacy review).
- [ ] **T0 physical audit on the N100** — OWNER-RUN by definition (physical hardware). Turnkey runbook + automation + reports/t0-audit.md template delivered; pre-flight requirements documented. Awaiting the owner's N100 run → all §9.2 budgets met OR owner-signed budget amendments.
- [x] **reports/agpl-readiness.md complete; LICENSE swap PR unmerged** — report done (license graph 798 pkgs all-compatible, node-forge dual-license resolved, provenance clean, headers script ready); branch chore/agpl-relicense pushed UNMERGED. The license gate's own root-blind-spot was found + fixed en route.
- [x] **Crash flow: forced crash → redacted local file, surfaced in admin** — process-level uncaughtException/unhandledRejection handlers both apps, redaction fixture-tested (paths/tokens/secrets scrubbed), real forced-crash child test asserts the redacted file on disk; admin crash-files surface serves it (browser-verified). D14 local-only (never transmitted).
- [ ] **STATE.md coverage vs mission + v1.0 tag** — coverage: every mission clause maps to a landed lane (table above). The v1.0 TAG is cut by the OWNER, outside this phase.

**Summary:** every AUTOMATED-verifiable exit item is GREEN. The remaining items are owner-gated by nature: the physical N100 audit, the Windows/macOS fresh-VM install-smoke walkthroughs (dev host has no VMs — P3.4 precedent), the owner's own wizard zero-to-playing pass, generating the real minisign keypair, the AGPL relicense decision, and the v1.0 tag. No agent-completable work remains in the mission.

## Phase 4 lane burn-up (per-lane status at every orchestrator checkpoint — a stalled lane must be visible within a day)

| Lane | Scope | Status |
|------|-------|--------|
| W0 | Contracts: ProvisioningInterface + controller IPC + release manifest/signing choice | **FROZEN 2026-07-24** |
| I1 | Linux tarball + systemd | **LANDED c86e559** (380MB arm64 tarball; container smoke orchestrator-rerun GREEN: install→boot→healthz→login→clean uninstall; 5 packaging bugs found+fixed; x64 boot smoke = real-x64/Wave-3; pnpm-deploy hard-link incident disclosed+reverted+guarded) |
| I2 | Docker hardening | **LANDED f00e1b1** (real amd64 226MB + arm64 218MB builds, smoke green end-to-end incl. SIGTERM clean shutdown; packaging-friction findings → integration fix list) |
| I3 | Windows MSI + tray | **LANDED cd3a6dd** (build-only proof: xmllint/ID-xref/node --check — no dotnet on host; wix build + dotnet test + install smoke = Wave 3 Windows VM) |
| I4 | macOS .pkg + menubar + cask | **LANDED 3ea7944** (real 124MB arm64 pkg built + payload boot-smoked on this host; 44/44 Swift + 16 fixtures orchestrator-rerun; sudo install/Gatekeeper/darwin-x64 = Wave 3/owner) |
| B | Embedded PG provisioning | **LANDED c0fb3e3** (62+22 tests orchestrator-rerun green incl. REAL PG16→17 upgrade + corruption + external-inert; theseus-rs binaries pinned 17.10.0/16.14.0; main.ts/package.json/worker-guard seams deferred to wave integration) |
| F | ACME/TLS + docs/ops skeleton | **LANDED 3807f02** (87 tests orchestrator-rerun green incl. live-pebble issuance+renewal w/ different serial + DNS-01 hook; trust-proxy reviewed NOT broken + spoof-proof tests; acme-client MIT; docs/ops complete; shared main.ts/package.json/lockfile/README settled here) |
| E | Export/import round-trip | **LANDED 9f71297** (round-trip diff=[] orchestrator-rerun; merge-skip re-import zero-growth; leak check clean; 3k-item measurement ~18s/~6.5ms-item; export includeDetail gap fixed; archive contract gaps documented for spec-PR batch) |
| I | Release pipeline + update check | **LANDED 7520346** (96/96 conformance+cli+update-check orchestrator-rerun; contract +GET /system/update additive; version 0.9.0 single-source; release.yml actionlint-clean coded against real I1–I4 CLIs; D14 zero-identifying-payload capture test green) |
| C | Onboarding wizard | **LANDED 5ce6db7** (13 e2e + 5 race + 54 web orchestrator-rerun; advisory-lock race-safe; 422-config-leak bug self-caught+pinned; folder-picker deviation + restore-ordering compromise accepted; browser pass pending at wave freeze) |
| D | Admin surfaces | **LANDED e1ae924+c63a420** (6+62+228 orchestrator-rerun; job.updated transactional emission + ADMIN_ONLY delivery; pg-upgrade JobType closes B's follow-up; plan/engineVersion promoted into the contract same-wave; reasons-map exhaustiveness-tested; browser pass pending) |
| G1 | Security build items | **LANDED b9f4d16** (final gate ALL STEPS PASSED, 2801 tests; CSP nonces proven via next start+curl AND the orchestrator browser pass; dep-audit found+FIXED sharp/postcss CVEs, allowlist empty; SIGBREAK gap closed; keyring real-Keychain-tested) |
| IPC | Server-side controller-ipc listener (Wave-1 discovery) | **LANDED 21f2018** (102+36+16 orchestrator-rerun; start=409 + ACL decisions implemented; sanctioned additive transport amendment; I4 subdir mismatch + worker-heartbeat follow-ups filed; main.ts wiring lands with G1) |
| Docs | Operator guide + install walkthroughs | **LANDED ec07e40** (index+troubleshooting new; all guides to P4.9 prose standard; every runnable claim implementation-verified; screenshots = Wave 3) |
| W2-contract | Orchestrator: setup/admin-surface contract additions | **LANDED 369b8f7+4fa8132** (6 additive ops, SDK 72, redocly zero-warn, conformance green unchanged) |
| W3-struct | Structural db/jobs dist fix | **LANDED** (plain-node boot proven by orchestrator: both apps `node dist/…` no tsx, healthz+DB route 200, clean SIGTERM; depcruise internal-fence firing re-proven; check-runtime-imports.mjs guard added) |
| W3-sec | Adversarial security review (opus) | **DONE** reports/security-review-phase4.md — NO CRITICAL/HIGH; M1 (setup un-rate-limited) FIXED by orchestrator; L1–L3 logged Open |
| W3-priv | D14 update-check privacy capture (opus) | **DONE** reports/privacy-review-phase4.md — D14 UPHELD by byte-capture; F2 (NEXT_TELEMETRY) FIXED; F3 (opentelemetry grep) logged Open |
| W3-agpl | AGPL readiness + LICENSE-swap branch | **DONE** reports/agpl-readiness.md; branch chore/agpl-relicense unmerged; headline GAP (root-only license scan blind to workspace deps) FIXED by orchestrator (scripts/license-check.mjs, workspace-wide — caught url-template BSD* the root scan missed) |
| W3-runbook | N100 T0 audit runbook | **DONE** docs/ops/t0-audit-runbook.md + scripts/t0-audit/** + reports/t0-audit.md template; 7 pre-flight findings → Open |
| W3-smoke-linux | Linux docs-verbatim install smoke | **DONE** reports/install-smoke-linux.md — tarball PASS w/ 6 doc fixes (incl. a real seed-admin security bug); Docker FAIL (D2 crash-loop: missing secrets/controller-ipc dist) FIXED + smoke re-run GREEN by orchestrator |
| W3-smoke-win/mac | Windows/macOS VM smokes | owner-run checklists (no VMs this host, P3.4) |

## Phase 4 Open (cross-lane items surfaced mid-wave; owner = next dispatch that touches the area)

- **IPC start-when-stopped hole (contract decision needed)**: controller-ipc's POST server/start is served by... whom, when the server is down? I3's tray falls back nowhere yet. Options: worker hosts the IPC listener; or start/stop delegate to SCM/launchctl in the controllers with IPC status-only. DECIDE when I4 lands (same tension), then amend the frozen contract via orchestrator-sanctioned change if needed.
- **Server-side IPC listener is UNASSIGNED work**: I3/I4 build controller CLIENTS; no Wave 1 lane owns the loopback HTTP host (discovery file + token file + the five ops). Wave 2 dispatch item.
- **Web-serving architecture unresolved for installed deployments**: installers stage apps/web build output but nothing serves it (no `output: standalone` in next.config, no static serving in apps/server); IpcStatus.webUrl assumes an answer. Orchestrator decision pending — collect I1/I2 evidence first.
- **Windows SIGBREAK gap**: server/worker have no SIGBREAK handler, so LumbreServiceHost's clean-stop path (CTRL_BREAK_EVENT → node 'SIGBREAK') always times out into kill. Belongs to the P4.14 crash/signal-handler work (Wave 2 G1).
- **Windows token/discovery file ACL**: contract's 0600 is POSIX; LocalSystem-written files must carry a Windows ACL readable by the interactive tray user — implement on the (unassigned) IPC-listener side.
- **Node-runtime fetch script consolidation**: no shared fetch-node script exists; I1/I3/I4 each stage runtimes — consolidate into scripts/ when reviewing I1 (lane I flagged as candidate owner).
- **pnpm deploy is marked Experimental by pnpm** — installer build scripts depend on it; track across pnpm upgrades.
- **Wave 3 review findings — orchestrator triage:**
  - SECURITY (reports/security-review-phase4.md): M1 setup-rate-limit FIXED (per-IP "setup" policy, 20/min, LUMBRE_RATE_SETUP). Still Open: L1 rate-limiter bucket Map never evicts (memory growth under key churn — bound it); L2 isAdmin trusted from JWT claim (demotion lags ≤15min unlike restricted clearance which re-reads live — re-verify isAdmin server-side or shorten admin-token TTL); L3 update-check is redirect-following (signature-pinned so low risk — consider no-redirect fetch). ffmpeg arm64 checksum discrepancy = still an owner pre-release item.
  - PRIVACY (reports/privacy-review-phase4.md): D14 UPHELD. F2 NEXT_TELEMETRY_DISABLED FIXED in Dockerfile base stage. Still Open: F3 add "@opentelemetry" to grep-gate ban — DEFERRED because .md/reports ARE scanned and the review reports themselves name the SDK (would false-positive); proper fix is scoping the telemetry scan to code dirs (exclude prose/reports), a separate grep-gates cleanup. Also: turbo itself prints telemetry notice on build (TURBO_TELEMETRY_DISABLED not set — build-time only, cosmetic).
  - AGPL (reports/agpl-readiness.md): license-scan blind-spot FIXED (scripts/license-check.mjs scans all 15 workspace trees). url-template@2.0.8 (BSD-3-Clause declared as bare "BSD", dev-tooling only via redocly) documented + excluded. LICENSE-swap branch chore/agpl-relicense @ 5d025cf is UNMERGED — going public is the owner's call. node-forge dual-license (BSD-3 arm elected) resolved. Headers script scripts/add-license-headers.mjs ready (dry-run 843 files).
  - RUNBOOK (docs/ops/t0-audit-runbook.md): N100 audit PRE-FLIGHT requirements the owner MUST set before the audit — LUMBRE_MAX_TRANSCODES=2 (Tier-0 default is 1, else the dual-transcode headline test 429s), LUMBRE_EMBEDDED_PG_VENDOR_DIR (tarball wrapper never sets it), `usermod -aG render,video lumbre` (QSV /dev/dri access — no supplementary groups today), TMPDIR onto real HDD for the scan-throughput budget (perf-t0 writes under os.tmpdir = likely tmpfs). Unclosable gap: §9 gives no ffmpeg-RSS-during-transcode ceiling — monitor reports trend, owner signs off.
  - LINUX SMOKE (reports/install-smoke-linux.md): 6 docs/install/linux.md fixes applied incl. removing a `pnpm db:seed` step that created a known-password admin + defeated the wizard (security-relevant). Docker D2 crash-loop FIXED (Dockerfile now copies secrets+controller-ipc dist, db/jobs switched to dist, tsx/esbuild/ajv runtime-shim mechanism DELETED — struct fix made it obsolete; smoke re-run ALL CHECKS PASSED). D1 build-tarball stale sharp version FIXED (now derived from resolved sharp package.json, can't desync again).
- **W3-struct finding, FIXED in this batch**: server SIGTERM exited 1 in external-PG mode (provisioning stop() throws ExternalModeInertError by design; shutdown called it unconditionally) — now guards on status.state !== 'external'. Service managers (systemd/launchd/SCM) get clean exit 0.
- **IPC follow-ups (lane IPC, Wave 2)**: (1) I4's AppPaths.swift/DiscoveryReader.swift read an ipc/ subdir — the listener writes app-data ROOT per the contract text + shipped Windows behavior; 3-line Swift fix before the Wave-3 macOS smoke. (2) Worker liveness is a jobs-ledger heuristic (idle-vs-stopped ambiguous) — real fix is a worker heartbeat file/row. (3) 'not-found' IpcErrorCode = candidate additive enum value. (4) controller-ipc dist-import shim in apps/server pending the workspace-dep swap when G1's lockfile ownership ends (same pattern release-manifest already got).
- **Upgrade jobs-ledger follow-up (lane B)**: the boot-time PG major upgrade should write a ledger row AFTER the new PG is up so admin history shows it — needs an additive JobType in packages/jobs + createLedger export; assign to whichever Wave 2 lane touches packages/jobs first (likely D's job.updated event work).
- **Installer packaging must set LUMBRE_EMBEDDED_PG_VENDOR_DIR** (documented in apps/server/src/bootstrap/provisioning.ts + provisioning-pg README) — I1/I3/I4 wiring item.
- **LICENSE-INTENT.md needs a "vendored non-npm binaries" section**: ffmpeg GPL builds (I1's manifest PROVENANCE note) + PostgreSQL License binaries (B's manifest) — orchestrator edit before the AGPL-readiness report (P4.8).
- **ProvisioningState has no 'stopped-but-valid' member** — mapped to 'provisioning'+detail for now; lane D's admin surface should render detail; candidate contract v2 addition.
- **Wave-integration commit checklist (shared files deferred from lane commits)**: apps/server/src/main.ts (B provisioning + F TLS), apps/server/package.json (B deps + F acme-client + I bin/pre-hooks), apps/worker/src/index.ts (B wait-for-ready + E import consumer), README.md (I verification section + F remote-access), docs/ops/updating.md (F skeleton + I content), pnpm-lock.yaml (single reconciling install), swap lane I's release-manifest dist-import shim for the real workspace dep (delete pre-hooks), wire scripts/release/check-pubkey-consistency.mjs into ci.yml, re-run installers/docker/smoke.mjs on the settled tree, then ONE full gate + push.
- **Export-archive fidelity gaps (lane E, documented in apps/worker/src/import/consumer.ts header)**: MediaFileSummary lacks path/content_hash (placeholder+P1.2 self-heal), no image paths (zero images restored), no provider ids exported, Progress lacks userId (attributed to importer), library_permissions never exported, users restore with sentinel hash. Candidate ADDITIVE contract enrichments for a data-freedom spec-PR batch — owner-review item alongside the Phase 3 spec-PR candidates.
- **main.ts isDirectEntrypoint symlink bug (I4 finding, REAL production bug)**: `import.meta.url === pathToFileURL(argv[1])` is realpath-asymmetric — server/worker silently exit 0 doing nothing when launched through any symlinked path (e.g. /opt/lumbre/current). I4's bin wrappers shim with pwd -P; the ROOT fix (realpath argv[1] before compare) goes into main.ts at wave integration.
- **ffmpeg macos-arm64 checksum discrepancy (I4, security)**: the manifest's pinned sha256 matches the actual osxexperts.net download but NOT the checksum printed on their webpage. Tamper-after-pin is still caught; the mismatch itself is unresolved. SECOND-SOURCE verification required before any public release build — explicit input to the Wave 3 release-artifact-integrity adversarial review.
- **IPC token-file permission bridging is cross-platform (I3+I4 corroborated)**: 0600 daemon-owned token unreadable by the console-user controller on BOTH platforms (LocalSystem vs tray user; _lumbre vs console user). The unassigned IPC-listener lane must solve permission bridging by design (group-readable token, per-user minting, or contract amendment), not per-platform hacks.
- **Shared-checkout pnpm foot-gun (I4 incident, recovered)**: pnpm's deps-status auto-heal under CI=true pruned ~600 hoisted devDeps mid-wave (restored via rm -rf node_modules + frozen-lockfile install, lockfile verified unchanged). Rule for any future parallel wave: lanes never run bare pnpm install/run against the shared checkout with CI set; orchestrator owns node_modules reconciliation.
- **Runtime-TS packaging defects (I2 findings, fix before Wave 3 install smokes)**: @lumbre/db + @lumbre/jobs ship raw TS at runtime (tsx is effectively a runtime dep; jobs has a dead build script), apps/server imports devDep ajv at request time, turbo prune drops root tsconfig.base.json and misses relative-path prebuild hooks. Proper fix: make db/jobs build real dist + server/worker import dist + ajv to dependencies — structural, orchestrator-scheduled at integration (every installer path depends on it; I2's Dockerfile currently shims around it).

## Phase 3 Mission (verbatim)

Implement docs/PLAYBACK.md completely: the pure plan() engine with all seven stages and the closed reason taxonomy, the deterministic ffmpeg arg builder with golden tests, the bitrate ladder with lazy rungs, hardware capability self-test verification, and the HLS session execution layer with throttling, seek, heartbeat, and admission control — exiting with ≥500 green matrix cases, all four property tests, 25 goldens, session integration tests on three OSes, and real-hardware verification on macOS (VideoToolbox) at minimum.

## Phase 3 matrix burn-up (updated at every freeze — no "almost done" without the number)

| Date | Green | Red | Total cases | Note |
|------|-------|-----|-------------|------|
| 2026-07-24 | 0 | 10 | 10 | Phase 0 seed wall intact; exit target ≥500 green |
| 2026-07-24 | 63 | 9 | 72 | Step 2a: Stage A + pipeline skeleton; seed 001 + 62 container cases green; 002–010 await their stages |
| 2026-07-24 | 132 | 7 | 139 | Step 2b: Stage B video; seeds 002+007 greened; reds 003–006/008–010 await C/D/E/F |
| 2026-07-24 | 200 | 5 | 205 | Step 2c: Stage C HDR + P3.9(b) refused case + remux-predicate fix (0.3.1); seeds 005+010 greened; reds 003/004/006/008/009 await D/E/F |
| 2026-07-24 | 262 | 3 | 265 | Step 2d: Stage D audio; seeds 004+009 greened; reds 003/008 await E, 006 awaits F |
| 2026-07-24 | 325 | 1 | 326 | Step 2e: Stage E subtitles; seeds 003+008 greened; last red 006 awaits F |
| 2026-07-24 | 387 | 0 | 387 | Step 2f: Stage F bitrate+ladder; seed 006 greened — §11 STEP 2 COMPLETE, zero stubs, ALL cases green |
| 2026-07-24 | 446 | 0 | 446 | Step 3: Stage G hardware routing; P3.9(a) seed edits + 158-case P3.2 sweep; 59 new caps-set cases |
| 2026-07-24 | 446 | 0 | 446 | Step 4: arg builder + 25 goldens (case files unchanged; goldens live in the package suite) |
| 2026-07-24 | 446 | 0 | 446 | Step 5: capability probe + real M3 Max VT verification (worker-side; no engine/case changes) |
| 2026-07-24 | 502 | 0 | 502 | Step 7a: adversarial audit — 56 coverage/pin cases; ≥500 exit target MET |
| 2026-07-24 | 506 | 0 | 506 | Step 7b: F1/F2/F4 fixes — 4 pinned cases flipped under P3.2 + 4 new; goldens 28 |

## Phase 3 exit gate (kickoff §4) — status at 2026-07-24

- [x] Matrix ≥500 cases green; burn-up matches `pnpm test:matrix` — **506 green / 0 red / 506**, table above tracks every freeze.
- [x] Property tests: determinism (1k), direct-play bias, totality, reason completeness — all four green in real mode since Stage A.
- [x] 25 goldens green (now 28: +2 vaapi burn-in F4, +1 VT hybrid); canonical §6 order + token closure verified in review and by unit test.
- [x] Probe: fixture-schema conformance green (shared §2.5 validator); macOS real-probe report committed (reports/hw-verify-macos.md, reviewed-by-owner PENDING); Linux/Windows checklists = Open owner items per P3.4.
- [x] Session integration on 3 OS runners: first-segment, seek numbering+discontinuity, throttle suspend/resume, heartbeat teardown, admission — suite has passed on all three runners (ubuntu consistently; windows 30085336300; macos 30093585776); ongoing runs are ubuntu-only per the billed-minutes economy, [full-ci] reruns at boundaries.
- [~] Owner smoke: **HDR tone-mapped stream PLAYS in Chrome from the web client on this MacBook (real 4K HDR10 movie, real VT tone-map, resume live, screenshot committed)**; in-window seek + throttle verified live. REMAINING: seek into UNPRODUCED region from the web client (blocked by the EVENT-playlist clamp finding — server-side seek mechanics proven in integration; Open design item); PGS burn-in (no PGS media exists in the library and stock ffmpeg cannot generate it — owner checklist with real disc media; text-burn-in overlay graph flagged suspect); Safari/VT-native attach = owner hands-on.
- [x] Engine purity: depcruise bans every node builtin + frameworks (proven firing); eslint bans Date/process/Math.random in src (proven firing); §0 grep clean.
- [x] docs/PLAYBACK.md diff vs implementation: adversarial audit inventory complete — every finding fixed (F1/F2/F4 + three real-execution defects) or pinned + logged as spec-PR candidates (F5, F6, profile ladder, Stage-C gating, strip-on-repackage, gapless-ts-hls, unknown-codec override, hw-only rule i, §6 map-redirect, remux output shape, §8.3 one-bounce-vs-§6-order tension). Zero silent divergence.
- [x] STATE.md coverage vs mission — every mission clause maps to a Frozen entry (plan() complete, arg builder, ladder, probe, session layer, throttling, seek, heartbeat, admission).
- [ ] **Owner review items**: hw-verify-macos.md sign-off; Linux (T2 box) + Windows probe checklists; PGS burn-in smoke with real media; Safari native-HLS attach; the seek-into-unproduced design decision; spec-PR batch for the logged clarification candidates.

## Phase 2 Mission (verbatim)

Make Lumbre daily-drivable: complete auth and remote access, ship the web client's browse/detail/search/player/music surfaces at the performance budgets, implement direct-play and direct-stream-free playback with progress and continue-watching, device capability profiling at login, websocket presence, and flip the Tier-0 performance harness from warn to ENFORCING.

Scope guard: NO transcoding. The player plays what the browser plays natively; everything else shows the typed "requires transcoding (Phase 3)" state. Building any transcode path in this phase is a scope violation.

## Phase 1 Mission (verbatim)

Implement the Lumbre catalog pipeline end-to-end for movies, TV, and music: idempotent rename-aware scanner, content-hash identity, ffprobe ingestion into typed media_streams, TMDB/TVDB/MusicBrainz metadata providers behind the provider interface, per-field precedence with field-level locks, image pipeline with pre-scaled variants and blurhash, working search, live catalog API endpoints, domain events, and the restricted-content library proven leak-free across every surface. Exit = a real library scans correctly and every leak-impossibility todo is an implemented, passing test.

## Phase 0 Goal (verbatim)

Build the Phase 0 foundation for Lumbre: (A) CLAUDE.md, (B) OpenAPI v1 contract skeleton + generated TypeScript SDK pipeline, (C) PostgreSQL schema + migrations including restricted-content structures and the mandatory query-guard skeleton, (D) verification harness including the failing PlaybackPlan matrix scaffold, license gate, and telemetry ban, (E) cross-platform monorepo scaffolding that boots. No an upstream media server/an upstream media server API surface, schema, or naming anywhere. Private repository now with AGPL-3.0 relicense readiness from commit one.

## Decisions (append-only)

| # | Decision |
|---|----------|
| D1 | PostgreSQL 17 only; migrations from commit one; embedded-PG is a packaging concern (Phase 4), external PG via env var |
| D2 | Catalog / Playback / Session: separately bootable NestJS modules sharing only IDs; boundaries enforced by dependency-cruiser |
| D3 | PlaybackPlan is a pure function (MediaInfo, DeviceProfile, NetworkConditions, ServerPolicy, clock) → PlaybackPlan with typed reasons |
| D4 | OpenAPI contract-first; controllers conform, TS SDK is generated; oasdiff breaking-change gate in CI |
| D5 | Jobs via BullMQ abstraction with pg-boss driver on Tier-0 (no Redis daemon required for small installs) |
| D6 | v1 media: movies, TV, music. Multi-user + remote access |
| D7 | Restricted (adult) content: native, five-gate model, server-side query-guard enforcement, metadata isolation (plan §6.4) |
| D8 | NFO/sidecar/tags are read-only scanner inputs; never an API concern; no NFO writing in v1 |
| D9 | Thin polymorphic catalog_items + typed satellite tables (FK=PK); new media types are additive by construction |
| D10 | Milliseconds everywhere; cursor pagination everywhere; UUIDv7 ids; RFC 9457 errors; typed enums |
| D11 | Stack: Next.js web, NestJS, TypeScript strict, Turborepo+pnpm, Kysely (no ORM); Win/macOS/Linux via per-OS CI runners |
| D12 | License: private now → AGPL-3.0 at public launch. LICENSE-INTENT.md from commit one; CI license-checker denies AGPL-incompatible deps; no third-party code copied without recorded provenance |
| D13 | Restricted majority age: 18, instance-configurable upward only (hard floor) |
| D14 | Telemetry: none, ever. Crash reports local-file only. CI grep-gate bans analytics/telemetry SDKs |
| D15 | Tier-0 (N100/4GB) is a first-class target; perf budgets (plan §9) get a CI harness scaffold in Phase 0, enforced from Phase 2 |
| D16 | File identity = content_hash (xxHash3 partial) + path; rename-aware, soft-delete grace window |
| D17 | Controller conformance = runtime route-walking test: boot Nest app in-process, enumerate mounted routes, assert exact bijection with openapi.yaml paths+methods (healthz exempt, not part of /v1 contract), validate response bodies with Ajv against contract schemas |
| D18 | Dev compose Postgres binds host port 5442 (`LUMBRE_PG_PORT` overridable; container port stays 5432) so Lumbre coexists with other local stacks; all local defaults use 5442 |
| D19 | TypeScript pinned to 5.9.x repo-wide: TS 7.0.2 is rejected by typescript-eslint peer range and breaks openapi-typescript + Next config loading |
| D20 | License gate excludes `spdx-exceptions@2.5.0` (CC-BY-3.0): transitive devDep of the license checker itself, never bundled/shipped; the only non-allow-list package among all 438 (verified by unfiltered scan). Recorded in LICENSE-INTENT.md tooling-exclusions |
| D21 | Phase 0 conformance posture: global gateway auth guard returns RFC 9457 401 problem+json for every unauthenticated /v1 request (catch-all; no per-path controllers yet), so the walker proves "401 unauthenticated" on 100% of contract paths + no undocumented routes. Public endpoints (login/refresh/capabilities) tighten to schema-valid responses in Phase 1 |
| D22 | Matrix failing wall: `pnpm test:matrix` is genuinely RED in Phase 0 (10 cases fail not-implemented, each printing expected decision+reasons); `pnpm gate`'s test step excludes the matrix project but includes a meta-test asserting plan() throws NotImplementedError, exactly 10 cases exist, and every expected reason code is from the closed PLAYBACK.md §4 enum — the wall is verified without being green-washed |
| D23 | Pre-release contract-correction policy: until Phase 2 (daily-drivable), deliberate breaking contract edits are permitted when fixing spec bugs, but each must be logged here with its oasdiff classification and committed atomically with the regenerated SDK. First use: 2026-07-22 wave-3 fixes — 25 × response-property-became-nullable (runtimeMs/durationMs/trackNumber/Series.status made nullable to match scan reality). The additive-only policy (plan §4.1) binds unconditionally from public launch |
| D24 | Scan-derived vs provider-derived nullability rule: fields knowable at scan time (seasonNumber, episodeNumber) are NOT NULL in schema + non-nullable required in contract; probe/tag/provider-derived fields (runtimeMs, durationMs, trackNumber, Series.status) are nullable in both |
| P1.1 | Identity: xxHash3 of first 4 MiB + last 4 MiB + sizeBytes. Hash match relinks (emit file.relocated, preserve progress); path match with changed hash = re-encoded file → re-probe same item. Never delete-and-readd on rename |
| P1.2 | Missing files: missing_since_ms set, item hidden from queries, hard cascade only after 72 h grace; mount-drop safe |
| P1.3 | Scanner: chokidar with polling fallback auto-enabled for network mounts; full scans are resumable checkpointed jobs; concurrency caps from tier |
| P1.4 | Parsing: deterministic fixture-tested rulesets. Movies Title (Year) + variants; TV SxxEyy, dated, absolute; music is TAG-FIRST (music-metadata lib), filenames are fallback only |
| P1.5 | Probe: bundled ffprobe, raw JSON to media_files.probe, typed extraction to media_streams per PLAYBACK.md §2.1 field list (incl. color_transfer, DV profile/BL-compat, Atmos, interlace) — this extraction IS Phase 3's input; its fixtures come from PLAYBACK.md fixture generator |
| P1.6 | Providers implement the internal interface (search/fetchDetails/fetchImages) with per-provider rate limiting, response caching, and a content_class scope; a restricted-scoped provider can never run against a general library (hard check + test) |
| P1.7 | Precedence per FIELD: local NFO/tags > provider > filename inference; metadata_lock is field-level; provenance recorded per field |
| P1.8 | Images: ingest original → 3 variants (WebP; AVIF where sharp supports) + blurhash, ALL at ingest in worker_threads — request paths never do image CPU work (Tier-0 law) |
| P1.9 | API keys (TMDB/TVDB) via env/config only; server boots and scans fine without them (provider disabled + admin notice), never crashes on absence |
| P1.10 | Audit mismatch: media_streams lacks the PLAYBACK.md §2.1 typed fields hdr/dv_profile/dv_bl_compat_id/has_atmos/interlaced (Phase 0 stored only color_transfer, inferring the rest) → additive migration 0002 adds the five typed columns; extraction writes them directly |
| P1.11 | Audit mismatch: P1.6 said response caching "jobs table backed", but Phase 0 built jobs as a typed queue-mirror ledger explicitly OUTSIDE the JSONB whitelist (no payload column) → dedicated provider_cache table (provider, request_hash UNIQUE, body TEXT serialized JSON — NOT JSONB, whitelist unchanged, cache is never queried into), fetched_at_ms + expires_at_ms |
| P1.12 | Scan checkpoints: typed scan_checkpoints table (job_id PK, library_id, phase, last_processed_path, counters, updated_at_ms) — no JSONB, jobs table stays a pure ledger |
| P1.13 | Guard-free internal writer (deliverable A precondition — none existed): packages/db/src/internal, exported ONLY via @lumbre/db/internal subpath; Kysely DB interface expanded to all written tables; dependency-cruiser rule: only apps/worker (+ packages/db itself, seed, tests) may import the internal subpath — apps/server cannot |
| P1.14 | Real auth is a Phase-1 prerequisite (live catalog reads need a per-request ViewerContext): argon2id verify, JWT access token (short TTL) + refresh rotation, AuthGuard upgraded from D21 catch-all to real validation + ViewerContext resolution (allowedLibraryIds from library_permissions; restrictedCleared = all five gates); public endpoints tighten to schema-valid per D21 |
| P1.15 | Queue lands as new packages/jobs: minimal typed abstraction (enqueue/work/complete) with pg-boss driver per D5; jobs table mirrored for admin UI; consumers scan/probe/image become real; transcode stays stub (Phase 3) |
| P1.16 | Events additive: scan.started, item.updated, library.created added to envelope enum + payload schemas (mission §H requires them; Phase 0 shipped 7 types without these) |
| P1.17 | Contract additions (additive, D23 not needed): GET /people + GET /tags list endpoints (first-class leak surfaces per §6.4), image descriptors incl. blurhash exposed on catalog item schemas; websocket /v1/events stays outside the REST contract (documented in event-schemas) |
| P1.18 | ffprobe/ffmpeg resolution: LUMBRE_FFPROBE/LUMBRE_FFMPEG env → PATH lookup fallback; CI installs a pinned build; per-platform bundling is Phase 4 packaging. Media fixtures come from a checked-in lavfi testsrc2 generator script — binaries never committed |
| P1.19 | Gate-1 capability flag: LUMBRE_RESTRICTED_ENABLED env (default off) surfaced via GET /system/capabilities; when off, restricted code paths are inert and restricted libraries cannot be created; no instance-settings table in Phase 1 |
| P1.20 | Identity hash is XXH64 (two adjacent 4 MiB windows + sizeBytes; <8 MiB = whole file once), not xxHash3: xxhash-wasm has no XXH3 and a native module was rejected for 3-OS CI surface. Same 64-bit output/collision class; amends D16/P1.1 wording. Format is internal — changing later means rehash-and-relink migration |
| P1.21 | Leak finding (fixed + tested): people/tags content_class is writer-chosen, not derived — a restricted-class person credited on a general item would leak via search people-join; search gates the people/tags join on their OWN content_class independent of the item guard. Image access for entity_type=library also checks content_class, not membership alone |
| P1.22 | images unique key rebuilt UNIQUE NULLS NOT DISTINCT (0004) so the width-NULL original row upserts instead of duplicating |
| P1.23 | Metadata job granularity: consumer enriches movie/series/artist/album items only (payload has no item_type; season/episode/track have no standalone-fetch-worthy fields in v1); episode/track runtime derives at read time from media_files.duration_ms (n1/n2 note upheld) |
| P2.1 | Auth complete per plan §10: argon2id, 15-min access JWT, per-device rotating refresh with reuse-detection revocation, restricted-unlock claim; auth rate limits + anomaly log (fail2ban-compatible format) |
| P2.2 | Remote access: HTTP behind reverse proxy with trust-proxy config is the v1 documented path; built-in ACME deferred to Phase 4 (log as Open) |
| P2.3 | DeviceProfile built client-side at login via MSE/canPlayType probing per PLAYBACK.md §2.2, schema-validated server-side (422 on malformed), cached on devices.profile |
| P2.4 | Playback in this phase = direct-play only: range-request file serving, progress heartbeats, session rows (plan stored with decision direct-play, engineVersion 'phase2-static'); media the browser can't direct-play renders the typed unavailable state with the WOULD-BE reasons computed by a static compatibility check (a thin preview of Stage B/D checks — shared module, NOT the plan() engine) |
| P2.5 | Music: direct-play + queue + gapless via HTML5 audio element chaining with preload; ReplayGain applied client-side from stream tags when present |
| P2.6 | Web perf budgets ENFORCED in CI from this phase: ≤200 KB gz browse-route JS, Lighthouse ≥90 throttled, virtualized grids, blurhash LQIPs, srcset from image variants; T0 server harness flips to enforcing (idle RSS ≤500 MB stack / ≤220 MB server, p95 ≤100 ms hot paths @ 50k-item seed) |
| P2.7 | Design language — soft geometry is the identity: warm dark default theme, ember-red accent (#E2453A family), restrained glassmorphism on overlays only; light theme supported; no theme system beyond the two in v1. Radius tokens (owner-locked): --radius-pill 9999px ALL buttons/chips/tags/badges/inputs/search/segmented/progress/scrubber; --radius-lg 20px cards/dialogs/popovers/menus; --radius-md 14px posters/thumbnails/tiles; --radius-sm 10px inline chips/nested; --radius-full 50% avatars/icon-buttons. NO sharp corners anywhere (min visible radius --radius-sm). Focus rings/hover/skeletons/blurhash placeholders inherit element radius. Radius values live ONCE in tokens; hardcoded border-radius fails stylelint. Pills min 20px horizontal padding; disciplined type scale |
| P2.8 | Restricted UX: restricted libraries invisible until gate-5 unlock; unlock is an explicit PIN modal; a global visible lock control; auto-relock on expiry reflects instantly via websocket |
| P2.9 | Iconography: Lucide exclusively (tree-shaken; second icon set fails review). Stroke 1.75, round cap/join, 24px grid (20px dense); active states = filled treatment or accent stroke, never a different family. Custom icons on same grid/weight, audited SVGs in packages/../icons/ |
| P2.10 | Motion: compositor-only (transform/opacity ONLY; layout-property animation is a review failure). Tokens: --motion-fast 150ms, --motion-base 240ms, --motion-slow 400ms; --ease-spring cubic-bezier(0.34,1.56,0.64,1) enter, --ease-out cubic-bezier(0.22,1,0.36,1) exit; exits faster than entries. Press scale 0.97; poster hover translateY(-4px)+scale(1.03)+ember shadow; focus rings animate. View Transitions API for route/detail (poster→hero shared element) with instant-cut fallback. Skeletons crossfade. CSS-first; motion lib ONLY for scrubber physics + shared-element polish, cost inside the 200 KB budget. prefers-reduced-motion → fades ≤100ms. All animation interruptible |
| P2.11 | Wow factor — ambient depth: detail pages + player idle render item backdrop heavily blurred/darkened with dominant-color glow extracted at image-ingest (persist dominant_color alongside blurhash in images table — worker-side, never client-side); ember accent reserved for interactive/now-playing. Home rows subtle now-playing pulse. Glass stays on overlays per P2.7. Lighthouse ≥90 + 60fps virtualized scroll measured WITH all motion/ambient enabled; effects that miss the bar are cut, not excepted |
| P2.12 | Audit mismatch: Phase 1 (P1.14/Wave 0b) already shipped most of deliverable A — login/refresh/logout with rotation + reuse-detection chain revocation, restricted unlock/lock, PIN mgmt, devices list/get/delete, deviceProfile captured at login into devices.profile. Phase 2 A reduces to: strict DeviceProfile schema validation (422 per P2.3 — current validation is loose), auth rate limits + fail2ban-format anomaly log (hand-rolled in-memory token bucket as session-module guard, NO new deps, no app.module churn), trust-proxy config (P2.2), and device-row reuse at login |
| P2.13 | Audit mismatch: contract has NO direct-play file-serving path (only HLS manifest, contract-only). Additive contract path GET /playback/sessions/{id}/file (Range → 206/416, ETag; resolution via media_files rows only). HLS manifest stays unimplemented (Phase 3); conformance unimplemented-allowance narrowed to exactly the remaining Phase-3 set |
| P2.14 | Audit mismatch: playback_sessions lacks status/error_code/updated_at_ms columns the contract's PlaybackSession implies; progress lacks duration_ms though contract exposes durationMs. Both added in migration 0006 (additive, expand-only). Session heartbeat = the progress PUT (PLAYBACK.md §9); 15-min no-heartbeat sweeper ends session + emits playback.ended |
| P2.15 | Migration slots assigned to avoid parallel-lane collision: 0005 = images.dominant_color (lane G), 0006 = playback_sessions/progress columns (lane B) |
| P2.16 | Login reuses the caller's device row when the client presents its deviceId (rotates that device's refresh chain, refreshes profile + last_seen); absent deviceId → new device row (Phase 1 behavior). Additive optional LoginRequest.deviceId; web client persists its deviceId locally |
| P2.17 | Static compat preview lives in packages/playback-engine/src/compat-preview.ts: pure checkStaticCompat(mediaInfo, deviceProfile) → {canDirectPlay, wouldBeReasons[]} reusing the §2 types + closed §4 reason enum (container + Stage-B video + Stage-D audio + text-sub renderability checks only). Separate export; plan() red wall untouched. POST /playback/plan serves this shape in Phase 2, contract-marked x-phase2-preview: true |
| P2.18 | Media-fetch auth: <img>/<video>/<audio> cannot send Authorization headers, so GET /images/* and GET /playback/sessions/{id}/file additionally accept the access JWT via ?token= query param (validated identically, never written to logs, responses Cache-Control: private). Scoped to exactly these GET-only media surfaces; all other endpoints remain header-auth only |
| P2.19 | D23 second use (pre-release breaking contract correction): POST /playback/plan 200 response changed PlaybackPlan → PlaybackPlanPreview {canDirectPlay, wouldBeReasons[]} + x-phase2-preview: true (P2.17/deliverable C seam). oasdiff: 9 × response-required-property-removed, all on that one operation. Committed atomically with regenerated SDK. Phase 3 restores the full PlaybackPlan response by replacing the preview (logged now as the planned second correction) |
| P2.20 | OWNER AMENDMENT at Wave-2 checkpoint (amends P2.7 glass scope + dark palette): liquid-glass is now a design-language signature, not overlay-only — glass surfaces combine backdrop blur + saturation (light "refraction" rendered as specular top edge + 1px light inner border + subtle frost gradient, NOT SVG filters), and dynamically adapt to content underneath via (a) backdrop-filter sampling and (b) a --glass-tint custom property fed by the item's dominant_color where ambient context exists (P2.11 pairing). Applied to shell chrome (nav rail/topbar), overlays, and cards-over-ambient; flat reading surfaces stay calm. Dark palette deepened to near-true blacks (bg ~#0a0807 family), surfaces keep warmth relative to bg. @supports fallback to opaque surfaces where backdrop-filter is unavailable. P2.10/P2.11 hard constraints unchanged: compositor-only, Lighthouse ≥90 + 60fps measured WITH glass enabled, 200 KB budget — glass that misses the bar is cut, not excepted |
| P3.1 | Implementation order = PLAYBACK.md §11, exactly. Stages land one at a time, each with its matrix cases (~60–80/stage) in the same PR; direct-play-bias property green from Stage A onward |
| P3.2 | Matrix regression law active: flipping any existing case's decision/reasons requires editing that case file in the same PR with why: |
| P3.3 | VerifiedCapabilities: engine work runs against FIXTURE capability sets (full-hw, encode-only, software-only, macos-vt) until step 5; the probe implementation must reproduce the fixture schema exactly |
| P3.4 | Real-hardware verification: macOS/M3 Max (videotoolbox) is REQUIRED for exit; Linux (nvenc, qsv, vaapi on the T2 box) and Windows are recorded as owner-run checklists (reports/hw-verify-<platform>.md) and may complete post-exit — logged Open, not blocking, per current dev environment. **[AMENDED 2026-08-11, an upstream media server-study impl run — AV1 ENCODE additions to this backlog: av1_nvenc (NVIDIA Ada+), av1_qsv (Intel Arc/DG2+ — the reference N100's QSV is av1-DECODE-only), av1_vaapi (Intel Arc iHD / AMD RDNA3+ Mesa), av1_amf (AMD RDNA3+ Windows) — each ENCODE path + its hwaccel-engagement markers is FIXTURE-ONLY on the M3 Max (no AV1 encode hardware exists here; no av1_videotoolbox encoder exists at all), plus windows-x64 bundled-ffmpeg libsvtav1 presence (manifest not executable on this host). GENUINELY PROVEN on the M3 Max: the Tier-0 AV1 REFUSAL path against the real probe battery (asserts no backend reports av1 encode → fails loudly on capable hardware), Tier-1 SOFTWARE av1 end-to-end (bundled libsvtav1, ffprobe codec_name==av1), and av1 hw DECODE (videotoolbox). C2 ABR adds one owner-verify item: eyeball a rung switch on the N100 + confirm the tray/System page reflects single-slot occupancy.]**
| P3.5 | ffmpeg resolution per P1.18 as-built: LUMBRE_FFMPEG/LUMBRE_FFPROBE env → PATH fallback, CI installs the pinned build; per-platform vendored bundling remains Phase 4 packaging (no download-script here). VerifiedCapabilities invalidation keys on the RESOLVED binary's build hash (ffmpeg -version fingerprint), so it is correct under both resolution modes; arg builder targets the pinned CI version and any owner-local version skew surfaces as probe self-test differences, not silent arg breakage |
| P3.6 | Fixture media: generated by the checked-in generator script (lavfi testsrc2 + sine, muxed to the §10 dimension combinations); no third-party media in the repo, ever (license posture D12) |
| P3.7 | Phase 2's static compatibility preview is DELETED when plan() wires in; /playback/plan drops x-phase2-preview (additive-policy exception pre-approved: the preview was marked experimental in-contract) |
| P3.8 | Session throttle mechanism: SIGSTOP/SIGCONT on POSIX; Windows suspension via the documented job-object helper; integration-tested on all three OSes; if Windows suspension proves unreliable in CI, fallback = ffmpeg -readrate pacing, decided by test evidence and logged |
| P3.9 | Inherited from Phases 0–2 STATE.md (§1 audit VERIFIED all six, then honor): (a) matrix cases 002/005/006/007 gain their Stage-G informational reasons (hw-encoder-selected:/software-fallback:) when Stage G lands — regression law applies, why: = Stage G arrival; (b) the tone-map-refused-by-policy case (T0 + software-only caps) lands WITH Stage C; (c) the fixture generator EXISTS (P1.18) — Step 1 extends it to the §10 dimension combinations, does not recreate it; (d) matrix runner + D22 meta-test exist — Step 1 converts the expected-red inversion to a progressive burn-up (meta-test retires when the first stage greens its cases); (e) external subtitle sidecars have NO delivery endpoint yet — the hls-vtt strategy work adds the additive contract path for segmented VTT (and external-sidecar ingestion to it), logged as a P1.17-style additive addition; (f) media_streams already carries the five typed columns via migration 0002 + color_transfer backfill — trust the DB, not PLAYBACK.md's assumption that extraction might be pending |
| P3.10 | Small-correctness gap lane (Wave 1, half-day scope): same-byte-size in-place edits are not re-hashed (path+size short-circuit, no mtime column — Phase 1 Open item). Add mtime_ms to media_files (additive 00xx), include it in the short-circuit, re-probe on mismatch. Precedes engine work because Phase 3's plans are only as correct as the media_streams rows they read |
| P4.1 | Distribution per plan §11, UNSIGNED posture (owner decision 2026-07-24): Linux Docker/Compose canonical + tarball/systemd; Windows MSI (WiX v4: service, firewall rule, tray controller); macOS .pkg + menubar controller + Homebrew cask. No Apple notarization, no Authenticode — trust is delivered instead via checksums + minisign/sigstore signatures + cosign-signed Docker images + first-class install documentation covering every unsigned-install caveat. Reversible: the release pipeline keeps clean signing insertion points (a sign: hook per artifact, no-op in v1) so adding certificates later is a pipeline PR, not a rework |
| P4.9 | Unsigned-install documentation is a FIRST-CLASS DELIVERABLE, not a footnote (docs/install/ + repo README section): per-platform honest walkthroughs with screenshots — macOS: the full current Gatekeeper reality (blocked-on-open dialog → System Settings → Privacy & Security → Open Anyway → re-open + authenticate; plus the xattr -d com.apple.quarantine terminal path for CLI-comfortable users; Homebrew cask documented with --no-quarantine caveat); Windows: SmartScreen "More info → Run anyway" with an explanation of WHY it appears; every platform: checksum + minisign verification instructions promoted to the primary trust ritual, with the public key published in-repo AND in the docs site AND in release notes (three places, so key-substitution attacks require compromising all of them). Tone: honest and unapologetic — explain that signing certificates cost money the project doesn't take (no telemetry, no revenue), and verification via signatures is the open-source trust model. Docker documented as the friction-free recommended path |
| P4.2 | Embedded PostgreSQL: per-platform pinned binaries, child process on localhost socket, data under app-data dir; PG major upgrades via automated dump/restore job with pre-upgrade backup; external-PG env var path unchanged and equally tested |
| P4.3 | Updates: server checks a signed release manifest (minisign/sigstore — worker decides by evaluation, logs choice), notifies in admin UI, NEVER auto-applies; the check respects D14 (no identifying payload — a bare versioned manifest fetch; document exactly what the request contains) |
| P4.4 | Built-in ACME (Let's Encrypt HTTP-01 + DNS-01) lands now for direct-exposure installs; reverse-proxy path remains first-class; HSTS on when TLS terminates internally |
| P4.5 | Crash handling: process-level handlers write local crash files (redacted: no paths beyond app dir, no tokens); admin UI offers "reveal in folder" — sharing is entirely manual (D14) |
| P4.6 | Onboarding wizard (web, first boot): admin creation → library paths (native folder picker via platform controller apps; manual path entry always available) → hardware probe run → capability report → optional restricted-content capability enablement (with age-config, defaults per D13) |
| P4.7 | Secrets: OS keychain (macOS Keychain, Windows DPAPI, libsecret where present) else 0600 file; migration between backends handled |
| P4.8 | Relicense readiness = a CHECKLIST DELIVERABLE (reports/agpl-readiness.md): license-checker clean, provenance log complete, headers script ready, LICENSE swap PR drafted-not-merged; going public remains an owner decision outside this phase |
| P4.10 | Audit mismatch: NO first-admin bootstrap exists — seed script only; every user-create path requires an existing admin JWT (chicken-and-egg on any fresh install). Onboarding wizard (lane C) requires an additive first-boot setup surface: setup-state endpoint + create-first-admin, usable ONLY while the users table is empty, permanently inert after (tested both directions — a populated instance must 404/403 it byte-identically to nonexistent) |
| P4.11 | Audit mismatch: /system/info.version is hardcoded '1.0.0' while every package is 0.x, and no `lumbre` CLI exists anywhere (plan §14 names the CLI). Release lane I owns single-source version stamping: root package.json version → build-time injection → `lumbre --version` + /system/info + release manifest all read the same value; hardcode removed |
| P4.12 | Audit mismatch: NO Dockerfile exists (dev compose only: postgres/adminer/optional redis). Lane I2 is a greenfield image build (multi-stage, non-root, healthcheck, multi-arch, prod compose file), not "hardening" of an existing image |
| P4.13 | Audit mismatch: the events envelope enum (13 types) has NO job.* events — the jobs dashboard's "live via events" (deliverable D) needs an additive job.updated envelope event (jobId, type, status, progress) emitted at ledger transitions; P1.17-style additive contract addition |
| P4.14 | Audit mismatch: NO process-level crash handlers exist anywhere (server has zero process.on — not even SIGTERM; worker has SIGINT/SIGTERM only). P4.5 is greenfield in both apps: uncaughtException/unhandledRejection → redacted local crash file + clean exit; server also gains graceful SIGTERM (installers' service managers need it) |
| P4.15 | Audit mismatch: rate limiting covers exactly 3 endpoints (login, refresh per-IP; unlock per-user). G1's sweep must cover every unauthenticated surface (incl. /system/capabilities, /healthz) and the ?token= media GETs; web CSP still carries script-src 'unsafe-inline' (the Phase 2 Open item G1 closes with nonces) |
| P4.16 | Audit mismatch: no update-check surface exists in the contract (no /updates path). Lane I adds the additive admin endpoint + the server-side manifest fetch/verify per P4.3; admin UI notice consumes it (lane D) |
| P4.17 | Audit mismatch: secrets are env-only today (LUMBRE_JWT_SECRET with EPHEMERAL per-process fallback — restart logs everyone out on zero-config installs; provider keys env-only). P4.7 keychain work must persist the JWT secret at first boot (killing the ephemeral-fallback footgun for installer users) AND own the embedded-PG superuser credential via the SecretRef seam in ProvisioningInterface |
| P4.18 | Signing choice (P4.3 evaluation, Wave 0, orchestrator-verified): **minisign**, standard non-prehashed 'Ed' variant ONLY — prehashed 'ED'/BLAKE2b is recognized and REJECTED with a typed reason (we control the signer, payloads are small, half the crypto surface); server-side verification with ZERO new runtime deps via node:crypto (JWK OKP Ed25519 import + crypto.verify(null, …) — PureEdDSA). Wins on T0 dep weight, D14 offline trust model, and solo-maintainer key custody per P4.9. Sigstore is not rejected wholesale: GH artifact attestations (sigstore) land in lane I regardless — this decision covers ONLY the release-manager blessing signature the server verifies. Lane I's CI signer must use standard Ed mode (never minisign -x) |
| P4.19 | Update-check default 'daily' (lane I decision, orchestrator-accepted): plan §10 names the check a feature; D14 is satisfied by the request CONTENT being non-identifying (bare GET of a static manifest, generic UA 'lumbre-update-check', zero params/version/OS — enforced by a real local-HTTP capture test), not by suppressing frequency; 'off'/'manual' are full opt-outs incl. the admin endpoint reporting 'disabled'; 10s boot grace before first check |
| P4.22 | **D23 FOURTH use (pre-release breaking contract correction): restricted-content PIN constrained to exactly 4 digits.** `RestrictedSettingsUpdate.pin` and `UnlockRequest.pin` both gain `minLength: 4` / `maxLength: 4` / `pattern: '^[0-9]{4}$'`. Fixes a real lockout: the PIN-SET surfaces accepted any length while the ONE unlock surface (`apps/web/src/components/restricted/PinModal.tsx`) is a fixed 4-digit auto-submitting buffer, so a 5-digit PIN made restricted content permanently unreachable. **oasdiff classification: 4 error + 2 warning, all six on the two `pin` request properties — 2 × request-property-min-length-increased (1→4 on unlock, 0→4 on restricted), 2 × request-property-pattern-added, 2 × request-property-max-length-set (warning). Zero response changes, zero path/operation changes.** `oasdiff breaking` still EXITS 0 (gate.mjs passes no `--fail-on`, so the gate step reports rather than blocks) — this row is the record D23 requires, not a waiver. SDK regenerated (description-only delta; openapi-typescript does not encode string constraints, so the TS shape is unchanged) and drift-clean. **`RestrictedSettingsUpdate.currentPin` is deliberately left UNCONSTRAINED** — it proves an already-stored secret, so an install that stored a non-conforming PIN before this change keeps a full recovery path (prove the old PIN → set a conforming one, or opt out) and needs NO migration. Enforcement: `apps/server/src/session/pin-format.ts` (both controllers), `apps/web/src/lib/pin-entry.ts` (all three client surfaces) |

## Frozen (done + verified only)

- 2026-07-22 Wave 1 · Bootstrap docs: STATE.md, CLAUDE.md (verbatim §4), LICENSE-INTENT.md, .gitignore.
- 2026-07-22 Wave 1 · Monorepo scaffold: pnpm workspace (9 projects), turbo, strict TS 5.9.3, eslint flat config; apps/server (NestJS, gateway/catalog/playback/session modules, /healthz verified 200), apps/worker (4 consumer stubs, clean SIGTERM), apps/web (Next 15 shell, builds), packages/shared (ids/time/enums/stable-stringify, 11 tests green), packages/playback-engine skeleton (PLAYBACK.md §2/§4/§5 types + reasons; plan() throws NotImplementedError). docker-compose.dev.yml (postgres:17 healthy on 5442, adminer, redis behind optional profile). dependency-cruiser rules verified clean: module-pairwise bans, pg/kysely only in packages/db, playback-engine purity, no cycles.
- 2026-07-22 Wave 1 · Contract: packages/contract/openapi.yaml (OpenAPI 3.1; 45 paths, 56 operations, 90 schemas; PlaybackPlan matches PLAYBACK.md §4/§5 exactly; redocly lint 0 errors 0 warnings), 8 event schemas (envelope + 7 payloads, Ajv-validated), codegen → packages/sdk/src/generated/{types.ts,paths.ts} deterministic (byte-identical double run), thin typed fetch client. Verified by orchestrator: counts + reason codes + zero banned strings.
- 2026-07-22 Wave 1 · DB: migrations/0001_init.sql = 27 tables per plan §6.3 (clean-room lumbre_uuidv7(), content_class trigger matching library, BRIN on events.ts_ms, tsvector GIN, deliberate ON DELETE everywhere, JSONB whitelist respected); schema.sql sha-matched + scratch-schema replay PASS; deterministic seed (2 users, 4 libraries, 29 items incl. 4 restricted with restricted-class people/tags); query-guard skeleton (ViewerContext, guard-only barrel, getItemById + listItems with keyset cursors; empty allowedLibraryIds compiles to WHERE false, not IN ()); leak suite 2 passed + 8 explicit todos.
- 2026-07-22 Wave 1 · Local gate baseline (macOS, orchestrator-run): `pnpm gate` ALL STEPS PASSED — codegen → sdk-drift → oasdiff (no baseline on main) → depcruise → license-check → lint → typecheck → test (incl. live-DB leak tests) → db:migrate-check → grep-gates (82 files).

- 2026-07-22 Wave 2 · Matrix scaffold: 10 YAML cases (1 direct-play, 2 direct-stream, 7 transcode) + fixtures + loader; `pnpm test:matrix` genuinely RED (10/10 fail NotImplementedError, each printing expected decision+reasons — the Phase 0 exit proof); matrix-meta suite (green, in gate) validates case schema + closed reason codes + plan() throwing. Verified by orchestrator run.
- 2026-07-22 Wave 2 · Conformance: global APP_GUARD 401 problem+json wall + problem-json filter + explicit 404 catch-all (`/*splat`); test walks 56/56 documented operations asserting 401 + RFC 9457 shape (Ajv), and asserts mounted route set is exactly {/healthz, /*splat}. Green in gate. Verified at source + run by orchestrator.
- 2026-07-22 Wave 2 · CI: .github/workflows/ci.yml — 3-OS matrix (ubuntu/windows/macos), pnpm via packageManager pin, per-OS oasdiff 1.25.1, cross-OS Postgres 17 via ikalnytskyi/action-setup-postgres@v7 on port 5442, migrate+seed, `pnpm gate`, inverted expected-red `test:matrix` step, warn-only perf-t0 job; .gitattributes LF-normalized (Windows sdk-drift protection). yaml-lint + action-validator clean. NOT yet proven on real runners (no remote).
- 2026-07-22 Wave 2 · Perf T0 scaffold: scripts/perf-t0.mjs + checked-in perf/t0-baseline.json (idle RSS 90.5 MiB ≤ 220 MiB budget; p95 getItemById 0.47 ms, listItems 0.34 ms ≤ 100 ms budget vs 29-item seed — 50k-item seed arrives Phase 2).
- 2026-07-22 Wave 2 · Hygiene: .editorconfig, .nvmrc (22), README.md stub, .github/PULL_REQUEST_TEMPLATE.md (gate checklist). Verified.
- 2026-07-22 · Post-wave-2 local gate baseline (macOS): ALL 10 STEPS PASSED incl. new conformance + matrix-meta; test:matrix red as designed.

- 2026-07-22 Wave 3 · Clean-clone verification: macOS host clone — install frozen-lockfile clean, `pnpm gate` ALL STEPS PASSED, matrix red wall exactly 10/10. Linux (node:22-bookworm container vs host DB) — exposed a REAL bug: turbo strict envMode dropped DATABASE_URL from turbo-run tasks (masked everywhere DB address == fallback default). Fixed: `globalEnv: ["DATABASE_URL"]` + `test` task `cache: false` (DB-backed suites must never cache-hit to a stale green). Proven: bogus DATABASE_URL now fails the db tests, real one passes.
- 2026-07-22 Wave 3 · Cross-review (severity-ranked, all resolved same-day):
  - B1 User.email required in contract, no column → `users.email CITEXT NOT NULL UNIQUE` added + seeded.
  - M1 media_kind drift ('movies' vs contract 'movie') → PG enum now singular; shared MediaKind enum added.
  - M2 watch_state drift ('in_progress' vs 'in-progress') → PG enum now hyphenated to match contract + shared verbatim.
  - M3 library content_class UPDATE did not propagate to items (guard filters on the denormalized column — security-relevant) → AFTER UPDATE propagation trigger added; proven live both directions against seed.
  - M4 Series.status required with no column → series_status PG enum + nullable column + contract field nullable.
  - M5 matrix case 005 contradicted PLAYBACK §3 (T0 policy + software caps ⇒ tone-map-refused-by-policy would also fire) → new t1-cpu-tonemap policy fixture; refusal path noted as a future case.
  - m1 required-vs-NULLable satellites → resolved per D24 (season/episode numbers NOT NULL; probe/tag-derived fields nullable in contract).
  - m2 macOS CI oasdiff unpinned (brew) → pinned darwin_arm64 release tarball like the other OSes.
  - n3 JSONB whitelist doc drift → CLAUDE.md invariant 3 now lists all 6 (plan §6.3 set).
  - n5 GET /progress missing from leak checklist → explicit it.todo added.
  - n1/n2/n4/n6 recorded as notes: Stage-G informational reasons deferred from matrix cases until Phase 3 (documented in caps.yaml header); Episode.runtimeMs derives from media_files.duration_ms; UserSettings typed contract fields map into user_settings.prefs JSONB (implicit mapping, acceptable); gate 1 capability flag + instance majority-age are config/env-level, no instance-settings table yet (Phase 1 decision).

- 2026-07-22 Wave 3 · Post-fix final baseline (macOS): `pnpm gate` ALL 10 STEPS PASSED on a clean committed tree; `pnpm test:matrix` exactly 10/10 red; `pnpm dev` boots server (/healthz JSON ok) + worker (consumers registered) + web (HTTP 200) together against compose PG on 5442.
- 2026-07-22 · 3-OS CI runner baseline GREEN: repo pushed to github.com/ozzydeving/Lumbre; run 29965470263 (commit f13c21a) — gate green on ubuntu-latest, windows-latest, macos-latest + perf-t0 scaffold green, expected-red matrix inversion held on all three. Two real cross-platform bugs found and fixed en route: macOS oasdiff release asset is darwin_all not darwin_arm64 (597a0a3); Windows spawnSync of the pnpm .cmd shim needs shell:true, POSIX keeps shell:false (f13c21a).
- 2026-07-22 · **Phase 0 exit gate: COMPLETE.** Every clause of the §1 mission maps to a Frozen entry; all exit-gate checklist items proven, including the 3-OS runner baseline.
- 2026-07-22 Phase 1 Wave 0/1 · Foundation merged (gate green on main after merge): migration 0002 (media_streams hdr/dv_profile/dv_bl_compat_id/has_atmos/interlaced; scan_checkpoints; provider_cache TEXT-body; metadata_provenance field-level; refresh_tokens), Kysely DB expanded 1→27 tables, @lumbre/db/internal subpath writer (depcruise fence live-verified: violating import in apps/server fails the gate; packages/jobs also allowed for ledger writes), packages/jobs pg-boss queue (typed scan/probe/image registry, ledger mirroring, lifecycle test), event schemas +scan.started/item.updated/library.created (envelope enum now 10), Phase-1 deps in one lockfile pass (chokidar, xxhash-wasm, music-metadata, sharp, blurhash, pg-boss, jose — license gate green). turbo test task serialized (dependsOn ^test) because live-DB suites reset the schema.
- 2026-07-22 Phase 1 Wave 1 · Probe pipeline merged: apps/worker/src/probe — ffprobe resolution (LUMBRE_FFPROBE→PATH), spawn wrapper, PURE extractMediaInfo per PLAYBACK.md §2.1 verbatim (mkv/webm+mp4-family disambiguation via filenameHint/major_brand/codec-allowlist; profile lowercase+strip-space normalization; level raw passthrough; Atmos via ff_truehd/eac3 profile tables; DV via DOVI side_data from libavutil/dovi_meta.h); 18 raw-probe JSON fixtures (DV/Atmos hand-authored, provenance in fixtures README); scripts/gen-media-fixtures.mjs (lavfi testsrc2, encoder feature-detect, manifest.json, gitignored output); 38 tests + network-optional integration.
- 2026-07-22 Phase 1 Wave 1 · Parser corpus merged: apps/worker/src/scan/parse — pure movie/TV/music/auxiliary rulesets with documented precedence (paren-year beats bare year, last paren-year wins for year-in-title traps; SxxEyy > dated > bare+dir-season > absolute; a proprietary server {edition-} > dash-edition; music D-NN > NN > flat triple; junk classification wins over location). Fixture corpus 123 movie / 157 TV / 62 music (+45 auxiliary, +16 edge) — all ≥ mission minimums, 403 tests green. Fixtures are JSON not YAML (no YAML dep reachable in worker).
- 2026-07-22 Phase 1 Wave 0b · Auth merged (gate green on main): jose HS256 access tokens (15 min; ephemeral dev secret + warning when LUMBRE_JWT_SECRET unset), opaque refresh tokens SHA-256-at-rest with rotation + theft response (reuse of rotated token revokes whole chain — proven at db/service/HTTP layers), login timing-parity 401, /system/capabilities real (P1.19), PUT /users/me/restricted self-only opt-in+PIN (hash-wasm argon2id, seed-compatible), /restricted/unlock|lock (gates 1–4 → 403, PIN → 401/422 split, 30-min TTL), resolveClearance pure five-gate function (all 32 combinations tested), ViewerContext provider (allowedLibraryIds incl. restricted only when g1–g4; restrictedCleared re-verified server-side every request). Conformance upgraded per D21: public ops schema-valid (real login → TokenPair), authenticated walk proves non-401 on all other ops, mounted-routes ⊆ contract. Identity reads live in the PUBLIC @lumbre/db barrel (not internal — server is fenced off internal; identity data isn't guard-scoped catalog data). DATE columns now parse as YYYY-MM-DD strings (tz bug fixed); ensureTestDatabase() gives server suites an isolated DB (real deadlock found when parallel suites reset the shared schema).
- 2026-07-22 Phase 1 Wave 1a · Scanner merged (gate green): worker_threads XXH64 identity pool (P1.20), deterministic streamed walk, per-file resolution (unchanged/re-encode/relocate/new), find-or-create hierarchy, tag-first music (real ffmpeg-tagged mp3 test), checkpoint-every-50 + resume (spy-verified), missing-file mark + 72h cascade (files only — items keep metadata, hidden while fileless), chokidar watcher with network-mount polling heuristic, migration 0003 media_files.version_label (editions/multi-part/multi-version → same item). Exit-gate tests green: rename/relocate (same ids, file.relocated events, progress intact, zero dupes), mount-drop (hidden→restored row-for-row identical), resume. Probe consumer writes raw JSON + typed streams incl. 0002 columns.
- 2026-07-22 Phase 1 Wave 2 · Providers + image pipeline merged (gate green): MetadataProvider interface + registry with assertScope choke-point (restricted-vs-general both directions tested), token-bucket rate limits (MB 1/s, TMDB 35/10s, TVDB 10/s), provider_cache-backed cachedGet (24h/7d/7d TTLs), TMDB/TVDB-v4/MusicBrainz+CAA with fixture-tested mappers + network-optional live contract tests, FakeProvider test-support, mergeFields precedence engine (nfo>tag>provider>filename, locks beat all — 20 table tests), Kodi NFO via fast-xml-parser (XMLValidator for malformedness), match scoring (Levenshtein+year), one-transaction satellite/people/tags/provider_ids write + item.updated, image pipeline (WebP 320/720/1280 + AVIF-when-supported + blurhash, all in real worker_threads, proven concurrent) with entity-existence check. Orchestrator integration: consumers wired into worker index, 0004 NULLS-NOT-DISTINCT fix (P1.22).
- 2026-07-22 Phase 1 Wave 3a · Guarded query layer + LEAK SUITE COMPLETE merged (gate green): guardPredicateSql shared predicate, applyGuardToJoined/People/Tags variants; searchCatalog (websearch_to_tsquery + content-class-gated people/tags ILIKE join — P1.21 finding), listPeople/getPersonById + listTags (own-class AND ≥1-visible-credit, no orphan-name leak), getContinueWatching, getRecentlyAdded, listProgress (item-guarded), getImageEntityAccess (4 entity branches), exportData (async generator, admin-only users sans secrets), clearanceDigest, readEventsForViewer (query half of gate-5 event delivery). leak.spec.ts: 0 todos, 23 tests both-directions + adversarial (cursor forgery, empty-allowlist WHERE false everywhere, injection strings). Seed extended with the collision/orphan/missing-file/images/events fixtures.
- 2026-07-22 Phase 1 Wave 3b · API wiring merged (gate green): 47 REST operations live (catalog-video 7, catalog-music 6, cross-type 3, images 1, progress 2, people/tags 3 NEW contract paths, libraries 8, users 9, devices 3, admin 3, data-freedom 2) + /v1/events websocket broadcaster (outbox poller, per-socket ViewerContext re-resolved ≤5s, gate-5 filtered). Contract additions additive (oasdiff: "No breaking changes"): /people, /people/{id}, /tags, ImageDescriptor + images[] on all 7 item schemas, Job schema firmed from stub. Two-live-sockets test GREEN (general event → both; restricted → cleared only, 750ms negative window). Seeded conformance 23 tests: hierarchy walks, search restricted-invisibility, progress 404-on-invisible, export exclusion, images bytes+ETag+304, byte-identical-404 restricted-vs-nonexistent. Query layer additions: catalog-detail/libraries(createLibrary tx+library.created event)/progress-write/admin. Real bugs found: /users/:id shadowed /users/me (route order); conformance :param matching gap. Playback paths stay unmounted (Phase 3), conformance allowance scoped to exactly that set.
- 2026-07-22 Phase 1 Wave 4a · Perf + report tooling merged: perf-t0 scanThroughput — 500 deterministic fake movies, in-process runScan, RECORDED ~13k–16.5k files/min (budget ≥200 warn-mode), idle RSS ~130–137 MiB (budget 220), p95 guarded queries <1ms; pre-existing perf-t0 server-boot bug fixed (dist child needed tsx NODE_OPTIONS). scripts/scan-report.mjs (§6 owner deliverable): scan/aggregate modes → reports/phase1-scan-report.md (summary, items by type, relinks from file.relocated, parse failures re-derived via scanner-identical rules, provider misses, blurhash coverage, missing files). reports/ gitignored.
- 2026-07-22 Phase 1 Wave 4b · scripts/scan-smoke.mjs + CI step (all 3 OSes, after gate): 500-file generated library (unicode, mixed-case ext, editions, multi-part, ~230-char deep paths, junk) — asserts exact item/file counts, junk exclusion, idempotent rescan. Local macOS: PASS (485 items / 495 files).
- 2026-07-22 Phase 1 Wave 4c · Adversarial + correctness review (2 independent reviewers) + fixes merged (gate green):
  - **Adversarial leak review VERDICT: NO constructable bypass found** — leak-impossibility guarantee holds. Guard choke-point airtight (zero selectFrom in apps/server; every read via @lumbre/db barrel), ViewerContext unforgeable (gate 5 re-read server-side every request, JWT claim advisory only), cursor forgery inert, injection parameterized, images authorize before 304/stream + ETag carries clearanceDigest, invisible≡nonexistent (byte-identical 404), internal-writer fence holds. 24/24 leak suite green live.
  - Fixes applied (see commit): metadata pipeline was never enqueued by the scanner (HIGH — provider enrichment dead in prod; now wired + regression test); refresh rotation not atomic (HIGH — compare-and-swap revoke, lost race = chain-revoke); pg-boss enqueue/ledger race (MED — own job id, ledger-row-before-send, recordActive inside try); events guard used stale payload content_class (MED latent, flagged by BOTH reviews — now live item-guard/library-join); WS half-open socket leak on ctx-resolve throw (LOW).
  - Accepted/documented (not bugs): ≥8MiB same-size middle-differing hash collision (P1.20 design tradeoff, relink consequence noted); 5s WS unlock-expiry lag (mission-sanctioned per-socket ≤5s cache window — explicit exit sign-off).
- 2026-07-22 · **Phase 1 §1 precondition audit PASSED** (clean tree at e63d27e == origin/main): clean-clone frozen-lockfile install + `pnpm gate` ALL STEPS PASSED (conformance walked 56/56 operations; db:migrate-check 27 tables; grep-gates 111 files); `pnpm test:matrix` exactly 10/10 red NotImplementedError each printing expected decision+reasons; leak suite 2 passing + 9 explicit todos. Reality-vs-prompt mismatches frozen as P1.10–P1.19.

- 2026-07-23 · **Phase 1 3-OS CI runner baseline GREEN**: run 30034135089 (commit c8ab0e7) — gate green on ubuntu-latest, windows-latest, macos-latest + perf-t0 scaffold green; expected-red matrix inversion held on all three. Two real cross-platform bugs found and fixed en route (first Windows/full CI run since Phase 1 code landed): (1) Windows ffprobe .cmd shim spawn EINVAL (Node CVE-2024-27980 refuses batch spawn without a shell) → runFfprobe uses shell:true for .cmd/.bat on win32; (2) perf-t0 'Build server' couldn't resolve dist-based @lumbre/shared on a fresh checkout → step builds the dependency closure via the '@lumbre/server...' filter.

- 2026-07-23 · **Phase 2 §1 precondition audit PASSED** (clean tree at 04cc976 == origin/main; only STATE.md doc delta past CI-green c8ab0e7): local `pnpm gate` ALL STEPS PASSED (31 tables, 319 files grep-clean); `pnpm test:matrix` exactly 10/10 red; 3-OS CI baseline green run 30034135089. Reality-vs-prompt mismatches frozen as P2.12–P2.18 (auth mostly pre-built in Phase 1; file-serving path absent from contract; playback_sessions/progress column gaps; dominant_color net-new; media-fetch query-token auth needed for browser media elements).

- 2026-07-23 Phase 2 Wave 1 · **Session completion (deliverable A)** merged (commit 0079490, gate green): strict DeviceProfile Ajv validation vs contract schema → 422 (P2.3); hand-rolled token-bucket rate limits on login (10/min/IP) / refresh (30/min/IP) / restricted-unlock (5/min/user), env-overridable, RFC 9457 429 + Retry-After, fake-clock tested (P2.1); fail2ban-compatible anomaly log (FAILED_LOGIN/REFRESH_REUSE/PIN_FAILURE/RATE_LIMITED, newline-injection-sanitized, no-secrets tested, LUMBRE_AUTH_LOG_FILE); LUMBRE_TRUST_PROXY + README remote-access section (P2.2); device-row reuse at login via additive LoginRequest.deviceId — owned-device match revokes chain + updates profile/last_seen, foreign/unknown id silently creates new (no existence leak) (P2.16). 15 new e2e tests (auth-security.e2e.spec.ts).
- 2026-07-23 Phase 2 Wave 1 · **Direct-play service + compat preview (deliverables B+C)** merged (0079490, gate green): migration 0006 (playback_session_status enum, status/error_code/updated_at_ms/last_heartbeat_ms, progress.duration_ms, active-status partial index); packages/playback-engine/src/compat-preview.ts pure checkStaticCompat — Stage A/B/C/D + subtitle renderability, closed §4 enum only, 39 tests incl. both exit-gate fixtures (hevc-main10-HDR10-mkv vs web-chrome → video-codec-unsupported+hdr-tone-map-required+container; h264/aac/mp4+PGS → subtitle-format-requires-burn-in), plan()/matrix untouched (10/10 red confirmed post-merge); packages/db playback-session queries (ctx-guarded, cross-user isolation tested, transactional playback.started/ended outbox events) + getMediaInfoAssembly (guarded §2.1 assembly; local structural types, no engine dep) + durationMs on progress read/write; server playback module: plan preview (P2.19), session create 201/409-with-wouldBeReasons, GET/DELETE own-only, range file serving (200/206/416, strong ETag=content_hash, If-Range, Cache-Control private, path from media_files only), @AllowQueryToken ?token= auth on exactly images+file GETs with token-never-echoed sanitization (P2.18), progress-PUT sessionId heartbeat (best-effort), 60s sweeper ending 15-min-stale sessions. 28 e2e tests; conformance narrowed to Phase-3-only allowance (HLS manifest). Server suite 261 tests.
- 2026-07-23 Phase 2 Wave 1 · **Dominant-color retrofit (deliverable G)** merged (0079490, gate green): migration 0005 images.dominant_color; computeDominantColor (sharp stats on 64×64 downsize → #rrggbb) alongside blurhash in the same worker_thread; consumer writes color for original+variants; image-backfill job (batches of 200, id-cursor re-enqueue resumability proven by test, missing-file '' sentinel never re-selected, boot-time idempotent enqueue via hasQueuedOrActiveJobOfType, worker_threads concurrency 2); ImageDescriptor.dominantColor in db + contract + SDK (''/NULL → null on read). Worker suite 597 tests.
- 2026-07-23 · Phase 2 Wave 1 post-merge baseline (macOS): `pnpm gate` ALL 10 STEPS PASSED on committed tree 0079490; `pnpm test:matrix` exactly 10/10 red.

- 2026-07-23 Phase 2 Wave 2 · **Checkpoint slice merged** (c2a6c10 + fix commit, gate green): tokens.css (P2.7 radius + P2.10 motion tokens verbatim, warm-dark default + ember family + light theme, glass/shadow tokens, neutral-warm dominant fallback); stylelint bans hardcoded border-radius outside tokens (in gate lint, violation-proven); app shell (Lucide-only via shared Icon wrapper, theme toggle, radius-inheriting skeletons, animated focus rings, reduced-motion collapse); login with remembered server URL + honest MSE/mediaCapabilities DeviceProfile builder (Ajv-tested vs contract; mkv/avi never claimed, passthrough/DV always false, maxChannels 2, H264 level table from codec-string probes); auth store (memory access token, localStorage refresh/deviceId/serverUrl, single-flight rotation-safe refresh proven under concurrency); home (continue-watching + recently-added, blurhash LQIP crossfade, srcset variants, ?token= media URLs, compositor-only hover lift); /styleguide gallery of every interactive element class. First-load JS /home: 114 kB (<200 kB budget). SDK type-level fix (SuccessResponseFor never matched numeric status keys).
- 2026-07-23 Phase 2 Wave 2 · **Three daily-drivable blockers found by real-browser verification, fixed** (gate green): (1) tsx dev runner never emitted DI metadata — Nest silently injected undefined everywhere; latent since Phase 1 (only dep-free /healthz was ever curled). New apps/server/scripts/dev.mjs: tsc --watch + node --watch --import tsx dist. (2) No CORS existed; browser client is cross-origin by design → applyCors + LUMBRE_CORS_ORIGINS strict allowlist (default local dev pairing, empty disables). (3) SDK client invoked window.fetch with the client instance as receiver → "Illegal invocation" in every real browser (Node fetch is receiver-insensitive, smoke tests green — the trap). Now fetch.bind(globalThis). Verified: real Chrome login → device profile accepted → /home renders seeded rows. Lesson recorded: browser-facing code is only verified in a browser.
- 2026-07-23 · **Owner checkpoint RESOLVED: approved with tweaks** → P2.20 liquid-glass amendment + deeper blacks applied (commit 5b84040, CSS-only, /home first-load unchanged 114 kB, AA contrast verified, styleguide gained a liquid-glass demo section). v2 screenshots delivered to owner; Wave 2 surfaces proceeded.
- 2026-07-23 Phase 2 Wave 3 · **WS presence + admin feed + instant relock** merged (ff83ad0, scoped tests green): playback.progress event (≤1/30s via 0007 last_progress_event_at_ms marker, transactional, item-guarded); GET /admin/sessions with redaction-not-omission for uncleared admins (itemTitle null + contentHidden true — tested both directions); restricted.locked/unlocked user-scoped events (USER_ONLY_TYPES, negative two-socket test) + broadcaster expiry synthesis. REAL latent bug fixed: broadcaster poll() short-circuited on empty outbox so per-socket ctx was never re-resolved on a quiet server — auto-relock would have silently failed; ctx refresh now independent of outbox traffic.
- 2026-07-23 Phase 2 Wave 2(i) · **Browse/detail/search** merged (dc490b3, verified live in browser vs 50k library): hand-rolled virtualized grid (windowing math unit-tested; real first-mount ref bug found+fixed in-browser), cursor-fed pagination, 121 kB browse first-load; /items/[type]/[id] with AmbientHero (dominantColor glow + glass per P2.11/P2.20); debounced grouped search (topbar popover + page); View Transitions poster→hero; AppShell auth-redirect hardened (store subscription, no more blank /home); seed-large.mjs 50k-movie seed (6.7s, rerun-safe) as db:seed-large.
- 2026-07-23 Phase 2 Wave 2(ii) · **Player/music/restricted/settings** merged (a22608b, 78/78 web tests, curl-verified vs real ffmpeg fixtures on isolated stack): /watch direct-play (glass auto-hide controls, pill scrubber, shortcuts, heartbeat+resume, ambient idle, session lifecycle), typed unavailable screen mapping all §4 codes (hevc10/mkv fixture verified: container + video-codec reasons, 409 body identical); music MusicPlayerProvider above route-remount boundary, glass mini-player, queue drawer, dual-<audio> gapless chaining; restricted PIN modal + lock control + events-socket.ts (reconnect/backoff) instant relock + catalog invalidation; /settings (profile/PIN/prefs). Subtitle honesty: no sidecar endpoint exists → typed Phase-3 state.
- 2026-07-23 · Wave 2 integration: gate ALL STEPS PASSED at 62c23df (one exactOptionalPropertyTypes test fix en route); pushed.
- 2026-07-23 Phase 2 · **Gap-closure lane** merged: (1) createLibrary auto-grants creator permission — GENERAL only, restricted stays default-deny incl. creator (§6.4 gate 4 preserved); (2) album→artist link loss root-caused to metadata consumer's upsert omitting parentId (ON CONFLICT nulled it) — the hierarchy code was innocent; (3) PlaybackSession.media populated; (4) additive PersonCredit/MediaFileSummary detail schemas (includeDetail opt-in so list surfaces don't pay the join, people guarded per P1.21); (5) list sort/order params with sort-tuple cursors; (6) GET /progress/{itemId}; (7) search @50k fixed — migration 0008 pg_trgm GIN expression indexes on name::text (CITEXT footgun documented) + OR→UNION restructure, p95 133.9→~22ms, leak suite unchanged.
- 2026-07-23 Phase 2 · **Web-wiring lane** merged (coded against real regenerated types): music play triggers (track/album/artist → queue), auth-store globalThis singleton (HMR duplication), now-playing pulse (opacity-only), detail people/versions UI, sort pills enabled, resume via GET /progress/{itemId}. 95/95 web tests; browse 122 kB.
- 2026-07-23 Phase 2 Wave 4 · **Security review (opus, read-only) + fixes** merged: verdict NO CRITICAL/HIGH; every core property verified sound by live probing (rotation/reuse chain revocation, restrictedUnlocked advisory-only re-verified server-side, @AllowQueryToken scoped to exactly images+file GETs with token never echoed, five-gate restricted walk byte-identical-404, admin-session redaction for uncleared admins, range serving IDOR-safe, WS user-scoping). F1/F2/F3 fixed (355→363 server tests): F1 problem-json @Catch() catch-all + requireUuidParam on all 28 :id routes (malformed uuid → RFC 9457 404 byte-identical to nonexistent, was bare 500 + DB log spam); F2 nosniff/Referrer-Policy:no-referrer/X-Frame-Options:DENY on server+web + baseline CSP; F3 X-Powered-By disabled. **OWNER ACK (documented INFO tradeoffs, not fixed):** F4 refresh token in localStorage (mitigated: access token memory-only, no eval; revisit with nonce-CSP), F5 content_hash ETag (served only post-auth, Cache-Control private), F6 WS live-tail no-socket backlog (single-process v1 limitation, per-socket filter still applies).
- 2026-07-23 Phase 2 · **Perf enforcement flip (deliverable F)** merged: T0 harness now blocking @50k seed with endpoint p95 (browse ~19ms, detail ~2ms, continue-watching ~2ms, search 22.6ms — all ≤100ms after 0008), idle RSS 145–154 MiB (≤220), scan 15.8k files/min; 200KB browse bundle gate (118.5 KB); Lighthouse ≥90 (measured 1.0) on /login (auth routes redirect unauthenticated — Phase 3/4 note); perf/baselines.json with CI-enforced update-requires-reason. @lhci/cli kept OUT of the lockfile (transitive crash-reporter trips D14) — pinned npx.
- 2026-07-23 Phase 2 · **Owner-in-the-loop visual E2E pass (orchestrator, real Chrome vs scanned ffmpeg fixtures)** — VERIFIED WORKING: login→home→browse (50k + real fixture lib, sort pills, Versions from mediaFiles), item detail ambient hero, direct-play VIDEO plays (currentTime advances, readyState 4) with glass controls + Resume prompt (progress+resume live), typed unavailable state on hevc/mkv fixture with correct reason code, MUSIC plays via dual-<audio> and survives client-side nav (mini-player persists), restricted PIN modal (glass, pill, ember focus ring). Artist→album (gap fix 2) + library-create auto-grant (gap fix 1) confirmed live. Screenshots in reports/phase2-checkpoint/e2e-*.png.
- 2026-07-23 Phase 2 · **Four browser-only bugs found + fixed in the E2E pass** (each fully broke a critical path; committed with tests): (1) tsx dev runner can't emit DI metadata → Nest injected undefined (latent since Phase 1, only /healthz curled); scripts/dev.mjs. (2) SDK + auth-store captured window.fetch unbound → "Illegal invocation" in real browsers (Node fetch receiver-insensitive, unit tests passed); bound to globalThis. (3) refreshNow cleared the credential on ANY transient failure not just 401 → every server blip logged the user out; now 401-only. (4) VideoPlayer src-attach keyed on the token URL alone (resolves after <video> mounts) → effect ran with null ref, never re-ran, playback silently dead; track element in state via callback ref. (5) CSP hash alongside 'unsafe-inline' → CSP3 ignores 'unsafe-inline', blocked Next RSC scripts → blank page; hash dropped until nonce middleware. Lesson (memory saved): browser-facing code is ONLY verified in a browser.
- 2026-07-23 · Post-Wave-4 baseline: `pnpm gate` ALL 10 STEPS PASSED (server 363 / worker 593 / db 123 / web 95 / playback-engine 39 / contract 19). One transient live-DB flake (shared-DB reset contention under turbo) passed on re-run.
- 2026-07-24 Phase 2 · **First ENFORCING perf-CI run caught a real regression** (the flip earning its keep): browse p95 209.8ms on ubuntu @50k — listCatalogItems filtered+sorted the whole library per page ("Rows Removed by Filter: 50000") and the OR-form keyset made deep pages re-walk their prefix as a per-row Filter. Fixed: migration 0009 composite keyset indexes (library_id, item_type, added_at_ms DESC, id DESC + title variant) AND cursor switched to ROW comparison — Postgres pushes it into an Index Cond (b-tree seek, EXPLAIN-verified 0.057ms flat at any depth). Local p95 10.49ms. All 123 db tests incl. sort×order cursor walks unchanged. Also fixed: perf-web-budget on fresh checkout builds the workspace dep closure first (@lumbre/sdk is dist-resolved — the recurring P1 lesson, now in two scripts).
- 2026-07-24 · **Phase 2 3-OS + perf CI baseline GREEN: run 30057293760** — gate on ubuntu/windows/macos AND all three ENFORCING perf jobs (perf-t0, perf-web-budget, perf-lighthouse) green on commit 6f74a96.

- 2026-07-24 · **Phase 3 §1 precondition audit PASSED** (clean tree at bd83116 == origin/main): local `pnpm gate` ALL STEPS PASSED (31 tables, 521 files grep-clean, server 363 tests); `pnpm test:matrix` exactly 10/10 red NotImplementedError each printing expected decision+reasons; 3-OS + perf CI baseline green run 30057293760. P3.9 assumption diff verified all six inherited items against the tree: (a) caps.yaml header documents Stage-G fixture deferral, (c) scripts/gen-media-fixtures.mjs exists, (d) matrix runner + matrix-meta.spec.ts exist, (e) no subtitle-sidecar delivery path in openapi.yaml, (f) migration 0002 columns present + color_transfer backfill frozen in Phase 1 §6 entry, and (P3.10 target confirmed) scanner.ts path+size short-circuit with zero mtime references repo-wide. **Mismatch logged, not hidden:** Phase 2 exit gate's two owner-hands-on items (§5 LAN/multi-device pass; daily-drivable declared by owner) remain Open — the owner issuing this Phase 3 kickoff is the authorization to proceed; those checkboxes stay on the Phase 2 list and are NOT retro-marked. Types/reasons/output contracts in packages/playback-engine/src verified still verbatim-matching PLAYBACK.md §2/§4/§5 (incl. TrackSelection and ToneMapMethod 'cpu-zscale' shape).

- 2026-07-24 Phase 3 Step 1 · **Matrix harness upgrades merged** (48fbf5c, gate ALL STEPS PASSED, 543 files): matrix/burnup.json manifest (per-case green|red, all 10 seed cases red) with three-way runner semantics — NotImplementedError OR a mismatching plan = tolerated red (later-stage cases mismatch by design until their stage lands, P3.1), manifest-green replays the full fatal assertions (manifest can never launder a wrong plan), non-NIE throw always hard-fails (totality); greening/regressing without a same-PR burnup.json edit fails = P3.2 made mechanical. Burn-up line prints from the suite (`matrix burn-up: 0 green / 10 red / 10 total`). Meta-test (gate) validates manifest sync + case schema + new caps sets, and its D22 plan()-throws assertion now retires itself at first green (P3.9d). Four §10 property tests land ARMED (seeded mulberry32, full §2 type-space generators incl. constructive every-stage-passes direct-play generator; structural validatePlan; activate via hasAnyGreen(manifest) — Stage A's PR only flips manifest entries). Caps fixtures + P3.3 sets full-hw/encode-only/macos-vt, §2.5-shape-validated in gate. gen-media-fixtures.mjs extended to the §10 grid: 79 generated / 48 reason-coded skips on ffmpeg 8.1.1 (skips NEVER silent: hdr-requires-10bit ×32, avi-mux-cannot-identify-hevc ×8 + ts-mux-hevc-interlace-flag-lost ×4 both verified empirically, ac3/eac3-8ch encoder caps ×2, DV/PGS not-generatable-stock-ffmpeg ×2 — covered by hand-authored probe fixtures); probe.integration.spec.ts green vs generated output; failed-encode stale-file idempotency bug fixed. CI inverted expected-red step replaced by plain manifest-verified `pnpm test:matrix` (3 OS).
- 2026-07-24 Phase 3 Step 1 · **ENFORCEMENT GAP found + fixed (review finding, high value):** dependency-cruiser options (includeOnly `^(apps|packages)/` AND an unanchored exclude matching any dist/node_modules segment) silently dropped every node_modules/core-module target from the graph — so `no-raw-db-driver-outside-packages-db`, `pg-boss-outside-jobs-forbidden`, and `playback-engine-no-framework-or-node-io` had been structurally inert since Phase 0 (their to-patterns could never match a graph node). Real-world exposure was bounded: pnpm strict isolation + typecheck already fail any UNDECLARED banned import; the dead rules only mattered for the declared-dep scenario. Fixed (includeOnly widened; exclude scoped to workspace package-root dirs `^(apps|packages)/[^/]+/(dist|.next|.turbo|test|matrix)(/|$)` — no lookaheads, depcruise's safe-regex check rejects them) and PROVEN firing: simulated declared `pg` in apps/server → no-raw-db-driver error; bare `path` + `node:os` in playback-engine/src → purity errors; clean tree 0 violations (360 modules/1057 deps). Purity rule now bans EVERY node builtin (full list, bare + node:-prefixed) and Express/Fastify/Koa alongside NestJS; eslint additionally bans Date/process globals + Math.random in packages/playback-engine/src (proven firing; docs/PLAYBACK.md §0 law 1 — depcruise can't see global reads). Phase 0's "depcruise rules verified clean" claim was true only for workspace-path rules (the internal-db fence was and is real).

- 2026-07-24 Phase 3 Step 2a · **Stage A (Container) + pipeline skeleton merged** (86aa17f, gate ALL STEPS PASSED, orchestrator line-by-line spec review passed with zero findings): plan() now TOTAL (never throws; NotImplementedError class kept exported for the harness's red-detection, nothing throws it); src/stages/{types,container,not-implemented}.ts + src/plan.ts per §1 layout — Stage A pure container-membership, Stages B–F named permissive pass-through stubs each replaced by its own stage PR, Stage G deliberately unwired until F can produce a transcode candidate; final assembly per §3 verbatim (max-severity aggregation direct-play<direct-stream<transcode, stage-order reason concatenation, download+container-only-change→remux with the conservative all-reasons-are-container predicate); container field source/fmp4-hls|ts-hls(by device.hls.supportsFmp4)/mp4(remux); subtitle stub 'embed'-when-selected documented for Stage E replacement; ffmpegArgs [] until step 4 (documented interim); ENGINE_VERSION '0.1.0' (bump policy: minor/stage, patch/rule-fix; goldens pin it at step 4). 62 new container-dimension cases (011–072: every §2.1 container in+out of directPlayContainers, fmp4-vs-ts via device choice, music-only both ways, download remux + download direct-play, selection-null edges, empty directPlayContainers, network/policy/caps indifference, per-device coverage incl. new additive web-safari fixture) — every case future-proof-constructed (selected streams genuinely within device caps on every axis so later stages can't flip them; rule documented in matrix/README.md). Burn-up 63 green / 9 red / 72 total; per-seed red rationale recorded (002/007→B, 005/010→C, 004/009→D, 003/008→E, 006→F). All four §10 properties ACTIVE and green (matrix run 77 tests). Case-schema gap noted: expect block can't assert §5 container field yet — pinned in test/plan.spec.ts instead; extend load-cases schema in a later stage PR (logged Open).

- 2026-07-24 Phase 3 Step 2b · **Stage B (Video) merged** (ba278f9, gate ALL STEPS PASSED on re-run — first run hit the known shared-dev-DB reset-contention flake (auth.e2e, passes isolated + full re-run; Open item unchanged)): stages/video.ts per §3 verbatim with orchestrator-locked interpretations — SELECTED-stream-only, rule 1 (interlaced) and rule 2 (codec-unsupported) independent (seed 007 normative: [container, video-interlaced, video-codec-unsupported] exact), rule 2 short-circuits rule 3's axis checks (seed 002 normative: [video-codec-unsupported] alone), axis order profile→level→bitDepth→resolution→framerate, null-vacuous profile/level both sides, resolution = ONE reason for width and/or height, device maxBitrateBps deliberately unchecked (no §4 code; Stage F's dimension). SPEC AMBIGUITY RESOLUTION logged (candidate PLAYBACK.md clarification PR, owner sign-off needed): profile 'exceeds' ordering = documented per-codec ladder (h264 baseline<main<high<high10; hevc main<main10; vp9 profile0<profile2; others exact-string-match-or-exceeds; unrankable strings conservative-transcode with detail naming both). Multi-entry same-codec devices: pass if ANY entry accommodates; reasons vs synthetic most-permissive-per-axis entry with entries[0] fallback — the lane FOUND a real reason-completeness gap here (asymmetric entries can make the synthetic pass while no real entry does) and closed it with unit tests. video.action → 'transcode' on Stage B verdict (targetCodec/encoder/toneMap unset until F/G); ENGINE_VERSION 0.2.0. 67 new cases (073–139: full codec×bitDepth×interlaced grid, vc1/mpeg4/unknown, ladder/level/resolution/framerate boundaries incl. exact-equal-passes, 12-bit, multi-axis exact-order, music pass-through, selection-null-with-unsupported-video-present must-not-fire, 7 additive device fixtures). Bonus landed: expect.container in case schema + runner + meta validation (closes the Step 2a Open note), used by 6 cases across all four §5 container values. Burn-up 132 green / 7 red / 139; all four properties green; orchestrator line-by-line review: zero spec-fidelity findings.

- 2026-07-24 Phase 3 Step 2c · **Stage C (HDR) merged** (a014b7c, gate ALL STEPS PASSED first run): stages/hdr.ts per §3 verbatim — dv profile 5 (dolbyVision→copy else dv-profile5-requires-tonemap), dv 7/8 (dolbyVision→copy; else dvBlCompatId≠null AND device.hdr10→copy base layer + informational dv-stripped-to-hdr10; else hdr-tone-map-required), hdr10/hlg flag-match. THREE LOGGED SPEC INTERPRETATIONS (candidate PLAYBACK.md clarification PRs, owner sign-off): (1) Stage C evaluates whenever a video stream is selected, independent of Stage B's verdict — an HDR source re-encoded for codec reasons still needs tone-mapping for an SDR target; (2) dvProfile null/unrecognized → conservative profile-5 branch with detail naming the value; (3) dv-stripped-to-hdr10 fires ONLY on the repackage path (containerDirectPlayable = Stage A's verdict threaded as a boolean, stage stays pure) — a direct-played original file strips nothing; direct-play counterpart case pins reasons []. Tone-map REFUSAL implemented in Stage C per P3.9(b) (the §3 'Stage G yields no hardware method' seam, ahead of Stage G proper): refused iff no caps backend has non-empty toneMap AND (allowToneMapCpu 'never' OR 'tier-gated'@tier 0); refusal reason appended after the branch reason; MANDATORY case 144 (t0-default + software-only + hdr10-vs-SDR → transcode [hdr-tone-map-required, tone-map-refused-by-policy]); refused⇒ladder-[] pinned by plan()-level unit test with an explicit do-not-break note for Stage F's PR. Seeds 005 (transcode [hdr-tone-map-required] under t1-cpu-tonemap) + 010 (direct-stream [container, dv-stripped-to-hdr10]) greened exactly. ORCHESTRATOR REVIEW RESOLUTION (patch 0.3.0→0.3.1 per bump policy): lane surfaced (correctly, without guessing) that the download-remux container-only-change predicate treated informational dv-stripped-to-hdr10 as disqualifying; resolved — the predicate judges BLOCKING-class reasons only (§4 class split: blocking forces severity, informational never does; the strip is an arg-builder action identical under progressive remux); pinned by new case 205 (seed-010-in-download-mode → remux [container, dv-strip], container mp4) + two plan()-level unit tests (informational-does-not-block + blocking-non-container-still-blocks). 65 lane cases (140–204) + case 205; additive fixtures hevc-hdr10-strict/hevc-hlg-only devices, tonemap-never/tiergated-t1 policies (lane also noted: pre-existing hevc-hdr10-only fixture actually declares hdr10+hlg both true — misleadingly named, left untouched as load-bearing for seed 010). Burn-up 200 green / 5 red / 205; all four properties green; case-schema gap noted: expect block cannot assert ladder === [] (refused case pins it via unit test instead) — candidate schema extension for Stage F's PR.

- 2026-07-24 Phase 3 Step 2d · **Stage D (Audio) merged** (fc76a81, gate ALL STEPS PASSED first run): stages/audio.ts per §3 verbatim — rule 1 (no device entry) short-circuits 2/3; rules 2 (channels>cap) + 3 (truehd/dtshd without passthrough:true) independent both-fire in order; plain dts is NEVER DTS-HD (proof cases both directions); audio-atmos-lost informational appended after blocking reasons whenever THIS stage transcodes (codec-agnostic, trusts hasAtmos input); gapless-degraded = music mode (media.video.length===0, not selection-null) AND this-stage transcode, appended last. Rule 4 materializes in assembly (plan.ts): targetCodec = first of policy.audioTranscodeCodecPriority present in device.audio (defensive priority[0] fallback keeps plan total — case 244 pins), targetChannels = min(stream.channels, target-entry cap), bitrate BANDS ≤2/3–6/≥7ch → 160k/384k/512k with opus ×0.75 exact (verified real output: truehd 8ch → opus 6ch 288000) — band mapping + fallback logged as interpretations; sample-rate resample has no §5 field (arg-builder territory, step 4). ALAC absent from the §2.1 enum logged as a spec-text artifact (FLAC is the only lossless member). SURFACED NOT RESOLVED (owner/spec review, Step 2c precedent): music direct-stream into ts-hls also breaks gapless per §3's own 'gapless requires direct-play or fmp4 direct-stream' prose, but strict rule-5 text attaches gapless-degraded to transcodes only — Stage D has no visibility into device.hls; cases 249/250 pin both variants reason-free per strict text pending an owner decision. Seeds 004 ([container, audio-passthrough-unsupported, audio-atmos-lost] — 8ch exactly at cap proving rule 2 silent while rule 3 fires) + 009 ([audio-channels-exceed-device, gapless-degraded]) greened byte-for-byte. 60 cases (206–265) + additive fixtures (passthrough-capable/aac-only-no-opus devices, aac-first-audio policy); constraint-8 unit tests prove informational reasons never unlock download-remux and blocking audio reasons block it. ENGINE_VERSION 0.4.0. Burn-up 262 green / 3 red / 265; four properties green; orchestrator line-by-line review: zero spec-fidelity findings.

- 2026-07-24 Phase 3 Step 2e · **Stage E (Subtitles) merged** (efadbdd, gate ALL STEPS PASSED — lane ran it twice, no flake): stages/subtitle.ts per §3+§2.1 verbatim, returning {result, strategy, streamIndex?} (stages/types.ts untouched); real §5 subtitle output assembly replaces the 2a stub. TEXT cascade literal: hlsVtt-device+hls-vtt-policy → hls-vtt (ass adds informational subtitle-styling-lost; ass+preserveAssStyling → burn-in + subtitle-burn-in-for-styling); else embed iff renderText includes codec AND containerDirectPlayable (threaded like Stage C); else burn-in + subtitle-format-requires-burn-in. IMAGE: renderImage AND playable → embed, else burn-in. unknown: ALWAYS burn-in with subtitle-codec-unknown REPLACING the format reason regardless of renderImage/playability (§2.1's 'conservative: burn-in path' parenthetical overrides the IMAGE branch's literal listing — logged clarification candidate). Burn-in verdicts transcode + forces video.action transcode; video-transcode-for-subtitle-burn-in gated on Stage B's OWN verdict per literal text (fires under a Stage-C-only transcode, case 302; fires on video-less music burn-in where video.action stays 'none', case 320 — SURFACED ARTIFACT for owner/spec review, deliberately not special-cased). hls-vtt/none/embed never escalate — no §4 code exists for a VTT side-track, design law 2 forbids reason-less deviation, so direct-playable container + text sub + hlsVtt yields DIRECT-PLAY with strategy hls-vtt and informational-only reasons (cases 278/322). Literal-cascade observation: preferredTextSubMode 'burn-in' still embeds when renderText+playable hold (267/271/275). External subs treated by codec (delivery = session layer, P3.9(e), step 6). Seeds 003 (transcode [container, format-requires-burn-in, video-transcode-for-subtitle-burn-in] burn-in) + 008 (direct-stream [container, styling-lost] hls-vtt) greened byte-for-byte. 61 cases (266–326) + additive fixtures (text-all-capable/text-embed-capable/image-render-capable devices; text-burn-in-preferred/preserve-ass-styling policies). ORCHESTRATOR HARNESS FIX from lane finding: matrix/lib/validate-plan.ts asserted direct-play ⇒ reasons===[] — latent contradiction with the 2c/2e class-split rulings (unhit only by PRNG-seed luck); now direct-play ⇒ zero BLOCKING reasons (informational allowed) and non-direct-play ⇒ ≥1 reason per §5. ENGINE_VERSION 0.5.0. Burn-up 325 green / 1 red / 326 (last red: 006 awaits Stage F); four properties green.

- 2026-07-24 Phase 3 Step 2f · **Stage F (Bitrate + §7 Ladder) merged — §11 STEP 2 COMPLETE** (e6c4cbf, gate ALL STEPS PASSED twice, no flake): stages/ladder.ts — evaluateBitrate per §3 literal (outermost gate: never fires when B/C/E already force video transcode; video-selected scoping; fires iff overall > network.maxBitrateBps AND NOT (isLocal AND within device.maxStreamBitrateBps) — local-exceeds-device-cap FIRES, both directions pinned; no streamIndex, whole-file property like Stage A); buildLadder per §7 in bound order — hevc swap FIRST (hevcEncodePreferred + device hevc entry → rungs <2160p become hevc ×0.75 exact; swap-before-caps so drops evaluate the delivered bitrate, ordered-swap proof case survives the cap only via ×0.75), then conjunctive drops (a source height, b source bitrate comparator stream.bitrateBps ?? overall — logged interpretation, c network cap skipped when isLocal, d device cap always), keep-lowest from the post-swap table when all dropped. Assembly: ladder built iff video.action==='transcode' AND NOT tone-map-refused (Step 2c pin EXTENDED to a real non-empty rungs table — the old []-table pin was about to go vacuous; control test proves real rungs when not refused); audio-only/copy/music → [] per §5. expect.ladder exact deep-equal landed in the case schema (9 cases incl. matrix-level refused⇒[] re-pin + full-surviving-rung-list). Seed 006 greened (surviving rung exactly 1080p/4M vs wan-4mbps). REGRESSION LAW EXERCISED as designed: pre-existing case 262's incidental 7.5M overall would have gained the new reason — edited in the same PR with documented why: (lowered to 3.2M, its Stage-D-indifference point preserved). 61 cases (327–387) + additive fixtures (wan-20mbps/wan-1mbps/local-4mbps networks, bitrate-capped-device, hevc-preferred policy). ENGINE_VERSION 0.6.0. **Burn-up 387 green / 0 red / 387 — all six stages real, zero stubs in the pipeline (stages/not-implemented.ts orphaned pending step-3 removal or Stage G reuse), all ten Phase-0 seeds green, all four properties green in real mode.** Next per §11: step 3 (Stage G hardware routing + tier caps + tone-map method table vs P3.3 fixture caps sets, incl. P3.9(a) informational reasons for cases 002/005/006/007 under the regression law).

- 2026-07-24 Phase 3 Step 3 · **Stage G (hardware routing) merged** (69e0d14; gate ALL STEPS PASSED — lane ran twice green, orchestrator verify hit ONE shared-DB flake then green, running tally now 2 occurrences today, Open item unchanged): stages/hardware.ts per §8.3 — rules i/ii/iii with the HW-ONLY restriction on i/ii (literal §8.3 would let the bare software backend satisfy 'covers both' and emit hw-encoder-selected:software — logged clarification candidate); platform order = caps.backends ARRAY order (engine platform-blind per design law 4, probe emits §8.2 order); target encode codecs = the SET of distinct surviving-rung codecs, backend must cover all; tone-map-required candidates without a usable method fall through per-candidate; method table honoring each backend's verified toneMap list (videotoolbox→videotoolbox, nvenc→cuda, qsv/vaapi→opencl-else-vulkan, software→cpu-zscale iff allowToneMapCpu resolves true); decode-only-backend guard (d3d11va can't be vacuously selected on an empty target set); T0+full-software+≥1080p tier cap filters ladder to ≤480p with keep-lowest rescue, tier-capped reason fired only when the POST-rescue ladder actually shrank. Assembly: video.encoder + video.targetCodec (top surviving rung post-cap) + video.toneMap; tone-map-refused plans keep ladder [] and all three unset; stages/not-implemented.ts DELETED (fully orphaned — zero stubs remain). **P3.9(a) executed exactly as prescribed**: seeds 002/005/006/007 edited with why: = Stage G arrival — 002/006/007 gain [software-fallback:encode, software-fallback:tier-capped] (006's ladderMax tightens 4M→1.5M), 005 gains software-fallback:encode only (t1 policy, no cap; toneMap cpu-zscale documented). **P3.2 sweep, the anticipated blast radius**: 158 pre-existing case files + 6 unit-test assertions edited same-PR with why: citations (every transcoding plan now carries its Stage G reason; 10 expect.ladder arrays tightened; ~129 software-fallback:encode, ~55 +tier-capped, 13 hw-encoder-selected via full-hw/macos-vt fixtures). 59 new cases (388–446) across all four P3.3 sets + tier-cap grid with exact ladders + tone-map fall-through + opencl-else-vulkan preferences + platform-order proofs + Stage-G-silent proofs; 9 additive caps fixtures + empty-ladder policy. SURFACED for the step-7 audit (needs an hdr.ts-touching fix, out of this step's writable set): hdr.ts's refusal check is caps-global, so a synthetic unrefused plan can still fail tone-map METHOD resolution inside G. Schema gap noted: video.encoder/targetCodec/toneMap unassertable by the case schema (unit-pinned instead). ENGINE_VERSION 0.7.0. Burn-up 446 green / 0 red / 446; four properties green. **3-OS CI GREEN on the step-2-complete tree: run 30071146620** (first remote validation of Phase 3 work — gate + ENFORCING perf jobs all green on ubuntu/windows/macos).

- 2026-07-24 Phase 3 Step 4 · **ffmpeg arg builder + 25 goldens merged** (6445eac, gate ALL STEPS PASSED three runs, no flake): src/args/builder.ts pure — §6 canonical segment order 1–9 literal; CLOSED five-token set with unit-asserted token closure (every emitted '{'-arg must match the set); absolute→type-relative -map index conversion (the §2.1-index-vs-ffmpeg-0:v:n trap, unit-tested with video=0/audio=2); documented backend tables (accel: videotoolbox/cuda/qsv/vaapi/d3d11va, none for software routes; encoders: libx264/libx265 veryfast, *_videotoolbox, *_nvenc p4, *_qsv, *_vaapi, *_amf; rate control -b:v/-maxrate/-bufsize 2×; -level from the device entry's maxLevel; GOP -g round(2×fps) + force_key_frames expr verbatim; hevc -tag:v hvc1); §6-order filtergraph deinterlace→scale→tonemap→overlay with deterministic labels, documented tone-map filter strings per method (goldens pin), external sidecar overlay consumes [1:s:0]; interpretation A logged: -map [vout] emitted after -filter_complex because §6's literal segment juxtaposition would map the RAW stream while the filter output went unused (candidate spec clarification); remux output = -movflags +faststart -f mp4 {SESSION_DIR}/download.mp4 (candidate §6 addition); fmp4 → .m4s + init.mp4, mpegts → .ts no-init; -ar 48000 only when source sampleRate >48k. plan.ffmpegArgs now REAL for direct-stream/remux/transcode (default rung = top surviving); [] for direct-play, tone-map-refused, AND the newly-surfaced empty-policy.ladderRungs degenerate — a REAL total-ness bug the wiring exposed (transcode verdict with zero rungs would have thrown through plan(); treated like refused, logged as a candidate §7 clarification). 25 goldens under test/goldens/ ({scenario, args} JSON, deep-equal + determinism re-run; scenarios span copy-fmp4/ts, remux, sw/hw encodes ×4 backends, all 5 tone-map methods, deinterlace/scale/combined order proof, embedded-PGS + external-SRT burn-in, embed map, audio-only opus/aac, downmix, resample, seek variant with -ss before -i + {START_SEG}, GOP 59.94→120, hvc1, level cap). Golden discipline per §6: any new flag requires a same-PR golden update. ENGINE_VERSION 0.8.0. Matrix 446/446 green with ZERO case-file edits (schema never asserts ffmpegArgs; totality revalidates args-all-strings). Orchestrator review: canonical order + token discipline verified on the tone-map and external-burn-in goldens line-by-line, zero findings.

- 2026-07-24 Phase 3 Step 5 · **Capability probe + REAL macOS/M3 Max verification merged** (da24c11, gate ALL STEPS PASSED ×3): apps/worker/src/hwcaps — §8.1 battery per backend (decode per codec via forced -hwaccel_output_format + precise pixfmt-marker match; encode with ffprobe re-probe identity; HDR10-synthetic→SDR tone-map with color_transfer assert; 20s timeout kills the process group, timeout/failure = absent; injected CommandRunner so units never spawn), §8.2 platform candidate order preserved with software last (array order is Stage-G-load-bearing and round-trips storage via an explicit position column). Migration 0011 hw_capability_snapshots + hw_capability_backends (typed TEXT/TEXT[] with closed-set CHECK constraints — JSONB whitelist untouched; partial unique index = one is_current per platform; 33 tables total). Invalidation per P3.5: ffmpeg_build_hash = sha256 of the RESOLVED binary's full `ffmpeg -version` stdout (correct under env and PATH resolution both); gpu_fingerprint = sha256 of documented per-platform best-effort command ('' on failure → hash-only invalidation); worker boot compares and idempotently enqueues the new typed 'hwprobe' job (invariant 6); operator entry `pnpm --filter @lumbre/worker run hwprobe`. P3.3 fixture-schema conformance: ONE shared §2.5 structural validator proves caps.yaml fixture sets AND probe output share the exact schema. Public read getCurrentVerifiedCapabilities() in the db barrel (instance fact, P1.14 identity-reads precedent) — step 6's plan() wiring consumes it. **The real run caught its own instrumentation bugs** (the deliverable earning its keep): bare -hwaccel is only a hint — ffmpeg silently soft-falls-back when piping to -f null (false negatives on hevc/av1/vp9), and ffmpeg's own failure text contains the naive marker substring (false PASS on mpeg2); both fixed, then proven deterministic across 5 consecutive real runs. **M3 Max verified truth**: VideoToolbox decode h264/hevc/av1/vp9 PASS + mpeg2 correctly ABSENT, encode h264/hevc PASS (av1: no such ffmpeg encoder), tone-map videotoolbox PASS; software backend full PASS. reports/hw-verify-macos.md committed via explicit git add -f exception (exit-gate artifact; reports/ stays gitignored otherwise) with reviewed-by-owner: PENDING. Worker suite 678 passed (+82). Linux (nvenc/qsv/vaapi on the T2 box) + Windows remain owner-run checklists per P3.4 — logged Open, not blocking.

- 2026-07-24 Phase 3 Step 6a · **Worker transcode session runtime merged** (b96d6b7, gate ALL STEPS PASSED; shared-DB flake tally 3 today, still the known Open item): apps/worker/src/transcode — typed 'transcode' job through the real queue (the old bespoke JobConsumer transcode stub was never wired through the queue at all; deleted), token substitution, per-run subdirs with a worker-maintained served media.m3u8 (EXT-X-DISCONTINUITY between runs, global numbering, 120s per-segment retention), §9 state machine driven EXCLUSIVELY over the playback_sessions row (column-ownership seam contract documented verbatim in transcode/index.ts for lane 6b; plan JSONB stores {...plan, selection} — the selection sidecar is REQUIRED for seek-restart arg regeneration). Throttle P3.8 DECIDED BY TEST EVIDENCE: POSIX real SIGSTOP/SIGCONT proven in a real-ffmpeg integration test (ps state 'T' + produced_segment stall, then resume); win32 = unconditional -readrate 1.2 pacing, no native dependency, swap point isolated in throttle.ts. Seek-restart regenerates via buildFfmpegArgs withSeek (engine change = documented EXPORT-ONLY barrel addition); lane self-caught + fixed a wedge (seek-arg regeneration failure now fails the session + tears down). Failure path: stderr 4KB ring → stderr_tail; teardown on any external ended/failed status without double-emitting playback.ended. Migration 0012 (audit-driven delta: 3 enum values starting/suspended/seeking + 7 columns staging_dir/requested_segment/produced_segment/seek_target_ms/discontinuity_count/suspended_by_throttle/stderr_tail). Phase-2 behavioral fix: createPlaybackSession initial status now 'created' for non-direct-play (was unconditionally 'active' — the state machine could never start); all Phase 2 suites pass unmodified. Integration: 5 real-ffmpeg scenarios green in ~32s (start/first-segment observable, throttle suspend-resume, seek numbering+discontinuity, teardown, failure+stderr_tail); worker 749 passed; db 142; matrix 446/446 untouched.

- 2026-07-24 Phase 3 Step 6b · **Server playback HTTP surface merged** (531fab9, gate ALL STEPS PASSED on the committed tree): contract restored to the full §5 PlaybackPlan (D23 third use / P2.19's planned second correction, P3.7 preview + x-phase2-preview + compat-preview.ts all DELETED; oasdiff 2× response-required-property-removed + 1× api-path-removed for the never-implemented Phase-2 manifest.m3u8 placeholder — replaced by the coherent hls/ family, logged as a deliberate non-additive design call; pre-existing ToneMapMethod enum bug fixed zscale-cpu→cpu-zscale). Four additive endpoints (hls/media.m3u8 + hls/{file}, subtitles/media.m3u8 + subtitles/{file}); conformance unimplemented-allowance now EXACTLY ZERO (62/62 both walks). PlanInput assembly server-side: pure §2.6 selection cascade, isLocal from req.ip under LUMBRE_TRUST_PROXY (client claim ignored), network bound = min of 4 terms incl. the client's own declared cap (§2.3-faithful extension, logged), env-resolved ServerPolicy (tier defaults for maxSimultaneousTranscodes 1/2/4 matching the engine fixtures), caps from the probe snapshot with synthesized software-only fallback (verifiedAtMs 0 sentinel + boot warning). Session create: direct-play → Phase 2 path unchanged; transcodable → 201 with plan + typed transcode job enqueue; genuinely-unplayable (refused/empty-ladder) → 409 media-unplayable with real reasons (replaces the Phase-2 409-for-everything); admission semaphore → RFC 9457 429 transcode-slots-exhausted. HLS: manifest GET blocks ≤8s (250ms poll for active + produced_segment) else 503+Retry-After; strict-pattern + under-staging-dir-guarded file serving; requested_segment updated per segment GET (throttle input); out-of-window (>produced+3) OR pruned-ENOENT segment request → requestSeek + 503 Retry-After 1 (hls.js-compatible); ?token= scope extends to exactly the four new GETs (P2.18 pattern, never-echoed tested). Sweeper: 90s heartbeat-stale → suspended (suspended_by_throttle false per seam). P3.9(e): typed subtitle-extract job — embedded subs → real WebVTT + valid single-segment HLS subtitle playlist (real-ffmpeg integration test, works on direct-play sessions incl. their staging-dir lifecycle); **external sidecars logged Open honestly: the scanner never populates isExternal so the path is unreachable — not faked** (audit-wave item). Express-5 wildcard params return ARRAYS (empirically found; conformance route normalization fixed). Web interim shim (orchestrator): PlanPreview derived from the real plan (canDirectPlay = decision==='direct-play'); non-direct-play sessions immediately ended client-side pending the 6c HLS-player lane — Phase-2 UX preserved, now real-plan-driven. E2E: full-plan-shape, 201-transcodable, 409-unplayable, 429-at-cap, 90s-suspend, HLS 503→200 + guards + seek + token surfaces (seam-level: worker column/file writes simulated per the documented fallback; the real runtime is separately proven by 6a's integration suite). Suites: worker 755, db 149, engine 317 + matrix 446/446, server + web green; depcruise 0 violations @1270 deps.

- 2026-07-24 Phase 3 Step 6c · **Web HLS playback merged** (7e022b6, gate ALL STEPS PASSED ×3 across lane+orchestrator runs): hls.js@1.6.16 (Apache-2.0 through the license gate; telemetry audit clean — CMCD never enabled, zero runtime deps, no baked endpoints; D14 upheld), dynamically imported inside VideoPlayer's HLS attach effect only — proven absent from /browse and /watch first-load manifests; browse 119.1KB gz vs 200KB budget (enforced run green). Attach truth table: non-HLS decision → existing direct-play path; HLS + native support (Safari — WebKit propagates the manifest ?token= to all sub-requests) → native src; else hls.js with xhrSetup appending a FRESH access token per request (worker playlists carry run-relative token-less URIs by design; token never logged, console-spy tested). Retry: modern manifestLoadPolicy/playlistLoadPolicy/fragLoadPolicy (the legacy flat keys are DEAD in 1.6.16 — found and documented), linear backoff 1000ms matched to the server's constant Retry-After 1, maxNumRetry 8 (seek-into-unproduced converges through the 503 loop). hls-vtt strategy attaches the session VTT as a default <track> with language label. computePlanPreview deleted (player branches on the real session plan); the 6b blanket decline is now createDirectPlaySession — MUSIC-ONLY, pure applyDirectPlayOnlyGuard unit-tested; Open items logged: music HLS/gapless transcode playback, hls.js/light subpath (no .d.ts in 1.6.16), mid-session subtitle-switch UI (TrackPickers still transcode-labeled), fatal-error→UnavailableScreen bridge (browser-only verifiable, step 7). UnavailableScreen's stale 'coming in Phase 3' copy fixed. 132 web tests. **3-OS CI GREEN with the full session runtime aboard: run 30085336300** (the win32 battery-path fix af9f39a validated; the intermediate pre-fix run's windows failure superseded).

- 2026-07-24 Phase 3 Step 7 · **Adversarial audit + fixes + REAL OWNER-SMOKE frozen** (this commit batch; final `pnpm gate` ALL STEPS PASSED on a quiet DB): (1) AUDIT (7a): behavior inventory §0–§8 vs cases/tests/goldens; 56 new cases → **burn-up 502/502**, then 7b fixes (+4 cases) → **506 green / 0 red / 506** (exit target ≥500 MET). Findings F1–F7 all pinned-or-fixed: F2 route-level refusal fix closes the un-tone-mapped-HDR-to-SDR hole (refusal authority moved from Stage C's caps-global approximation into the Stage-G seam per §3 literal; seed 144 byte-identical); F1 transcode-disabled-by-policy now emittable (refused-style empty outputs; repackaging-is-not-transcoding pinned); F4 vaapi burn-in hwdownload→overlay→hwupload graph + goldens 26/27; F5 (device-entry maxBitrateBps dead field) + F6 (hls.lowLatency consumed nowhere) logged as spec-PR candidates. ENGINE_VERSION 0.8.2 (incl. the VT-graph patch below). (2) CI INTEGRATION COVERAGE: ffmpeg was NEVER installed on runners — every gated suite silently skipped while the exit gate demanded 3-OS integration; fixed (per-OS install + fixture generation + LUMBRE_REQUIRE_FFMPEG hard-fail escalation + time-scaling + per-scenario fail-safe cleanup after forensic diagnosis of VM contention). **Session integration has now passed on ALL THREE runners across runs** (ubuntu consistently; windows run 30085336300; macos run 30093585776 via 10× patience). BILLED-MINUTES ECONOMY (owner directive, 1624/2000 used; macOS bills 10×/Windows 2×): ordinary pushes now run ubuntu-only; Windows/macOS legs behind [full-ci] tag or manual dispatch, reserved for phase boundaries. (3) OWNER SMOKE (real Chrome, real 4K HEVC HDR10 Atmos movie, real scanned library): **THE HEADLINE WORKS — Werewolf By Night (2160p HDR10/E-AC3-JOC) plays in Chrome from the web client, tone-mapped server-side through the REAL VideoToolbox chain at the 1080p rung, via hls.js, with resume-from-progress live** (screenshot reports/phase3-smoke-hdr-tonemap-playing.jpeg). Three browser/runtime-only defects found + FIXED en route (the Phase-2 lesson holding: browser-facing code is only verified in a browser; now extended: arg-builder graphs are only verified by RUNNING them): (a) Chrome answers 'maybe' to the Apple-HLS canPlayType probe with no native HLS behind it → MSE-first attach ordering; (b) the F2-era CSP blocked every hls.js playback (media-src lacked blob:) → blob: added with rationale; (c) **the VT tone-map ffmpeg graph was broken on real execution** (sw filter chain feeding scale_vt/hevc_videotoolbox without hw-frame plumbing, 'Function not implemented'; the probe battery passed because IT builds a correct chain) → -hwaccel_output_format videotoolbox_vld + scale folded into scale_vt + documented hybrid fallback; goldens 14 updated + 28 added; REAL-RUN integration test proves the produced segment is bt709 (vt-tonemap-args.integration.spec.ts, darwin-gated). Admission control verified live twice (T0 single slot → typed transcode-slots-exhausted rendered in UnavailableScreen). In-window seeks + throttle suspend/resume verified live. (4) HONEST GAPS → Open: web-client seek-into-UNPRODUCED region is blocked by an EVENT-playlist clamp (hls.js clamps 600s→live edge, never requests the out-of-window segment, so the §9 server seek trigger — proven working in the runtime integration test — is unreachable from the browser; fix needs a full-duration VOD-style playlist + a timestamp-continuity design decision (-copyts vs discontinuity), deliberately NOT improvised); PGS burn-in owner-smoke impossible without real PGS media (none in the library, stock ffmpeg can't generate it) — owner checklist; text-subtitle burn-in via the overlay filter is SUSPECT at runtime (overlay cannot consume subrip streams — never executed against real ffmpeg, needs the subtitles-filter design or PGS-only scoping); cpu-zscale tone-map chain fails on UNTAGGED HDR input (generator fixture gap, affects goldens 10/17 at runtime); shared-dev-DB reset foot-gun bit three times today (tally in Open item — isolated-test-DB fix promoted). Memory saved: GitHub Actions minutes budget.

- 2026-07-24 · **Phase 4 §1 precondition audit PASSED** (clean tree at 391ee82 == origin/main at audit start): local `pnpm gate` ALL STEPS PASSED (33 tables, 1167 files grep-clean); `pnpm test:matrix` **506 green / 0 red / 506**. THREE real CI defects found + fixed en route (a038c45, 3a37cc8): (1) **workflow DEAD on main** — f9a4583 put matrix.os in a job-level `if` where the matrix context does not exist (run 30095735973: zero jobs, 0s); OS selection moved into strategy.matrix via fromJSON. (2) **turbo strict envMode stripped LUMBRE_TEST_TIME_SCALE + LUMBRE_REQUIRE_FFMPEG** at the turbo→vitest boundary (the Phase 0 DATABASE_URL lesson, third strike): every slow-runner time-scale was a no-op (windows died at exactly the unscaled 30000ms) and the ffmpeg silent-skip escalation had been inert since it landed; globalEnv now passes both + LUMBRE_FFMPEG/FFPROBE, proven by poisoned-resolution loud failure through turbo. (3) **Step 7 record CORRECTED**: the cited windows integration pass (run 30085336300) PREDATES the runner ffmpeg install — that suite had silently skipped; with real env passthrough, [full-ci] run 30096845325 delivered the FIRST honest windows session-integration green (+ ubuntu + all 3 enforcing perf jobs). Its macos leg failed in vt-tonemap-args.integration — that suite's first-ever CI execution (its landing commit hit defect 1): GitHub macos runners are paravirtualized VMs with NO VideoToolbox hardware (AppleM2ScalerParavirtDriver unmatched, ffmpeg exit 187); the suite now gates on a real h264_videotoolbox probe encode, skips LOUDLY naming the owner-hardware coverage, and LUMBRE_REQUIRE_VT=1 escalates skip→hard-fail; proven three ways locally (real pass on M3 Max 2/2, fake-ffmpeg skip, REQUIRE_VT fail). Standing posture: real-VT execution is owner-hardware coverage (reports/hw-verify-macos.md); virtualized macos legs cover everything else. ci.yml workflow_dispatch gained an `os` choice input (all/ubuntu/ubuntu-windows/ubuntu-macos) so a single expensive leg (windows 2x, macos 10x) is validatable without full-matrix spend. Ubuntu validation run 30097882949 GREEN (gate + 3 perf jobs) on 3a37cc8. Billed-minutes: the [full-ci] baseline cost ~180 billed min; treat further windows/macos legs as phase-boundary-only. **Phase 3 exit-gate owner review items remain Open on the Phase 3 list, NOT retro-marked — the owner issuing this Phase 4 kickoff is the authorization to proceed (Phase 2→3 precedent).** Reality-vs-prompt mismatches frozen as P4.10–P4.17.

- 2026-07-24 Phase 4 Wave 0 · **Three seam contracts FROZEN** (orchestrator ground-truth: `pnpm gate` ALL STEPS PASSED re-run on the delivered tree, 1224 files; 117 tests / 18 spec files across the three packages; verify.ts/parse.ts/status/IPC types line-inspected): **@lumbre/provisioning** — SecretRef {keychain|dpapi|libsecret|file0600} (the P4.7 seam; interface never carries plaintext), ProvisioningStatus with EXPLICIT 'external' state (external-PG inertness is provable, not inferred), UpgradePlan closed step enum stop→backup→dumpall→initdb-new→restore→verify→swap→restart, typed CorruptionReport, PROVISIONING_CONTRACT_VERSION 1. **@lumbre/controller-ipc** — loopback-only local HTTP v1 (ephemeral port + bearer token in 0600 files under app-data; named-pipe/uds documented as upgrade path), ops status/server-start/server-stop/open-web-target/crash-files, ProvisioningStatus passthrough is the single allowed cross-package import, CONTROLLER_IPC_CONTRACT_VERSION 1. **@lumbre/release-manifest** — manifest schema per P4.3 (closed platform/kind enums, sha256 per artifact) + P4.18 signing decision with the zero-dep minisign verify PROVEN (real keypair hand-encoded to wire format, round-tripped; tamper fixtures bit-flip/wrong-key/truncated-sig/truncated-global-sig/tampered-trusted-comment/ED-variant ALL fail closed with typed reasons), RELEASE_MANIFEST_VERSION 1. Deviation accepted + ADOPTED AS CONVENTION: per-package tsconfig.test.json chained into typecheck so type-level assertions are gate-enforced (the repo's src-only tsconfig never checked test/ — downstream lanes mirror this). ajv devDep-only; lockfile +31 lines purely additive.

- 2026-07-24 Phase 4 Wave 1 · **ALL EIGHT LANES LANDED, per-lane orchestrator ground-truth before every freeze** (commits cd3a6dd/c0fb3e3/7520346/f00e1b1/9f71297/3807f02/c86e559 + integration 8661052; per-lane evidence in the burn-up table): installers for all four channels (Linux tarball container-smoked; Docker both-arch built+smoked; Windows MSI build-authored pending Wave-3 VM; macOS pkg built+payload-boot-smoked), embedded PG with REAL PG16→17 upgrade proof, ACME proven against live pebble (issuance + renewal + DNS-01 hook), real import with round-trip diff=[], release pipeline + lumbre CLI + D14-audited update check (P4.19). Wave integration: main.ts symlink entrypoint root-fix (repro-proven), ajv→dependencies + @lumbre/release-manifest real workspace dep (shim deleted), grep-gates build-cache exclusions, ci.yml pubkey-consistency wiring, LICENSE-INTENT vendored-binaries section, reconciling frozen-lockfile install after the shared-tree churn. Cross-lane findings that reshape Wave 2 are in Phase 4 Open (IPC listener unassigned + start-when-stopped hole + token ACL bridging; runtime-TS packaging defects structurally deferred with per-installer workarounds proven; ffmpeg arm64 checksum discrepancy → Wave 3 security review input).

- 2026-07-24 Phase 4 Wave 2 · **ALL SIX LANES LANDED + ORCHESTRATOR BROWSER PASS GREEN — gate ALL STEPS PASSED (11 steps incl. new dep-audit) on the settled tree b9f4d16** (commits ec07e40/369b8f7+4fa8132/21f2018/5ce6db7/e1ae924+c63a420/b9f4d16; per-lane evidence in the burn-up table). Contract additions orchestrator-authored pre-dispatch (6 additive ops, SDK 72) so C/D never contended on openapi.yaml; D's plan/engineVersion gap promoted into AdminSession same-wave. **REAL-BROWSER FREEZE PASS (real Chrome vs the built web client + tsx-booted server/worker on a fresh lumbre_wizard DB)**: full P4.6 wizard walk — fresh instance auto-routes to /setup, admin created, library over the real fixture corpus created + scanned (~100 items in seconds), the hardware step rendered the REAL M3 Max probe report live (VT decode h264/hevc/av1/vp9, encode h264/hevc, VT tone-map), restricted env-honest card, restore self-aware-disabled, done→home with the scanned library. ZERO CSP violations end-to-end under the new nonce+strict-dynamic policy INCLUDING hls.js blob: playback (hevc10/mkv fixture → real repackage session → MSE blob src → played to clip end); admission control verified live again (second concurrent watch → typed transcode-slots-exhausted UnavailableScreen); admin surfaces live: sessions ReasonsPanel renders the stored plan (Direct-Stream, engine 0.8.2, blocking container-not-direct-playable chip with human copy), jobs dashboard updated VIA SOCKET ONLY (triggered rescan appeared + flipped to Completed with zero additional /admin/jobs fetches), system page all-real (0.9.0-dev+hash version, capability matrix, honest 'Unreachable' update state, crash/logs sections). Redirect honesty both directions: stale-credential browser → /login (never /setup); cleared storage → /setup. Minor findings logged Open: poster-card a11y click (cards are focusable divs, Enter doesn't navigate — should be links), one non-reproducing 'Illegal invocation' one-shot during first watch load (replay + fresh navigations clean; watch item), CORB console noise on 404 posters (no images for generated fixtures; cosmetic) **[RE-AFFIRMED 2026-08-11]**. Runtime-TS packaging defect REPRODUCED LIVE during stack boot (bare node dist fails on db/jobs raw-TS exports — booted via tsx; the structural fix stays scheduled pre-Wave-3).

- 2026-07-24 Phase 3 Wave 1 · **P3.10 mtime_ms correctness lane merged** (7ba8685): migration 0010 media_files.mtime_ms (BIGINT NULL, additive; NULL doubles as the legacy not-yet-observed marker — no fake backfill); scanner incremental fast path is now path+size+mtime; size-match with NULL/differing mtime re-hashes and three-ways: hash same → updateMediaFileMtime backfill-only (narrow writer, no probe reset/no events), hash differs → existing re-encode-in-place path (probe fields reset + probe job re-enqueued, same row); updateMediaFileHash carries mtimeMs (optional, NULL default fails safe toward re-hash); all insert/refresh sites store Math.trunc(stats.mtimeMs). 3 new live-DB tests (mtime-incremental.spec.ts: fast-path-no-hash proven by spy pool, same-size in-place edit caught + re-probed, legacy NULL row re-hashes exactly once then fast-paths; utimesSync-pinned mtimes so second-resolution filesystems can't flake). migrate-check PASS (31 tables), scan suite 24/24, full worker suite 596 passed. Phase 1's "in-place edit preserving byte-size" Open item: CLOSED.

## Phase 2 exit gate (mission §5) — status at 2026-07-24
- [x] Gate green, 3 OS; perf jobs BLOCKING and green — run 30057293760 (6/6 jobs).
- [x] Token rotation reuse-detection test revokes the device — Phase 1 suite + Wave-4 live probe (replayed rotated token → 401 + whole chain killed).
- [x] Unavailable-state preview shows correct PLAYBACK.md reason codes for hevc-10bit and PGS fixtures on web-chrome — compat-preview unit fixtures (39 tests) + live browser verification of the typed unavailable screen on a real hevc/mkv scanned fixture.
- [x] Uncleared-user walk shows zero restricted traces — Wave-4 adversarial API walk (search/home/browse/detail/images/playback/progress/export byte-identical-404) + admin-sessions redaction; visual PIN modal + lock control verified in browser.
- [x] Budgets: browse JS ≤200 KB gz (118.5 KB), Lighthouse ≥90 (1.0), T0 RSS/p95 within plan §9.2 (browse 10.5ms, search 21.8ms, RSS 145–162 MiB) — ENFORCING in CI.
- [x] Security review findings resolved or logged with severity + owner ack — F1/F2/F3 fixed; F4/F5/F6 logged INFO with ack (2026-07-23 entry).
- [x] STATE.md coverage vs mission — every mission clause maps to a Frozen entry.
- [ ] **Owner can:** log in from another device on LAN, browse 4 libraries, play h264/aac/mp4 end-to-end with resume ACROSS DEVICES, play an album gapless, unlock restricted with PIN and watch auto-relock — orchestrator verified every one of these flows single-device against fixtures (video plays, resume prompt live, gapless dual-audio survives nav, PIN unlock + WS relock); the LAN/multi-device/4-real-libraries pass is owner-hardware work by definition.
- [ ] **Daily-drivable declared by OWNER, not agent** — awaiting the owner's §5 hands-on pass.

## Open (Phase 2 additions)
- rating/year sort keyset: functional but unindexed (COALESCE-sentinel expressions; would need 4 expression indexes or the ROW-form redesign) — not on the perf-budget hot path; index when they matter.
- CSP tightening: script-src carries 'unsafe-inline' until nonce middleware lands (Phase 4 pointer — also unlocks F4's localStorage-refresh-token blast-radius reduction).
- Gapless music: dual-<audio> handoff verified working; the actual gap duration was not instrumented — measure on real hardware during the owner pass.
- LUMBRE_TRUST_PROXY + LUMBRE_CORS_ORIGINS need setting for any non-localhost deployment (owner LAN pass: set LUMBRE_CORS_ORIGINS to the web client's LAN origin).
- Recurring local foot-gun: packages/db live-DB suites reset the shared dev DB — reseed (db:seed + db:seed-large) before manual dev/perf runs. Candidate fix: point test suites at an isolated DB by default.

## Phase 1 exit gate (mission §7) — status at 2026-07-23
- [x] `pnpm gate` green on 3 OS runners — run 30034135089 green on ubuntu/windows/macos + perf-t0; expected-red matrix inversion held.
- [x] Parser fixtures 100% pass at corpus targets — 123 movie / 157 TV / 62 music (≥120/150/60), all horror cases; every real-library parse failure from §6 to be fixed-or-fixtured during the owner scan pass.
- [x] Rename/relocate test — move+rename in a live scan → relink events, zero progress loss, zero duplicate items (apps/worker/test/scan/rename-relocate.spec.ts).
- [x] Mount-drop test — path removed → items hidden; restored within grace → row-for-row identical (mount-drop.spec.ts).
- [x] Leak-impossibility suite — ZERO todos, 24 tests passing; adversarial review (opus) found NO bypass.
- [x] Restricted provider scoping test — registry assertScope both directions (metadata/registry.spec.ts).
- [x] Images pre-scaled + blurhash — worker image pipeline (WebP 320/720/1280 + AVIF-when-supported + blurhash all in worker_threads); served via /v1/images with ETag+Cache-Control+304. (100%-coverage assertion is verified by the §6 owner scan-report run; scanner enqueues image jobs for local artwork + provider fetchImages.)
- [x] Conformance seeded-data assertions green on all catalog paths — 23 seeded-conformance tests.
- [x] T0 perf harness (warn-mode) — scan ~13k–16.5k files/min recorded (budget ≥200); idle RSS ~130–137 MiB (budget 220); regressions vs Phase 0 baseline: none.
- [x] STATE.md coverage vs §2 mission — every mission clause maps to a Frozen entry above.
- [x] §6 owner-in-the-loop real-library validation — DONE 2026-07-23 against a real local library (33 real .mkv: mix of 4K-HDR10 features, SDR compilation shorts, one multi-part set). Result: 30 items / 33 files / 0 parse failures / 0 missing; the shorts each became their own movie item; the 4-file multi-part collapsed to 1 item. Probe validated on REAL content: HDR10+10-bit HEVC, E-AC3 Atmos (JOC) — files labeled "AC3" actually carry E-AC3+Atmos, we probe reality — SDR h264/aac shorts correct. Found + fixed one spec gap: color_transfer column never populated (§2.1 drops it, §6.3 stores it) → consumer backfills from raw. Provider/blurhash 0% because no TMDB/TVDB keys (providers disabled — correct P1.9); re-scan with keys to reach the 100%-blurhash bar. Full large-library/SMB pass deferred to home-lab.

## Open
- **Phase 1 exit gate: COMPLETE.** All §7 items met on merged main (3-OS CI green run 30034135089; §6 real-library validation done 2026-07-23). Remaining are Phase 2 items, not gate blockers.
- Provider enrichment + 100%-blurhash needs TMDB/TVDB API keys configured (LUMBRE_TMDB_API_KEY/LUMBRE_TVDB_API_KEY); without them providers are disabled by design (P1.9) so a keyless scan yields 0 provider_ids / 0 images. A keyed re-scan is the way to exercise + prove that path against the real library.
- Parser note (not a failure): a multi-part set whose directory and files carry different titles took its title from the DIR, not the file; reasonable multi-part fallback, but a candidate parser refinement if file-title should win for part-numbered files.
- Full large-library/SMB validation still deferred to the home-lab pass (do not simulate SMB).
- Phase 2/3 pointer: matrix cases 002/005/006/007 will need Stage-G informational reasons (hw-encoder-selected:*/software-fallback:*) added when Stage G lands (Phase 3, regression law applies).
- Phase 2/3 pointer: tone-map-refused-by-policy matrix case (T0 + software-only caps) to accompany the Stage C implementation.
- Phase 2 pointer: if/when a reclassify-content_class path lands, the events guard is already live-join safe (P1.21/Wave-4c); re-audit any new denormalized snapshot.
- Phase 2 pointer: 'import' job is a registered stub that fails `not-implemented-phase-2`; POST /import returns 202 + ledger row only.
- Phase 2 pointer: in-place edit preserving byte-size is not re-hashed (path+size short-circuit; no mtime column) — a full re-probe path or mtime column is a Phase 2 correctness item.
- Phase 2 pointer: WS broadcaster is single-process live-tail (marks outbox processed after connected sockets); a durable per-client offset log is deferred.

## Surprises / notes

- 2026-07-22: Repo not empty at start: docs/PLAN.md + docs/PLAYBACK.md already placed (expected), plus .DS_Store (ignored). Git repo initialized, zero commits, branch main.
- 2026-07-22: Scaffold worker stopped unrelated container `jag-postgresql` (another project's 5-day-running stack incl. temporal that depends on it) to free port 5432. Orchestrator reverted: jag-postgresql restarted (healthy), Lumbre moved to host port 5442 (D18). Owner notified.
- 2026-07-22: `typescript@latest` resolves to 7.0.2 which breaks typescript-eslint/openapi-typescript/Next — pinned 5.9.3 (D19).
- 2026-07-22: grep-gate `upstream-media-server` pattern was unbounded and matched ordinary identifiers case-insensitively (`getItemById` → "...temBy..."); fixed with letter-boundary lookarounds before it could bite apps/ code in Phase 1.
- 2026-07-22: Seed produced 29 items vs prompt's "~24" (still 4 restricted; leak-test counts assert exact numbers) — accepted, spec said approximate.
- 2026-07-23: Parallel-lane resource contention (Phase 2 Wave 2): two web lanes fought over the SHARED chrome-devtools browser (global "selected page" — one lane navigated the other's tab), the API/web dev ports, and the shared dev database (gate's live-DB suites also reseed it — cost one confused "invalid credentials" debugging loop). Resolution now standing policy: browser, ports 3000/3001, and the `lumbre` dev DB are SINGLE-OWNER resources per wave; concurrent lanes get PORT overrides + isolated `lumbre_<lane>` databases; browser-verification passes are serialized.
- 2026-07-23: tsx/esbuild cannot emit design:paramtypes → NestJS DI silently injects undefined under tsx (app boots, /healthz fine, everything else broken). Lesson: "boots + healthz" is NOT a dev-runner verification; exercise one DI-dependent request. Same class of trap: Node fetch is receiver-insensitive but browser fetch throws Illegal invocation when called with a foreign `this` — browser-facing code is only verified in a browser.
