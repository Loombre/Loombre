# STATE.md — QA remediation run rc.6: LD-14–LD-22 — CLOSED 2026-08-28

Three-tier state: this file is the live dashboard, rewritten each run, ≤150
lines; DECISIONS.md append-only; OPEN.md open items; archive/ completed-run
material. Root STATE.md is the frozen pre-run historical ledger.
NAMING: decisions cited as "LD-n (rc.6)" — plain "LD-14" is the mono-scale rule.

## RUN CLOSED — full record: archive/2026-08-27-qa-ld14-ld22.md
- Nine decisions implemented as written (owner rulings R1–R5, DECISIONS.md).
- Final review (fresh opus, evidence/final-review.json): approve-with-notes,
  9/9 conform (LD-17/19/22 with notes); NOTED-leak, dependency, egress and
  state-doc checks all pass; both blockers cleared in 82c8de8.
- gate:full 18/18 green at final HEAD 82c8de8 (and previously at
  80e26d3+budget); bundle 174.9 KB gz vs 200 KB budget.
- Website docs-sync current (70 routes, no state/*.html); deploy NOT
  performed — deliberate manual action, per standing rule.
- NOT pushed anywhere — everything is local commits on main.

## Lane ledger
| Lane | LD (rc.6) | Lane SHA(s) | Merge |
|---|---|---|---|
| A | LD-14 Browse 2-up | e6b48a0 | e28069b |
| B | LD-16 mini-cards | 588d417 | 61c0a78 |
| C | LD-15 /reset GET | 286bb1c d598071 d315f0d | 8bd92a1 |
| D | LD-17 PIN input | 144bf61 (+f5f39ff 5b67eb8) | a9ce2b9 |
| E | LD-18 file paths | ad796ee | 25f1e9d |
| F | LD-19 grid guard | 7488daa a0157ee | 69d4b9e |
| G | LD-20+21 docs | 4af54a0 | 8535ca0 |
| H | LD-22 player | d1e77f6 | afac953 |

Scaffolding/state commits: 6f3605f baeed1d cb6628b 80e26d3 82c8de8 (+ the
closing commit). Integration fixes: f5f39ff (phone-focus confinement,
lane-flagged hazard), 5b67eb8 (rAF focus deferral — live-Chrome StrictMode
finding), ac1e39d (srcExclude docs/state — gate-17 fix + website-leak scrub).

## Exit-gate evidence (pointers; full detail in the run archive + evidence/)
- LD-14: DOM columns 380/412/479→2, 480→2 (shared math), 700→3 (auto
  resumed); Watchlist 380 = 2×166px unchanged. wave1/ screens.
- LD-15: oasdiff clean; garbage→invalid-no-form; live→204→consumed; DB
  stamp + casual re-login; conformance 14/14, envelope 17/17 (probe
  non-consuming), db 16/16, web 27/27.
- LD-16: live 1280 = exactly type|status|relative ×10 cards, zero
  overflow/absolutes; /admin/jobs zero diff + byte-identical default path.
- LD-17: clip-path field (not display:none), ring on dots via :has(),
  hardware + mixed entry live-verified, focus re-acquired after reject;
  phone confinement covered by test (mutation-checked) in 82c8de8.
- LD-18: 161-char path fully visible desktop+380; byte-exact clipboard
  payload; non-secure-context fallback unit-covered.
- LD-19: rule-first red (14 errors/12 files, idiom silent) → migration →
  0; nine tokens; grep proof no literal floors remain; 9 screenshot pairs —
  5 identical, 4 live-data-only diffs; tracks byte-identical everywhere.
- LD-20/21: comments/markdown-only diffs (glass header, README convention,
  PR-template box 9).
- LD-22: README Player run-in; designated mobile block, rule byte-identical;
  player bar 380 pixel-IDENTICAL before/after; brace-aware source test.

## Standing operational notes (carried in memory + OPEN.md)
- gate:full flake cluster under parallel load — four shapes, all green in
  isolation; clean runs need dev stack stopped + TURBO_CONCURRENCY=2
  (OPEN.md has the CI-health follow-up).
- Server e2e derive loombre_test from DATABASE_URL
  (postgres://loombre:loombre@localhost:5442/loombre).
- Dev stack: STOPPED at run close; dev DB restored (casual password = seed
  value, watchlist empty, admin session intact). All lane worktrees removed.
