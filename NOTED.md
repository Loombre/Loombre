# NOTED.md — out-of-scope observations (v0.9.0-rc.6 QA remediation run, LD-14–LD-22)

Standing rule: locked decisions are implemented as written. Anything a lane
believed should differ, plus everything Phase 0 discovered outside
LD-14–LD-22, lands here — never in code. Pointers reference the Phase 0
evidence in docs/state/archive/2026-08-27-qa-ld14-ld22-discovery/d1..d4.json.

## Mandated entries

- **Glass concept split (post-1.0).** Split ".glass" into sanctioned chrome
  surfaces (tab bar, now-playing bar) vs. a generic frosted utility. Today 10
  modules consume it, 8 outside the sanctioned pair, and three shell/player
  files document why they dropped it. LD-20 (rc.6) adds the warning comment
  only.
- **Mobile-first authoring refactor (post-1.0).** Existing mobile media blocks
  are partial overrides (MobileHeader/MobileTabBar display flips,
  MovieDetailScreen .mobileOnly/.desktopOnly, VersionCard .path). LD-21 (rc.6)
  documents the complete-axis-reset convention; refactoring the existing
  blocks is deferred.

## Phase 0 discoveries outside LD-14–LD-22

- **"LD-14" name collision.** Plain LD-14 already names the mono-scale
  contrast rule (tokens.css:81-92, ld14-mono-scale-conformance.test.ts). This
  run cites decisions as "LD-n (rc.6)".
- **Browse page height is desktop-only math on mobile.** browse/page.module.css:6
  subtracts desktop topbar/padding; below 767.98px real chrome is 112+60px, so
  the scroll area extends under the fixed tab bar. Same page, same breakpoint
  family as LD-14 (rc.6), not a grid-columns defect.
- **Poster skeletons render wrong aspect on mobile today.**
  VirtualPosterGrid.tsx:244 (168×1.5=252px assumption) and
  watchlist/page.tsx:132 (bare 252 literal) both assume 168px tracks.
- **Four near-duplicate poster-tile stylesheets kept in sync by hand.**
  PosterCell, WatchlistPosterCard, home/PosterCard, ZonePosterCard (headers
  document the duplication as deliberate). Real drift risk.
- **Design spec vs code poster minimums disagree.** design/phosphor/README.md:532
  says 148px (canvas uses 146/148/158); code ships 168px. LD-19 (rc.6) tokens
  derive from code per the decision text.
- **PIN dialog focus trap already defeats autoFocus.** SheetOrModal's
  useFocusTrap focuses the header Done button after commit
  (overlay-hooks.ts:62-63), so the input's autoFocus is likely dead today.
  LD-17 (rc.6) fixes focus-on-open because hardware-keyboard entry requires
  it once the field is invisible.
- **PIN field autofill caveat.** type="password" invites password managers;
  autoComplete="off" is widely ignored for password fields. LD-17 says
  "autocomplete disabled" — kept as-is; a stronger form
  (one-time-code/new-password) would be an interpretation.
- **Same absolute-timestamp-in-narrow-panel pattern next door to LD-16.**
  StreamsPanel.tsx:143 and EventLogPanel.tsx:29 (toLocaleTimeString) sit in
  the same dashboard columns; not named by LD-16 (rc.6).
- **Three divergent relative-time formatters.** LibrariesSection ("2h ago"),
  admin-capability-format ("3 hours ago"), notice-display ("(12 min ago)").
  LD-16 (rc.6) extracts the first into lib/; consolidating the rest is a
  cleanup for later.
- **Scrubber hover preview is a live instance of the QuickSearch glass bug.**
  Scrubber.module.css:94-105 .hoverPreview composes .glass inside
  PlayerControls' .bottomBar backdrop root (blur silently neutered). LD-20
  (rc.6) forbids code changes; describe-only.
- **Track picker not phone-adapted.** Chapters switch to a BottomSheet on
  phones; the audio/subtitle picker stays an anchored popover with no
  max-width (PlayerControls.tsx:264-277) — the recorded rationale for the
  chapters sheet applies equally.
- **Player controls below the 44px touch floor on phones; no safe-area
  insets.** .backButton/.iconButton 38×38; .topBar/.bottomBar lack
  env(safe-area-inset-*) unlike every other mobile surface. LD-22 (rc.6) is
  zero-visual-change and must not "fix" these.
- **phosphor-mobile-css.test.ts regex is brittle.** Greedy, EOF-anchored
  mobile-block capture passes only while the mobile block is last in each
  file; a copied LD-21 check would inherit the flaw
  (ld14-mono-scale-conformance.test.ts's brace-matching parser is the better
  skeleton).
- **Stale desktop Player facts in the README.** design/phosphor/README.md:552-554
  still says back-15/forward-30 and AIRPLAY/QUEUE chips; shipped code is ±10s
  and deliberately omits those chips. LD-22 (rc.6) adds the mobile subsection
  only.
- **ClaimScreen inconsistencies.** Two 404 predicates in one file (instanceof
  LoombreApiError on load, isApiProblem on submit) and two preset-presence
  predicate styles; pick one codebase-wide.
- **reverse-proxy.md "these four" prose already undercounts** the guard's
  actual public surface (8 entries) before LD-15 (rc.6) adds one more.
- **Naive minmax greps hit build artifacts.** apps/web/.next/static/css and
  installers/linux/.build/stage carry compiled copies; verification scripts
  must scope to apps/web/src.
- **Repo-root clutter.** console-full-session.log (2026-08-20),
  .playwright-mcp/ (3397 entries), .DS_Store at the repository root.
