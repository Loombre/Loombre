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

## Lane observations (Waves 1–3, out of scope, implemented-as-written)

- **LD-14 (rc.6) has no lower guard.** "Exactly two columns at every width
  below the breakpoint" is implemented literally — at a hypothetical 280px
  viewport tracks are 116px, narrower than Watchlist's 132px floor. Flag if a
  1-column floor is ever wanted.
- **Browse's JS item width is still hand-synced.** VirtualPosterGrid.tsx
  DEFAULT_ITEM_WIDTH=168 mirrors --grid-min-poster by comment only (LD-19
  covered CSS); both sides now cross-reference each other.
- **479.98px is a second hand-synced breakpoint literal** (module CSS +
  PHONE_TWO_UP_QUERY), same weakness the 767.98px literal has across five
  files; nothing mechanical enforces the set.
- **Compact job cards freeze without socket traffic** — relative time is
  computed at render (repo convention); an idle queue shows "2h ago"
  indefinitely. A shared ticker hook would be a new decision.
- **Two relative-time registers now live in lib/** — relative-time.ts
  (compact "2h ago", Math.round) vs admin-capability-format.ts (verbose,
  pinned by tests). Do not let a consolidation sweep merge them.
- **PIN dialog:** ui/Input's TextInput declares no ref prop (React 19 makes
  a 2-line widening trivial — would remove PinModal's form-query helper);
  keypad Enter/Space now lands focus on the hidden field (tabbing users get
  pulled out of the keypad); :has() is apps/web's first use (support floor
  for this ring only); the hidden 1×44px box keeps .input's min-height
  (Toggle recipe doesn't neutralize it; invisible either way); the mobile
  soft-keyboard hazard lane D flagged was resolved at integration by
  confining programmatic focus to non-phone widths (f5f39ff) — owner can
  overrule.
- **LD-18 siblings still truncate:** LibrariesPanel's .unmatchedPath keeps
  its own ellipsis (admin surface, explicitly out of LD-18 scope);
  .path/.specs carry a 0.06em letter-spacing literal where siblings use
  var(--track-mono).
- **LD-19 guard is shape-based, not site-based** — any hand-written
  minmax(min(var(--…), 100%), 1fr) passes the stylelint pattern regardless
  of which var it names; the utility file needed no overrides exemption
  (the var() fallback slot doesn't trip the pattern). Recipe classes are
  kebab-case (.auto-grid-fill/.auto-grid-fit) — value-keyword-case rejects
  camelCase composes values.
- **Cascade dependency:** three hand-written non-floor overrides
  (skeletonGridTwoUp, HealthCards mobile repeat(2,1fr), ChoiceCard 1fr)
  beat the composed recipe on source order alone (same specificity);
  verified against a production webpack build + live dev; a chunk-order
  change is the failure mode to watch.
- **glass.css follow-ups:** Scrubber's .hoverPreview is the live
  neutered-blur instance (documented in the new header, not fixed — LD-20
  forbade it); SceneBanner's .backPill is the same nested-positioning shape,
  unverified; the header's stale retention sentence was corrected — the
  other two places asserting the two-surface reservation (README:66-69,
  tokens.css:221-226) read correctly today but drift the same way.
- **LD-21 has no mechanical enforcer** — the PR checkbox is the only gate;
  a CONTRIBUTING.md invariant bullet was deliberately NOT added (that
  section's pattern requires a mechanical check).
- **Player mobile gaps parked in the designated block's lap:** 38px touch
  targets below the 44px mobile floor, no safe-area-inset handling, track
  picker not phone-adapted (chapters sheet rationale applies equally). All
  excluded by LD-22's zero-visual-change criterion; the designated block is
  where the fixes belong.
- **phosphor-mobile-css.test.ts's greedy EOF-anchored regex** silently
  swallows anything appended after a mobile block in its five files
  (ld14-mono-scale-conformance's brace parser is the sound model; the new
  player-controls-mobile-block.test.ts used it).
- **jsdom masks StrictMode focus behavior.** Lane D's focus-on-open passed
  12/12 in jsdom but failed in live Chrome — dev StrictMode remounts a
  newly-mounted dialog subtree and re-runs its focus trap after the parent's
  dep-effect. Fixed with a one-frame deferral (5b67eb8); verify focus
  features in a real browser, not just jsdom.
- **React act() warnings are disabled repo-wide in web tests**
  (IS_REACT_ACT_ENVIRONMENT never set; no vitest setupFiles) — pre-existing
  stderr noise in every component suite.

## Final-review findings (approve-with-notes; blockers cleared in 82c8de8)

- **LD-15 probe shares the 5/min passwordReset bucket with the submit** —
  a viewer reloading /reset a few times can 429 their own POST. Reviewer
  judged the reuse the smaller deviation (the decision forbade new
  rate-limit behavior); revisit only if real users hit it.
- **Contract "shared with" prose under-lists the bucket's consumers**
  (openapi.yaml ~:320 and ~:362 name two of the now-three operations; the
  new GET's own description lists all three). Comment-only drift.
- **:has() is a single point of visibility for the PIN focus ring** — on an
  engine without :has() the ring never paints and the hidden field's inset
  ring paints nothing, so keyboard focus goes invisible on that dialog.
- **Stale PinModal comment survived** (~:199: "keypad is CSS-hidden above
  767.98px" — never true since H20; flagged pre-run, still uncorrected).
- **f5f39ff approximates "phone" by the 767.98px viewport literal** — a
  narrow desktop window also loses auto-focus (still strictly better than
  pre-run, where the field was display:none at those widths).
