# Playback matrix

Table-driven case runner for `plan()` (docs/PLAYBACK.md §10), plus a
property-test harness and a burn-up manifest (docs/PLAYBACK.md §11 step 1).
One case per `NNN-*.yaml` file. The ≥500-case Phase 3 exit target
(docs/PLAYBACK.md §10) is long since met; no total is quoted here, because
the matrix only grows — `burnup.json` is the single source of truth for
the count, and `matrix-meta.spec.ts` enforces that it matches the files on
disk. Each case's own `why:` field records what it landed to prove; git
history carries the stage-by-stage accretion.

## Case-authoring rule: future-proof construction (Phase 3 Step 2a+)

Stages land one at a time (docs/PLAYBACK.md §11 step 2), and the matrix
burn-up manifest (`burnup.json`) only ever moves cases from red to green as
their governing stage's real implementation lands — it must never flip a
case green and then have it silently regress when a LATER stage's PR lands.
To guarantee that: **every new case's SELECTED streams (video, audio,
subtitle) must be constructed genuinely within the paired device's declared
capabilities on EVERY axis** — codec, profile/level (either both null, or a
concrete value at or under the device's declared max), bitDepth, resolution,
frameRate, audio codec + channels, HDR kind (`'none'` unless the device's
matching HDR flag is true), no bitstream-passthrough-only codecs
(`truehd`/`dtshd`) unless the device's entry declares `passthrough: true`, no
interlacing, and no subtitle selected unless the case is deliberately
exercising a "subtitle present but unselected" edge case — UNLESS the case's
`why:` deliberately documents an intentional exception (e.g. the Phase-0
seed cases, which exist specifically to trigger a later stage's reason and
so intentionally place a stream OUTSIDE device caps on some axis). A case
built this way keeps its `expect` block correct once Stages B-F replace
their current permissive stubs with real per-axis logic — the whole point
of the rule is that a case's genuinely-caps-respecting streams will still
verdict `copy`/`none` at every real stage, exactly as they do under today's
stubs, so nothing in `burnup.json` needs to move backward. Every case added
under this rule states it implicitly by construction; this paragraph is the
one place that states the rule itself.

## Layout

- `NNN-*.yaml` — one case per file. Schema: `{name, why, input: {media,
  device, network, policy, caps, selection, mode}, expect: {decision,
  reasons, subtitleStrategy?, container?, ladderMaxVideoBitrateBps?}}`.
  `expect.container` (Phase 3 Step 2b addition, closing the Step 2a
  case-schema gap) is an optional §5 `PlaybackPlan.container` assertion
  (`'source'|'fmp4-hls'|'ts-hls'|'mp4'`) — used by a handful of cases only;
  most cases omit it and assert on `decision`/`reasons` alone.
- `fixtures/*.yaml` — shared device/policy/caps/network fixtures. Reference
  one from a case with `{ fixture: "<file>.<key>" }`, e.g.
  `device: { fixture: devices.web-chrome }`. Resolution is intentionally
  dead simple (`matrix/lib/load-cases.ts`): an exact single-key `fixture`
  node is replaced with that fixture's value, recursively — no merging, no
  overrides. `fixtures/caps.yaml` carries the STATE.md P3.3 named
  VerifiedCapabilities sets (`software-only`, `full-hw`, `encode-only`,
  `macos-vt`) used both by case files and by the property-test generators.
- `burnup.json` — the single source of truth for every case file's CURRENT
  status: `"green"` (plan() must implement it correctly) or `"red"` (plan()
  is still expected to throw `NotImplementedError`). Greening a case (or a
  green case regressing) requires editing this file in the same PR — see
  "Regression law" below.
- `matrix.spec.ts` — the burn-up runner (`pnpm --filter
  @loombre/playback-engine run test:matrix`, or root `pnpm test:matrix`).
  For every case, calls `plan()` and tolerates exactly two outcomes: it
  throws `NotImplementedError` (actual status "red"), or it returns a plan
  matching the case's `expect` block exactly (actual status "green"). Any
  other outcome — wrong decision, wrong reasons, or a throw that isn't
  `NotImplementedError` — is a hard failure regardless of `burnup.json`.
  Each case's actual status is then asserted against its manifest entry.
  Prints a one-line summary (`matrix burn-up: N green / M red / T total`)
  from `afterAll`. Excluded from the default `test` project
  (`vitest.config.ts`) so `pnpm gate` stays green; runs only via
  `vitest.matrix.config.ts`.
- `properties.spec.ts` — the docs/PLAYBACK.md §10 property-test harness
  (determinism, direct-play bias, totality, reason completeness) against a
  seeded PRNG (`matrix/lib/prng.ts`, mulberry32 — never unseeded
  `Math.random`) generating random valid `PlanInput`s across the full §2
  type space (`matrix/lib/generators.ts`). Gated on `burnup.json`: while 0
  cases are green, each property instead asserts `plan()` throws
  `NotImplementedError` on its generated inputs ("harness-proves-wiring"
  mode); once >=1 case greens, the real property assertions run. Also part
  of `pnpm test:matrix`, not the gate.
- `matrix-meta.spec.ts` — green today, included in the default `test`
  project (`pnpm gate`). Asserts `burnup.json` is in sync with the case
  files on disk, every case validates against the case schema (decision
  enum, reason codes drawn from the closed docs/PLAYBACK.md §4 enum), every
  input is structurally sane, the caps.yaml fixture sets validate against
  the §2.5 shape, and the "plan() throws NotImplementedError" assertion
  (STATE.md D22) — now conditional on `burnup.json` having 0 green cases,
  so it retires itself automatically the day the first case greens
  (STATE.md P3.9d).
- `lib/` — `load-cases.ts` (case/fixture loader), `burnup.ts` (manifest
  loader), `caps-fixtures.ts` (VerifiedCapabilities fixture loader shared by
  cases and generators), `prng.ts` (mulberry32 + sampling helpers),
  `generators.ts` (random-valid-input and direct-play-bias generators),
  `validate-plan.ts` (structural `PlaybackPlan` validator for the totality
  property).

## Regression law

Any PR that flips an existing case's decision or reasons must edit that
case's `why:` comment AND its `burnup.json` entry in the same PR
(docs/PLAYBACK.md §10, STATE.md P3.2). `matrix.spec.ts` enforces this
mechanically: a case's actual status (green/red) must match its manifest
entry, or the suite fails.
