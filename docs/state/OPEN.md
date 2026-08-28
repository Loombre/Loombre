# OPEN.md — open items (docs/state tier, opened 2026-08-27)

Carry-forward: the pre-run open backlog lives in the root STATE.md historical
ledger (per-run "## Open" sections; the run-summary headings index them). It is
carried forward unchanged — items are resolved there only when a run actually
resolves them, and new cross-run items land here from now on.

## Open — v0.9.0-rc.6 QA remediation run (LD-14–LD-22)

- (none yet — populated at wave exit gates / run close)

## Watch items opened by Phase 0 discovery (candidates for future runs; full
detail in NOTED.md and archive/2026-08-27-qa-ld14-ld22-discovery/)

- Restricted-zone poster walls (ZoneBrowseGrid) still go 1-up jumbo below
  ~480px after LD-14 (rc.6) — Browse-only by owner ruling R1. Decide whether
  the 2-up treatment extends to them.
- Browse .page height uses desktop chrome math on mobile (browse/
  page.module.css:6) — grid scroll area extends under the fixed tab bar today.
- Poster skeletons hardcode 252px heights that are wrong-aspect on mobile
  today (VirtualPosterGrid.tsx:244, watchlist/page.tsx:132).
