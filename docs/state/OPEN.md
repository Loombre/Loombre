# OPEN.md — open items (docs/state tier, opened 2026-08-27)

Carry-forward: the pre-run open backlog lives in the root STATE.md historical
ledger (per-run "## Open" sections; the run-summary headings index them). It is
carried forward unchanged — items are resolved there only when a run actually
resolves them, and new cross-run items land here from now on.

## Open — v0.9.0-rc.6 QA remediation run (LD-14–LD-22, closed 2026-08-28)

- gate:full flake cluster under parallel load (2026-08-27/28, four one-off
  local suite failures, each green in isolation; see the run archive's
  Gates section): db migrate-reset-guard afterAll DROP timeout, worker VT
  encoder contention with a live dev worker, db library-provider-chains
  unique-key collision, server playback-hls 401. All contention shapes on
  the single compose Postgres / real hardware encoder. Mitigation that
  produced clean runs: dev stack stopped + TURBO_CONCURRENCY=2. Still worth
  considering per-worker database isolation for the db suites.
- CI-health follow-up RESOLVED to a remainder (2026-08-28): main's CI was
  red since 2026-08-12 — the depcruise no-orphans false positive on the CLI
  bin entrypoint blocked every test step (fixed 012e396), which had hidden
  the seek-dedup TIME_SCALE bug in specs that never ran on CI (fixed
  21f9c8a, red→green at scales 1/3/10). Main is GREEN again as of run
  33142480607. Remainders: (a) remote-tunnel.e2e "EVERY real transition"
  pin flaked once on a slow runner (an extra legitimate
  starting→degraded→starting cycle before running; green on rerun) — the
  remote workstream should widen the pin to tolerate repeated degraded
  cycles; (b) the NON-BLOCKING node-current 26 evidence job fails with
  "TypeError: Cannot read properties of undefined (reading 'clear')" —
  N2-policy evidence against adopting the Current line, accumulate before
  Node 26 reaches LTS.
- LD-15 probe and submit share the 5/min per-IP passwordReset bucket — a
  self-429 on rapid /reset reloads is possible; revisit if reported.

## Watch items opened by Phase 0 discovery (candidates for future runs; full
detail in NOTED.md and archive/2026-08-27-qa-ld14-ld22-discovery/)

- Restricted-zone poster walls (ZoneBrowseGrid) still go 1-up jumbo below
  ~480px after LD-14 (rc.6) — Browse-only by owner ruling R1. Decide whether
  the 2-up treatment extends to them.
- Browse .page height uses desktop chrome math on mobile (browse/
  page.module.css:6) — grid scroll area extends under the fixed tab bar today.
- Poster skeletons hardcode 252px heights that are wrong-aspect on mobile
  today (VirtualPosterGrid.tsx:244, watchlist/page.tsx:132).
