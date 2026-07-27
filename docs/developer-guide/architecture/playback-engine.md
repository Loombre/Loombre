# Architecture: Playback engine & matrix law

<!-- Sourcing: plan() signature — packages/playback-engine/src/plan.ts:218
     (`export function plan(input: PlanInput): PlaybackPlan`); PlanInput
     shape — packages/playback-engine/src/types.ts:247-262 (no clock
     field). Purity language — docs/PLAYBACK.md:14 ("calls no clock") and
     packages/playback-engine/src/args/builder.ts:5 ("no clock (docs/
     PLAYBACK.md §0 law 1)"). Reason taxonomy — packages/playback-engine/
     src/reasons.ts (closed BlockingReasonCode/FixedInformationalReasonCode
     unions), docs/PLAYBACK.md §4. Matrix — packages/playback-engine/matrix/
     (506 *.yaml case files, burnup.json manifest, matrix-meta.spec.ts,
     matrix.spec.ts, properties.spec.ts). See
     docs/developer-guide/matrix-authoring.md for the full regression-law
     writeup — not repeated in full here. -->

## A note on precision, up front

CLAUDE.md's invariant 2 describes `packages/playback-engine` as pure with
"clock is an argument." Reading the actual code and `docs/PLAYBACK.md`
directly (§0's purity law, and `plan()`'s own signature in
`packages/playback-engine/src/plan.ts`), the implementation is stricter
than that phrasing suggests: `plan()` doesn't take a clock argument at
all — its `PlanInput` type has no clock/time field anywhere. The engine
simply never reads wall-clock time, in any form, rather than reading it
through an injected argument. Both describe the same purity guarantee
(deterministic, no hidden I/O), just at different strictness — worth
knowing if you come looking for a `clock` parameter and don't find one.

## The pure decision function

```
        PlanInput                                     PlaybackPlan
   (media, device, network,          plan()          (decision + typed
    policy, caps, selection,   ───────────────►        reasons + a
    mode — no I/O, no clock)                            serializable plan)
```

`plan()` (`packages/playback-engine/src/plan.ts`) takes a complete,
already-resolved description of the media file, the requesting device's
capabilities, network conditions, server policy, and hardware capabilities
— and returns a decision plus the **reasons** for it. No filesystem
access, no database, no network call, no framework import anywhere in this
package (CLAUDE.md invariant 2) — everything the function needs arrives as
its input.

## Reasons are the contract

Every decision carries reason codes from a closed enum
(`packages/playback-engine/src/reasons.ts`, docs/PLAYBACK.md §4) — codes
like `video-codec-unsupported`, `hdr-tone-map-required`,
`bitrate-exceeds-network`, `transcode-disabled-by-policy`. Adding a new
reason code is a spec change to docs/PLAYBACK.md §4 first, an
implementation second — never an ad hoc string invented inline. This is
what makes a playback decision diagnosable rather than a black box: the
[Capability report](../../admin-guide/capability-report.md) and job records
surface these same reason codes back to an admin trying to understand why
a particular file played the way it did.

## The matrix

`packages/playback-engine/matrix/` holds 506 individual YAML test cases
(docs/PLAYBACK.md §10's Phase 3 exit bar was "≥ 500"), each citing the
spec section it proves. Two specs enforce the regression law described in
full in [Authoring a matrix case](../matrix-authoring.md):
`matrix-meta.spec.ts` keeps the case count and filenames in sync with the
`burnup.json` manifest, and `matrix.spec.ts` re-runs every case through
the real `plan()` and checks the output against what `burnup.json` records
as correct — so a decision-logic change that flips a case's outcome is
caught immediately, not discovered later. `pnpm test:matrix` runs this
suite directly; CI also runs it as its own "playback matrix burn-up" step.

## Admission control is process-local

The transcode admission gate (`docs/PLAYBACK.md`:379's
`maxSimultaneousTranscodes` semaphore) — `TranscodeAdmissionGate` in
`apps/server/src/playback/transcode-admission.ts` — is a process-local
promise-chain mutex, not a `plan()` concern. Correct for v1's
single-process-per-instance topology
(compose prod, the bundled installers); running the server multi-process
against one shared database would let each process admit up to the cap
independently, over-admitting. Scaling past one process requires
converting it to a Postgres advisory lock — a
`pg_advisory_xact_lock`-guarded count+insert in `packages/db`, per the
module's own header and CLAUDE.md invariant 4. No code change here; this
is the map for whoever scales it later.
