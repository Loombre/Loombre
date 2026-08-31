# Font provenance (U6 — self-hosted, zero runtime font CDN)

Both families are Google Fonts distributions of upstream SIL Open Font
License (OFL-1.1) projects. Fetched at authoring time (this Wave-0 lane),
not downloaded at build/install time — the files here are committed,
static assets. See `OFL.txt` next to each family's files for the full
license text.

## Archivo (variable)

- Upstream project: The Archivo Project (https://github.com/Omnibus-Type/Archivo)
- Distribution fetched from: `https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900&display=swap`
  (Google Fonts css2 API), file URLs resolved to `fonts.gstatic.com`
- Retrieved: 2026-07-25
- Axes: `wght 100..900`, `wdth 62..125` (BOTH axes in one variable file —
  the css2 endpoint only serves `wdth` when the request explicitly asks
  for it; verified present via fontTools' `fvar` table dump on the exact
  files below)
- Subsets kept: `latin`, `latin-ext` (README: "sufficient"). The
  `vietnamese` subset the API also served was dropped — unused.
- Style: normal only (no italics — Phosphor doesn't use them)
- Files:
  - `archivo/archivo-variable-latin.woff2`
  - `archivo/archivo-variable-latin-ext.woff2`
- License: `archivo/OFL.txt` (SIL OFL 1.1)

## IBM Plex Mono

- Upstream project: IBM Plex (https://github.com/IBM/plex)
- Distribution fetched from: `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap`
  (Google Fonts css2 API), file URLs resolved to `fonts.gstatic.com`
- Retrieved: 2026-07-25
- Weights: 400, 500, 600 (static — IBM Plex Mono is not distributed as a
  variable font). No italics (grepped the prototype bundle: zero italic
  usage anywhere).
- Subsets kept: `latin`, `latin-ext`. Dropped: `vietnamese`, `cyrillic`,
  `cyrillic-ext` — unused.
- Files:
  - `ibm-plex-mono/ibm-plex-mono-400-latin.woff2`
  - `ibm-plex-mono/ibm-plex-mono-400-latin-ext.woff2`
  - `ibm-plex-mono/ibm-plex-mono-500-latin.woff2`
  - `ibm-plex-mono/ibm-plex-mono-500-latin-ext.woff2`
  - `ibm-plex-mono/ibm-plex-mono-600-latin.woff2`
  - `ibm-plex-mono/ibm-plex-mono-600-latin-ext.woff2`
- License: `ibm-plex-mono/OFL.txt` (SIL OFL 1.1)

## Both fonts are AGPL-compatible per LICENSE-INTENT.md

SIL OFL-1.1 compatibility is manually verified and recorded in
`LICENSE-INTENT.md`'s Provenance ledger (the same posture as that file's
dovi_tool/ffmpeg entries) — it is NOT gate-checked:
`scripts/license-check.mjs` scans the npm dependency graph only, OFL-1.1
is not on its allow-list, and committed static font binaries are
structurally invisible to it. These files are static assets served
same-origin, never linked into any Loombre binary or package — see
`LICENSE-INTENT.md`'s Provenance ledger for the corresponding entries.

## The docs site carries a separate copy — not interchangeable

`docs/public/fonts/` holds a second vendored copy of the same two
families from a different pipeline (the loombre.com website workspace's
`site/tools/build-fonts.py`, copied verbatim) with a different
subsetting strategy: one unsplit subset per family/weight there, vs.
this directory's per-subset (`latin`/`latin-ext`) split files. Do not
swap files between the two sets — see `docs/public/fonts/README.md`.

## Wiring

`apps/web/src/styles/fonts.css` declares the `@font-face` rules consuming
these files; `apps/web/src/app/layout.tsx` preloads the primary faces
(Archivo latin + IBM Plex Mono 400 latin); `apps/web/src/lib/csp.ts`'s
`font-src 'self'` directive is what makes same-origin-only actually
enforced (no `fonts.googleapis.com`/`fonts.gstatic.com` allowance exists
anywhere in this repo as of this commit).
