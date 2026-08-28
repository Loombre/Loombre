# STATE.md — QA remediation run rc.6: LD-14–LD-22 (2026-08-27)

Three-tier state (this run forward): this file is the live dashboard, rewritten
each run, ≤150 lines; DECISIONS.md is append-only; OPEN.md carries open items;
archive/ holds completed-run summaries. Root STATE.md is the pre-run historical
ledger — untouched this run (owner ruling R5).

NAMING: this run's decisions are cited in code/comments as "LD-n (rc.6)" —
plain "LD-14" already means the mono-scale contrast rule (apps/web/src/styles/
tokens.css:81-92, ld14-mono-scale-conformance.test.ts).

MODEL POLICY (this run only): all sub-agents opus-tier; final review by a fresh
opus agent that implemented no lane.

## Status
- Phase 0 discovery: COMPLETE. Workflow wf_a22235ac-775, 4 read-only opus
  lanes, 0 errors. Full findings archived:
  archive/2026-08-27-qa-ld14-ld22-discovery/d1..d4.json.
- Owner go: 2026-08-27, all five recommendations accepted (rulings R1–R5 in
  DECISIONS.md).
- Wave 1 (A: LD-14, B: LD-16, C: LD-15): IN FLIGHT — parallel opus worktree
  lanes. C closes only on oasdiff pass.
- Wave 2 (D: LD-17, E: LD-18): pending Wave 1 exit gate.
- Wave 3 (F: LD-19, G: LD-20+21, H: LD-22): pending Wave 2 exit gate; F runs
  only after all grid-touching work is merged; G/H both edit
  design/phosphor/README.md (disjoint sections) — integrate sequentially.
- Final review: pending.

## Lane dashboard (evidence = pointers; filled at exit gates)
| Lane | LD (rc.6) | Status | Branch | SHA | Evidence |
|---|---|---|---|---|---|
| A | LD-14 Browse 2-up | in flight | — | — | — |
| B | LD-16 mini-cards | in flight | — | — | — |
| C | LD-15 /reset GET | in flight | — | — | — |
| D | LD-17 PIN input | queued | — | — | — |
| E | LD-18 file paths | queued | — | — | — |
| F | LD-19 grid tokens | queued | — | — | — |
| G | LD-20+21 docs | queued | — | — | — |
| H | LD-22 player | queued | — | — | — |

## Load-bearing discovery pointers (full detail in archived d1–d4.json)
- Browse grid is JS-virtualized, not CSS: columns from computeColumns
  (apps/web/src/lib/grid-windowing.ts:38-42) via VirtualPosterGrid.tsx:143-148;
  only CSS grid is the skeleton (VirtualPosterGrid.module.css:30-36). Shared
  with 3 restricted-zone walls via ZoneBrowseGrid — LD-14 rides an opt-in prop
  passed only by app/browse/page.tsx (R1).
- No claim invalid-state component exists — inline JSX (ClaimScreen.tsx:172-184)
  plus an existing hand-copied fork in ResetPasswordScreen.tsx:72-84. LD-15
  extracts components/auth/InvalidLinkScreen.tsx; both screens consume it.
- LD-15 contract change confirmed needed (no GET twin, no db read-only
  primitive; the only reset-token check is the consuming CAS,
  packages/db/src/query/password-reset.ts:162-169). New additive
  GET /auth/reset-password/{token} (getPasswordResetState) + empty
  PasswordResetState schema; five gate-enforced registries + reverse-proxy doc
  ride along (d2.json contractChangeRationale items A–G).
- JobsPanel/JobRow is shared with the full /admin/jobs page — LD-16 rides an
  opt-in `compact` prop only the dashboard embed passes; provable "untouched" =
  zero diff on app/admin/jobs/page.tsx AND default render path byte-identical.
- Relative-time: extract formatRelativeTime (LibrariesSection.tsx:74-83, the
  only "2h ago"-vocabulary formatter) into apps/web/src/lib/relative-time.ts.
- LD-17: visually-hidden recipe precedent Toggle.module.css:14-26; ring
  transfers to dots via :has() (dots precede the input; inset ring on 1×1
  paints nothing). Focus hazards in scope: focus input on open (trap lands on
  Done today), return focus after keypad presses. R3: mobile display:none
  block (PinModal.module.css:131-135) deleted.
- LD-18: sole item-detail path render is VersionCard.tsx:78; copy button
  follows CommandBlock.tsx three-state pattern (incl. non-secure-context
  fallback). VersionCard renders twice (desktop+mobile trees).
- LD-19 tokens (from 17-site minmax inventory, d1.json): --grid-min-poster 168,
  --grid-min-poster-compact 132, --grid-min-avatar 112,
  --grid-min-avatar-compact 88, --grid-min-card 200, --grid-min-card-compact
  180, --grid-min-panel 480, --grid-min-swatch 84, and (R4)
  --grid-min-detail-sidebar 240 (hand-written min() clamp shape,
  MovieDetailScreen:102). Utility: new styles/grid.css (glass.css pattern,
  composes from global, custom-property parameter; auto-fill/auto-fit fork =
  two classes; utility owns display+columns only, consumers keep gap).
  Stylelint: declaration-property-value-disallowed-list + first `overrides`
  block exempting styles/grid.css; pattern permits the five minmax(0, Nfr)
  idiom sites. No plugin, no new deps.
- LD-20 evidence: QuickSearch failure = workaround comment
  QuickSearch.module.css:11-18 + commit b07fe1a. Sanctioned pair =
  MobileTabBar + MiniPlayerBar; 8 other live consumers.
- LD-21 homes: design/phosphor/README.md "Responsive strategy" (design/ is
  outside docs/ — no docs-sync) + .github/PULL_REQUEST_TEMPLATE.md 9th box.
- LD-22: Player paragraph at design/phosphor/README.md line ~644 (bolded
  run-in, matching the desktop entry at :552); PlayerControls.module.css
  existing @media (213-217) becomes the designated mobile home. Three
  CSS-source-reading tests over that file; indented in-media rules are safe.

## Standing hazards for this run
- Lanes: pnpm install first in worktrees; Bash timeout 600000 on tests/gates;
  never pipe a gate's exit code; spec-file allowlists only (no bare vitest
  run); commit-msg hook rejects Claude-Session URLs.
- Server e2e specs derive loombre_test from DATABASE_URL
  (postgres://loombre:loombre@localhost:5442/loombre — compose DB).
- Docs sync (reverse-proxy.md, lane C) is performed by the orchestrator in the
  primary checkout post-integration, same session, per CLAUDE.md.
- Exit-gate browser evidence gathered at wave boundaries in the primary
  checkout (one dev stack, DATABASE_URL pinned), not inside lanes.
