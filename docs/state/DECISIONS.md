# DECISIONS.md — append-only decision ledger (docs/state tier, opened 2026-08-27)

Earlier decisions (LD-1–LD-13 and prior) live in the root STATE.md historical
ledger. This file starts with the v0.9.0-rc.6 QA pass and appends forward.

## 2026-08-27 — v0.9.0-rc.6 QA pass, locked decisions LD-14–LD-22

Cited in code/comments as "LD-n (rc.6)" — plain "LD-14" already names the
mono-scale contrast rule in this repo.

- LD-14 (rc.6) — Browse grid: explicit 2-up on phones. Below ~480px Browse
  switches to repeat(2, 1fr); deliberate divergence from Watchlist's denser
  132px auto-fill (do not harmonize). Rationale: kills the jumbo single poster
  at 380px.
- LD-15 (rc.6) — /reset validates on GET and renders /claim's invalid-token
  state via one shared component (no lookalike fork); minimal contract surface
  added; oasdiff must pass; no anti-enumeration additions (high-entropy tokens).
- LD-16 (rc.6) — Dashboard job mini-cards show exactly job name, status,
  relative time; absolute timestamps removed (not truncated tighter); full Jobs
  page untouched; no mid-word ellipsis at 1280px.
- LD-17 (rc.6) — PIN dialog free-text input becomes visually hidden but
  focusable (not display:none / visibility:hidden); inputmode numeric,
  autocomplete disabled, aria-label; focus ring on the dots container;
  hardware-keyboard entry keeps working.
- LD-18 (rc.6) — Item-detail file paths: one convention on both platforms —
  monospace, word-break: break-all, no clamp/ellipsis, copy button; filename
  tail always visible.
- LD-19 (rc.6) — Grid minimum guard: shared --grid-min-* tokens + one utility
  emitting minmax(min(var(--token), 100%), 1fr) + migration of minmax(Npx, 1fr)
  sites + stylelint rule flagging hand-written minmax( outside the utility.
  Refactor: pixel-identical at current breakpoints. Browse exempt below its
  LD-14 breakpoint.
- LD-20 (rc.6) — glass.css warning comment: sanctioned consumers (tab bar,
  now-playing bar), positional assumptions, the QuickSearch topbar-nesting
  failure mode. No code changes to .glass or its consumers.
- LD-21 (rc.6) — Mobile-override convention documented (mobile media blocks are
  complete axis resets, never partial overrides) + review-checklist entry. No
  refactors of existing mobile blocks this run.
- LD-22 (rc.6) — README mobile section gains a Player subsection;
  PlayerControls gets an explicit minimal mobile media block as the designated
  home for future mobile rules. Zero visual change is the acceptance criterion.

## 2026-08-27 — owner rulings at the Phase 0 hard stop (R1–R5)

- R1 — LD-14 blast radius: opt-in prop passed only by /browse; the three
  restricted-zone poster walls (ZoneBrowseGrid) are unchanged; their 2-up
  question goes to NOTED.md.
- R2 — LD-16 "exactly": compact card = job.type ("job name" — the contract has
  no name field) + StatusPill + relative time off updatedAtMs; live dot,
  progress, attempts chip, and lastError are dropped from the dashboard embed
  only (full Jobs page keeps all facts).
- R3 — LD-17 mobile branch: PinModal's @media display:none block is deleted —
  the input is visually-hidden-but-focusable at every width (zero visual
  change, strictly better a11y).
- R4 — LD-19 stragglers: MovieDetailScreen's minmax(240px, 1fr) is tokenized
  as --grid-min-detail-sidebar with the min() clamp shape (hand-written,
  rule-conformant; pixel-identical — that layout only exists ≥1024px where the
  clamp is inert); the styleguide 84px swatch grid migrates like every other
  site (--grid-min-swatch).
- R5 — State docs: docs/state/{STATE.md, DECISIONS.md, OPEN.md, archive/}
  created fresh for this run; root STATE.md untouched; NOTED.md at repo root.
