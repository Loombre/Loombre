# docs/public/fonts — provenance

Subsetted webfonts copied verbatim from the loombre.com website workspace
(`site/public/fonts/`, generated there by `site/tools/build-fonts.py` from
the vendored OFL sources in `site/tools/font-sources/`). Both families are
SIL Open Font License 1.1 — the full license text, with both families'
copyright notices, ships beside them in this directory's `OFL.txt`
(these files are distributed: the docs build copies them into
`docs/.vitepress/dist/fonts/`, which is published to loombre.com):

- Archivo (variable, wght 100–900 / wdth 62–125) — © Omnibus-Type
- IBM Plex Mono (400/500/600) — © IBM Corp.

Note: `apps/web/public/fonts/` holds a **separate** vendored copy of the
same two families from a different pipeline (Google Fonts css2 API,
documented in that directory's `PROVENANCE.md`) with a different subset
split — per-subset `latin`/`latin-ext` files there vs. one unsplit
subset per family/weight here. The two sets are not interchangeable.

The subset covers printable ASCII + Latin-1 + the site's symbol set; any
glyph outside it falls back to the system stack per the font-family
declarations in `docs/.vitepress/theme/custom.css`. Self-hosted on purpose:
the docs build must never fetch from a font CDN (see the OFFLINE / NO-CDN
note in `docs/.vitepress/config.mts`).

To refresh: re-run the website repo's `npm run build:fonts` and re-copy.
