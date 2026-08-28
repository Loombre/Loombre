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
- Wave 1 (A: LD-14, B: LD-16, C: LD-15): COMPLETE — merged, gated, QA'd
  (exit-gate evidence below).
- Wave 2 (D: LD-17, E: LD-18): IN FLIGHT — parallel opus worktree lanes.
- Wave 3 (F: LD-19, G: LD-20+21, H: LD-22): queued; F after all grid work
  merged; G/H both edit design/phosphor/README.md — integrate sequentially.
- Final review + gate:full + run archive: pending.

## Lane dashboard
| Lane | LD (rc.6) | Status | Branch @ SHA | Merge |
|---|---|---|---|---|
| A | LD-14 Browse 2-up | DONE | rc6/lane-a-ld14 @ e6b48a0 | e28069b |
| B | LD-16 mini-cards | DONE | rc6/lane-b-ld16 @ 588d417 | 61c0a78 |
| C | LD-15 /reset GET | DONE | rc6/lane-c-ld15 @ d315f0d (3 commits) | 8bd92a1 |
| D | LD-17 PIN input | in flight | — | — |
| E | LD-18 file paths | in flight | — | — |
| F | LD-19 grid tokens | queued | — | — |
| G | LD-20+21 docs | queued | — | — |
| H | LD-22 player | queued | — | — |

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

## Load-bearing pointers for remaining waves (full detail in d3/d4.json)
- LD-17: Toggle.module.css:14-26 recipe; ring via :has() on .form → .dots
  (dots precede input; inset ring on 1×1 paints nothing). PinModal.test.tsx
  pins: aria-label "PIN", input.hiddenInput compound selector, no
  border-radius in .hiddenInput block, no literal <input, and a
  no-`.hiddenInput:focus-visible`-selector assertion the :has() rule may
  collide with — lane must read the exact regex first. In scope: focus
  input on open (trap lands on Done today) + refocus after keypad presses.
  R3: mobile display:none block deleted.
- LD-18: VersionCard.tsx:78 sole render (mounted twice: desktop+mobile
  trees); CommandBlock.tsx three-state copy pattern incl non-secure-context
  fallback; mobile .path override collapses into the unified base rule.
- LD-19 tokens: poster 168 / poster-compact 132 / avatar 112 /
  avatar-compact 88 / card 200 / card-compact 180 / panel 480 / swatch 84 /
  detail-sidebar 240 (R4). Utility = styles/grid.css, glass.css pattern,
  custom-property parameter, fill+fit variants, consumers keep gap.
  Stylelint declaration-property-value-disallowed-list + first overrides
  block; permit minmax(0, Nfr) idiom (5 sites). Browse skeleton uses
  utility above 479.98px only (LD-14 block below).
- LD-20: evidence = QuickSearch.module.css:11-18 + commit b07fe1a;
  sanctioned pair MobileTabBar + MiniPlayerBar; 8 other consumers listed in
  d4.json.
- LD-21: design/phosphor/README.md "Responsive strategy" (design/ = no docs
  sync) + .github/PULL_REQUEST_TEMPLATE.md 9th box.
- LD-22: README Mobile section, bolded "**Player.**" run-in at ~line 644;
  PlayerControls.module.css existing @media :213-217 becomes the designated
  mobile home; three CSS-source-reading tests over that file (indented
  in-media rules safe); zero visual change at phone width.

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
