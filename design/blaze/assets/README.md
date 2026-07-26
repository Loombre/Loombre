# Loombre Brand Assets

The mark: **Blaze** — a three-tongue flame with the inner flame carved out
as negative space (shadow/light). Amber phosphor on near-black, from the
Phosphor UI design language.

## Palette
- Amber (primary): #FFB454
- Amber bright: #FFD9A0
- Amber deep: #E08F2E
- Background: #0B0C0F  ·  Tile: #101218  ·  Splash: #07080A
- Text: #E9EBEE  ·  Muted: #9BA0A8  ·  Subtle: #61666E

## Typography
- Wordmark: Archivo, weight 800, font-stretch 125%, letter-spacing .22–.24em, ALL CAPS
- Technical sublines: IBM Plex Mono 500, letter-spacing .12–.18em, ALL CAPS

## Variant usage
- loombre-mark.svg (gradient) — hero/splash moments
- loombre-mark-scanline.svg — inside the Phosphor UI on dark
- loombre-mark-flat.svg — small sizes, single-color, print
- The inner core is a true cut-out (fill-rule evenodd): the mark works on any background.

## Rules
- Minimum mark size 16 px; lockups minimum 120 px wide
- Clearspace around the mark: the width of the inner core
- Scanlines/gradient drop below 24 px — use flat
- Lockup SVGs embed a Google Fonts @import: they render correctly opened
  in a browser; design tools need Archivo + IBM Plex Mono installed.

## Motion (from the approved boot splash)
- Entrance: .9s cubic-bezier(.22,1,.36,1), rise + settle, bloom flash 1.4s
- Idle flame: shell "blaze" 1.05s ease-in-out infinite; core "flicker" .72s (out of phase)
- Loading: same flame at faster rates; indeterminate bar slides 1.6s
- See loombre-splash.html for a drop-in reference implementation.

## Files
svg/ — vector masters (mark ×3, favicon, lockups ×2, app icons ×2)
png/ — rendered: app icons + mark @1024, favicons 48/32/16, banner 1280×640, lockups @2x
loombre-splash.html — animated boot splash reference
