# STATE.md — QA remediation run rc.6: LD-14–LD-22 (2026-08-27)

Three-tier state: this file is the live dashboard, rewritten each run, ≤150
lines; DECISIONS.md append-only; OPEN.md open items; archive/ completed-run
material. Root STATE.md is the pre-run historical ledger (untouched, R5).
NAMING: decisions cited as "LD-n (rc.6)" — plain "LD-14" is the mono-scale rule.
MODEL POLICY (this run): all sub-agents opus; final review by fresh opus agent.

## Status
- Phase 0 discovery: COMPLETE (wf_a22235ac-775; findings archived at
  archive/2026-08-27-qa-ld14-ld22-discovery/d1..d4.json). Owner go + rulings
  R1–R5: DECISIONS.md.
- Wave 1 (A: LD-14, B: LD-16, C: LD-15): COMPLETE — merged, gated, QA'd.
- Wave 2 (D: LD-17, E: LD-18): COMPLETE — merged + 3 integration fixes
  (f5f39ff phone-focus confinement per lane D's flagged hazard; 5b67eb8
  rAF focus deferral, live Chrome exposed a StrictMode remount that jsdom
  masked; ac1e39d srcExclude docs/state/** — gate step 17 choked on state
  markdown and Wave 1's build had leaked state/*.html into the local
  website merge, never deployed, scrubbed by re-sync at 70 routes).
  Gate re-run: ALL 17 STEPS PASSED. Exit-gate evidence below.
- Wave 3 (F: LD-19, G: LD-20+21, H: LD-22): COMPLETE — merged (G→H→F, README
  auto-merged), gate ALL 17 STEPS PASSED, pixel evidence below.
- Final review (fresh opus) + gate:full + run archive: IN FLIGHT.

## Lane dashboard
| Lane | LD (rc.6) | Status | Branch @ SHA | Merge |
|---|---|---|---|---|
| A | LD-14 Browse 2-up | DONE | rc6/lane-a-ld14 @ e6b48a0 | e28069b |
| B | LD-16 mini-cards | DONE | rc6/lane-b-ld16 @ 588d417 | 61c0a78 |
| C | LD-15 /reset GET | DONE | rc6/lane-c-ld15 @ d315f0d (3 commits) | 8bd92a1 |
| D | LD-17 PIN input | DONE | rc6/lane-d-ld17 @ 144bf61 (+f5f39ff,5b67eb8) | a9ce2b9 |
| E | LD-18 file paths | DONE | rc6/lane-e-ld18 @ ad796ee | 25f1e9d |
| F | LD-19 grid tokens | DONE | rc6/lane-f-ld19 @ a0157ee (2 commits) | 69d4b9e |
| G | LD-20+21 docs | DONE | rc6/lane-g-ld20-21 @ 4af54a0 | 8535ca0 |
| H | LD-22 player | DONE | rc6/lane-h-ld22 @ d1e77f6 | afac953 |

## Wave 1 exit-gate evidence (screenshots: archive/2026-08-27-qa-ld14-ld22-evidence/wave1/)
- Integration: 3 clean merges, zero conflict markers; `pnpm gate` on merged
  main: ALL STEPS PASSED (17/17; suites: web 232 files, server 261+3skip,
  db 47, worker 116+3skip, contract 5, playback-engine 12 — all green).
- Docs sync (reverse-proxy.md changed): docs:build PASS → website
  site/docs-dist replaced → website build PASS (73 routes, CSP intact).
  Deploy NOT performed (stays manual).
- LD-14: DOM-measured on /browse (Movies lib), live dev stack:
  380px→2 cols (x=0,182; w166) · 412px→2 (x=0,198; w182) · 479px→2
  (x=0,232; w216) · 480px→2 via the shared computeColumns math (clamp off;
  mechanisms converge at this width) · 700px→3 (auto-fill resumed).
  Watchlist 380px: 2×166px tracks — matches pre-run arithmetic exactly
  (d1.json columnCountAt380). Unit: VirtualPosterGrid 7/7 (red-first),
  grid-windowing 12/12 untouched. Screens: ld14-browse-380.png,
  ld14-watchlist-380-unchanged.png.
- LD-15: HTTP probe live-token 200 / garbage 404 with template instance
  "/auth/reset-password/{token}" (raw token never echoed). Browser:
  /reset/<garbage> → invalid state, NO password form
  (ld15-reset-invalid-1280.png); /reset/<live> → form → submit → success;
  same URL revisit → invalid (consumed). DB: password_changed_at_ms stamped
  2026-08-28T02:11:35Z, token used_at_ms set. Casual web login with the new
  password: OK (then admin session restored; casual password reset to its
  seed value, dev creds unchanged). oasdiff: "No breaking changes to
  report" exit 0. Suites: conformance 14/14, not-found-envelope 17/17 (incl
  probe-not-consumed case), db password-reset 16/16, web reset+claim 27/27
  (ClaimScreen.test.tsx unmodified).
- LD-16: live /admin at 1280×800, 10 mini-cards, real jobs
  (opengop-backfill, hwprobe): every card exactly "type | status |
  relative"; zero absolute dates, zero created/updated words, zero attempts
  strings, zero title-attr absolutes, zero overflowing elements
  (ellipsis structurally impossible: no overflow/text-overflow on
  .compactMetaItem). Full /admin/jobs: 14 rows all with absolute
  created/updated + attempts, no relatives; app/admin/jobs/page.tsx zero
  diff. Screen: ld16-admin-dashboard-1280.png. Suites: JobsPanel 10/10 (6
  pre-existing unmodified), relative-time 5/5, LibrariesSection 10/10.

## Wave 2 exit-gate evidence (screenshots: archive/.../wave2/)
- LD-17 (live Chrome 1280×800): input clip-path inset(50%) 1px, NOT
  display:none/visibility:hidden; inputmode numeric + autocomplete off +
  SR name "PIN" preserved; focus lands on the field on open (after 5b67eb8);
  hardware digits fill dots (live-region announces "2 of 4"); focus ring
  visible on dots (3px --shadow-focus-ring, pill radius) —
  ld17-pin-dialog-ring-2dots.png; mixed entry keypad"3"+key"4" →
  auto-submit → "Incorrect PIN." → dots reset → focus re-acquired. No
  visible text field. Phone widths: programmatic focus confined off
  (f5f39ff) — phone flow byte-identical pre-run. PinModal spec 12/12
  (red-first: 7 new cases red incl. empirical proof autoFocus was dead).
- LD-18 (161-char real path, Doctor Strange item): desktop + 380px both
  render the full path (4 wrapped lines at 380), tail visible, break-all,
  no ellipsis/clip/line-clamp, nothing clipped; copy button delivered the
  byte-exact 161-char string to the clipboard API and flipped to "Copied";
  non-secure-context fallback covered by unit tests (clipboard-undefined
  case). Screens: ld18-path-desktop-1280.png, ld18-path-mobile-380.png.
  VersionCard spec red-first; full apps/web suite 232 files / 2364 green;
  ld14-mono-scale-conformance untouched and green.

## Wave 3 exit-gate evidence (screens: archive/.../wave3/, 9 before/after pairs)
- LD-19: red-first at scale — commit 7488daa adds ONLY the stylelint rule;
  stylelint exits 2 with 14 errors across all 12 unmigrated files while the
  five minmax(0, Nfr) idiom sites stay silent; a0157ee migrates to 0 errors
  (that red run IS the planted-violation proof, both literal forms fired).
  Nine tokens landed (incl. R4 detail-sidebar 240); styles/grid.css recipes
  .auto-grid-fill/.auto-grid-fit (kebab — value-keyword-case rejects camel);
  no overrides block needed (var() fallback slot doesn't trip the pattern).
  Grep proof: zero literal-floor minmax declarations left in apps/web/src
  outside the utility + LD-14 exemption (3 remaining hits are comments).
  PIXEL PROOF (live dev, element screenshots): watchlist 380+1280,
  blazegrid 392+1440 IDENTICAL; healthcards 1024+1280 differ only in a
  10×15px ticking stat value (tracks byte-identical 239.5×4); systemgrid
  1024+1280 differ only by a live hwprobe banner line + probe-age tick in
  the capabilities card (crop pair archived; tracks byte-identical 491×2).
  Full web suite 232 files / 2371 green; production webpack build verified
  the composes source-order tie the 3 hand-written overrides depend on.
- LD-20+21: comments/markdown-only diff (glass.css header names the
  sanctioned pair + 3 positional assumptions + QuickSearch failure w/
  b07fe1a + Scrubber's live instance described; stale retention sentence
  corrected). README "Responsive strategy" gains the axis-reset convention
  (### subhead, matches file conventions); PR template gains box 9 of 9.
- LD-22: README Mobile "**Player.**" run-in landed (stale desktop facts not
  repeated); PlayerControls @media block byte-identical rule + designated-
  home marker as a sibling comment (existing rationale byte-preserved); new
  brace-aware player-controls-mobile-block.test.ts (red-first on the
  marker); the 3 pre-existing CSS-source tests untouched and green. ZERO
  visual change proven: player bar at 380 paused t=0 pixel-IDENTICAL
  before/after (332×166).

## Standing hazards
- Lanes: pnpm install, then `npx turbo run build --filter=@loombre/sdk
  --filter=@loombre/shared --filter=@loombre/playback-engine` (cold-worktree
  typecheck trap, hit by all Wave 1 lanes); Bash timeout 600000; never pipe
  gate/test exit codes; spec-file allowlists only; commit-msg hook rejects
  Claude-Session URLs; discovery archive present in worktrees cut ≥ 6f3605f.
- Server e2e derive loombre_test from DATABASE_URL
  (postgres://loombre:loombre@localhost:5442/loombre).
- Dev stack: running (pinned DATABASE_URL); stale prior stack was killed
  2026-08-27 (Next PID 63891 et al.) before relaunch.
- Wave-boundary browser QA is orchestrator-run in the primary checkout.
