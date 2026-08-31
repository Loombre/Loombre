# Authoring a matrix case

<!-- Sourcing: matrix case files as individual YAML files in
     packages/playback-engine/matrix/*.yaml (one per case, matching
     matrix/burnup.json's entry count — the manifest and the files on
     disk are the live count; no frozen total is quoted here on purpose);
     case shape (name, why, input, expect) from an existing case file
     (matrix/013-mp4-direct-play-hevc-sdr-main10.yaml); matrix-meta.spec.ts
     (case-count === burnup.json total, on-disk filenames === manifest
     entries, no unlisted/phantom entries); matrix.spec.ts (re-asserts each
     case's actual plan() output against burnup.json's recorded status —
     the regression law); docs/PLAYBACK.md §10 ("Phase 3 exit >= 500
     cases" — floor long since exceeded); CI step
     "playback matrix burn-up" (.github/workflows/ci.yml) running
     `pnpm test:matrix`. -->

CLAUDE.md invariant 2: **every decision rule in `packages/playback-engine`
lands with matrix cases in the same PR.** This page is what that means in
practice.

## What the matrix is

`packages/playback-engine/matrix/` holds one YAML file per test case —
well past the 500 that docs/PLAYBACK.md §10 sets as the Phase 3 exit bar
(`burnup.json` and the files on disk are the live count; this page quotes
no frozen number, because the matrix only grows) — plus a manifest file,
`burnup.json`, that records every case's name and current status.

A case looks like this (trimmed from
`matrix/013-mp4-direct-play-hevc-sdr-main10.yaml`):

```yaml
name: direct-play — mp4 hevc main10@123 10-bit 2160p + aac 6ch, hevc-sdr (SDR source, no HDR involved)
why: "Stage A (docs/PLAYBACK.md §3): mp4 IS in hevc-sdr's directPlayContainers, and every SELECTED stream is copy-eligible under Stages B-F's current permissive stubs, so the decision is direct-play with reasons=[]. …"
input:
  media: { ... }
  device: { ... }
  network: { ... }
  policy: { ... }
  caps: { ... }
  selection: { ... }
  mode: { ... }
expect:
  decision: ...
  reasons: [ ... ]
```

Every case's `why` field cites the spec section it's proving — a matrix
case is a claim about `docs/PLAYBACK.md`'s decision algorithm, not just an
arbitrary input/output pair.

## The regression law

Two mechanisms enforce this, both running as part of the normal test
suite:

1. **`matrix-meta.spec.ts`** asserts the case count matches `burnup.json`'s
   total, and that the set of on-disk case files exactly equals the set of
   filenames `burnup.json` lists — no case can be silently added without a
   manifest entry, and no manifest entry can point at a file that doesn't
   exist.
2. **`matrix.spec.ts`** re-runs every case's actual input through `plan()`
   and checks the real output against `burnup.json`'s *recorded* status for
   that case. This is the regression law in force: if you change decision
   logic and a case's outcome flips from what `burnup.json` says it should
   be, this fails — you cannot "green" a case's behavior without updating
   `burnup.json` to say so, in the same PR, which is exactly the point.
   This spec runs via `pnpm test:matrix` (a separate Vitest project from
   the default `test` run), and CI runs it explicitly as its own
   "playback matrix burn-up" step.

## Adding a new decision rule + case

1. Write the stage logic in `packages/playback-engine/src/stages/*.ts` (or
   `src/plan.ts` for top-level orchestration changes).
2. Add a new case file: `matrix/NNN-short-description.yaml`, following the
   `name` / `why` / `input` / `expect` shape above. Pick the next unused
   number.
3. Update `matrix/burnup.json` in the **same PR** to include the new case
   with its correct status — `matrix-meta.spec.ts` fails otherwise.
4. Run `pnpm test:matrix` locally before opening the PR — it's the same
   check CI runs as its dedicated step, so there's no reason to find out
   about a mismatch only after pushing.

## Reason codes

Every decision carries one or more reason codes from a **closed enum**
(docs/PLAYBACK.md §4, "Reason taxonomy") — adding a new reason code is a
contract-level change to that spec section, not something to invent inline
in a case file. If your new rule needs a reason code that doesn't exist
yet, that's a spec change first, matrix case second.
