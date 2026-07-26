# Handoff: Loombre "Phosphor" — desktop + mobile web client

## Overview

Phosphor is a hi-fi visual and interaction direction for the Loombre self-hosted media
server web client. It covers the full authenticated surface — library browsing, playback,
music, search, admin dashboard, the schema-driven settings registry, plugins/metadata
providers, restricted-profile locking, and account management — in **two layouts**: a
desktop sidebar app and a mobile-Safari phone experience.

Target codebase: **`Loombre/Loombre`**, `apps/web` (Next.js 15.5 / React 19 / TypeScript,
CSS Modules + `tokens.css` custom properties, `lucide-react` icons, no Tailwind).

---

## About the design files

The files in this bundle are **design references authored in HTML** — prototypes that show
intended look, layout, and behavior. They are **not production code to copy**. The task is
to recreate these designs inside `apps/web` using its established patterns: CSS Modules
that reference `src/styles/tokens.css`, the `.glass` recipe in `src/styles/glass.css`, the
`Icon` wrapper in `src/components/icon/Icon.tsx`, `apiGet`/`api-client.ts` for data, and the
existing `AppShell` for chrome.

Two hard constraints in that codebase you must respect:

- **stylelint forbids literal border-radius values** outside `tokens.css`
  (`declaration-property-value-allowed-list`). Every radius in this document must be mapped
  to `--radius-pill | -lg | -md | -sm | -full`, or a new token added to `tokens.css`.
- `pnpm lint` runs `eslint src --max-warnings=0 && stylelint "src/**/*.css"`, and
  `pnpm typecheck` runs `tsc --noEmit`. Both must pass.

---

## Decisions made — these are settled, do not re-litigate

**1. Adopt Phosphor wholesale as the app theme.** Retheme `src/styles/tokens.css`, replace
the icon-only `NavRail` with the labelled sidebar, and add the custom icon set. This is a
deliberate replacement of the shipped ember theme, not an addition alongside it.

What changes relative to `main`:

| | Phosphor (adopt this) | `main` today |
|---|---|---|
| Accent | Amber `#FFB454` | Ember red `#E2453A` |
| Background | Cool near-black `#0B0C0F` | Warm near-black `#0a0807` |
| Surfaces | White-alpha overlays | Opaque warm steps (`#14100d`, `#1c1613`) |
| Borders | White-alpha `.06–.18` | `#3a2f27` / `#251d18` |
| Body type | `Archivo` variable (wdth 62–125) | `-apple-system` stack |
| Data/label type | `IBM Plex Mono`, wide tracking | none |
| Desktop nav | 210px labelled sidebar | 76px icon-only glass rail |
| Icons | Custom SF-Symbols-style paths | `lucide-react` |
| Mobile | Responsive small-viewport form | none |

Because every component CSS module reads these tokens, **the retheme is a visual change to
the entire app, including screens Phosphor never drew.** Budget a pass over every existing
module in `src/components/**` to catch places that assumed opaque warm surfaces — most will
simply inherit correctly, but anything that layers two surfaces will need checking, since
stacked alpha fills compound where opaque steps did not.

Three consequences to handle explicitly:

- **`--shadow-ember-bloom` becomes wrong.** It is a red-tinted hover bloom. Phosphor uses
  neutral black shadows. Either retint it to amber or retire it; do not leave red bloom on
  an amber app.
- **The `.glass` recipe survives but changes character.** Phosphor's chrome is flat
  translucent dark (`rgba(18,20,25,.86)` + `blur(20px)`), not liquid glass with a specular
  edge. Keep `.glass` for the mobile tab bar and now-playing bar; drop the specular
  highlight and frost gradient, since Phosphor's chrome reads as neutral scrim.
- **The light theme is removed** — dark only. See *Light theme* below.

**2. Build one responsive tree, not two layouts.** See *Responsive strategy* below.

**3. Dark theme only.** The light theme and `ThemeToggle` are removed — see *Light theme*.

Everything in *Screens*, *Interactions & behavior*, and *State management* is unaffected by
decision 1 — those sections describe structure and are correct as written.

---

## Fidelity

**High-fidelity.** Colors, type sizes, spacing, radii, motion, copy, and interaction states
are all final and intentional. Recreate them precisely. Content values (titles, file paths, percentages, timestamps) are **placeholder
fixtures** — wire them to real API data; do not ship the fixture strings.

---

## Responsive strategy — read this before building the mobile layout

The prototype implements desktop and mobile as **two separately authored layouts sharing
one state model**. That is an *adaptive* approach, and it was chosen deliberately for the
prototype: it let the phone experience get real iOS affordances (bottom sheets, tab bar,
safe-area insets) that a reflow of the desktop layout would never produce.

**For the product, build it responsive — one component tree.** Reasons:

- "Same server, no separate app" is a product promise; user-agent branching contradicts it.
- Two layouts is exactly how the prototype drifted (mobile was missing add-user until it
  was audited). In a codebase with `--max-warnings=0` discipline, silent capability drift
  is worse than a slightly less bespoke phone layout.
- `apps/web` already ships one route tree; forking it doubles route count.

Concretely: one set of route components; container queries / `@media` breakpoints in the
CSS modules; the chrome swaps at the breakpoint (`NavRail` ⇄ bottom tab bar) while page
content reflows. Treat the "mobile view" in the prototype as **the small-viewport
specification for the same components**, not as separate screens. The section below marks
which mobile patterns are genuine small-viewport variants versus phone-only additions.

Breakpoint: the prototype's phone frame is **392 × 846 CSS px** (iPhone 14/15 class).
Desktop layouts assume **≥ 1280px** content width. Design the middle range (tablet) as the
desktop layout with the sidebar collapsed to icons — it is not drawn in the prototype and
needs a design decision.

---

## Design tokens

### Text contrast — known AA exception, accepted by the owner

`tokens.css` today carries a verified-contrast comment (`bg/text 17.5:1`,
`surface/text-subtle 4.7:1 — all ≥ WCAG AA`). **Phosphor's lower grey tiers do not clear
AA.** Measured against `#0B0C0F`:

| Phosphor grey | Contrast | AA (4.5:1) |
|---|---|---|
| `#E9EBEE` primary | 15.6 : 1 | ✅ |
| `#C7CBD1` secondary | ~11 : 1 | ✅ |
| `#9BA0A8` muted | 7.4 : 1 | ✅ |
| `#61666E` subtle | 3.4 : 1 | ❌ |
| `#4A4E55` faint | 2.3 : 1 | ❌ |

Those two tiers carry the 9–10px uppercase mono labels — the smallest type in the app, where
the large-text exemption does not apply and wide tracking already thins the strokes.

**Decision: ship the values as designed.** The owner has reviewed the measurements and
accepted the exception — the tonal range between the four grey tiers is load-bearing for this
design, and flattening it costs more than the contrast gains. Implement `#61666E` and
`#4A4E55` exactly as specified below. Do not "helpfully" brighten them.

What this obliges you to do instead:

- **Update the stale comment in `tokens.css`.** Its current claim that all pairs clear AA
  becomes false. Replace it with a note recording the two exceptions, their measured ratios,
  and that they are an accepted design decision — so the next person doesn't discover it as
  a bug and "fix" it.
- **Never put these tiers on anything below `--text-xs`, or on a non-`--color-bg` surface.**
  Contrast drops further over artwork and lighter fills. Where a mono label sits on a
  gradient (hero eyebrows, poster captions), it needs a scrim behind it — the prototype
  already does this with its `linear-gradient` overlays; preserve them.
- **Never make these tiers the only signal.** Anything encoded in faint grey must also be
  carried by position, label, or icon. Audit the places where they carry meaning — the
  registry `DEFAULT` / `PINNABLE` footers and the `SORTED BY DATE ADDED` readouts are the
  main ones.
- **Expect this in an accessibility audit.** Lighthouse runs in CI (`pnpm lighthouse`); its
  contrast check will flag these. Decide up front whether to annotate the exception or
  accept a lowered a11y score, and don't let the failure block the pipeline silently.

If the product later needs to clear AA, the smallest change is `#61666E` → `#7C828B`
(5.1 : 1) and `#4A4E55` → `#757B84` (4.6 : 1), which collapses the two faintest tiers into
near-identical values — which is exactly why it was not taken now.

### Proposed `tokens.css` (dark / default)

```css
:root {
  color-scheme: dark;

  /* Radius — unchanged scale, Phosphor values fit it */
  --radius-pill: 9999px;
  --radius-lg: 20px;   /* cards, dialogs, sheets */
  --radius-md: 14px;   /* posters, thumbnails, tiles */
  --radius-sm: 10px;   /* inline chips, nested blocks */
  --radius-full: 50%;

  /* Motion — unchanged */
  --motion-fast: 150ms;
  --motion-base: 240ms;
  --motion-slow: 400ms;
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);

  /* ── Phosphor: cool near-black, white-alpha surfaces ── */
  --color-bg: #0b0c0f;
  --color-bg-raised: #111318;      /* modals, popovers, command palette */
  --color-surface: #15171c;        /* bottom sheets, toasts */
  --color-surface-hover: #1a1d23;
  --color-surface-active: #20242b;

  /* Alpha fills — Phosphor layers these over artwork, so they must stay
     translucent. Ascending emphasis; do not stack two without checking. */
  --fill-1: rgb(255 255 255 / 2%);   /* card + row rest */
  --fill-2: rgb(255 255 255 / 3%);
  --fill-3: rgb(255 255 255 / 4%);   /* grouped-list rows, hover */
  --fill-4: rgb(255 255 255 / 5%);
  --fill-5: rgb(255 255 255 / 6%);   /* pressed, segmented track */

  --color-border-subtle: rgb(255 255 255 / 7%);  /* hairlines, separators */
  --color-border: rgb(255 255 255 / 12%);        /* control borders */
  --color-border-strong: rgb(255 255 255 / 18%); /* emphasis, bezels */

  --color-overlay: rgb(4 5 7 / 50%);   /* sheet + modal scrim (+ blur 3px) */

  /* Text — as designed; see the contrast note above. The two lowest tiers
     are a knowingly accepted AA exception, not an oversight. */
  --color-text: #e9ebee;
  --color-text-secondary: #c7cbd1;
  --color-text-muted: #9ba0a8;
  --color-text-subtle: #61666e;   /* 3.4:1 — accepted exception */
  --color-text-hint: #4a4e55;     /* 2.3:1 — accepted exception */

  /* ── Amber accent ── */
  --color-accent: #ffb454;
  --color-accent-hover: #ffc272;
  --color-accent-active: #e89f42;
  --color-accent-subtle: color-mix(in srgb, var(--color-accent) 16%, transparent);
  --color-accent-tint: color-mix(in srgb, var(--color-accent) 12%, transparent);
  --color-accent-border: color-mix(in srgb, var(--color-accent) 40%, transparent);
  --color-accent-text: #0c0d10;   /* text ON accent — dark, not white */
  --color-focus: #ffc272;

  --color-danger: #e2453a;        /* errors, destructive, unmatched files */
  --color-warning: #e0a548;       /* restricted, restart-pending, cautions */
  --color-success: #5cb87a;
  --color-dominant-fallback: #1c2128;

  /* ── Type ── */
  --font-sans: "Archivo", system-ui, -apple-system, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;

  /* Archivo width axis — the signature of the direction */
  --wdth-display: 118%;   /* movie/series display titles */
  --wdth-title: 114%;     /* screen titles, section headings */
  --wdth-wordmark: 125%;  /* LOOMBRE wordmark */
  --wdth-poster: 62%;     /* oversized poster initial */

  --text-display: 52px;
  --text-2xl: 31px;   /* mobile large title */
  --text-xl: 26px;    /* desktop h1 */
  --text-lg: 19px;    /* h2 */
  --text-md: 16px;    /* mobile list row label */
  --text-base: 14.5px;
  --text-sm: 13px;
  --text-xs: 12px;

  /* Mono scale — labels, counts, paths, log lines */
  --mono-lg: 11px;
  --mono-md: 10px;
  --mono-sm: 9.5px;
  --mono-xs: 8.5px;
  --track-mono: 0.1em;    /* default label tracking */
  --track-mono-wide: 0.16em;  /* section eyebrows */

  --leading-display: 1;
  --leading-tight: 1.15;
  --leading-normal: 1.45;
  --leading-dense: 1.55;  /* mono blocks, log tails */

  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;
  --weight-black: 800;    /* titles — Archivo goes to 900 */

  /* ── Shadows — neutral, no ember tint ── */
  --shadow-sm: 0 2px 8px rgb(0 0 0 / 40%);
  --shadow-md: 0 8px 24px rgb(0 0 0 / 50%);
  --shadow-lg: 0 16px 48px rgb(0 0 0 / 60%);
  --shadow-poster: 0 24px 64px rgb(0 0 0 / 58%);
  --shadow-modal: 0 32px 90px rgb(0 0 0 / 70%);
  --shadow-sheet: 0 -20px 60px rgb(0 0 0 / 60%);
  --shadow-focus-ring: 0 0 0 3px var(--color-focus);

  /* ── Chrome scrim — replaces liquid glass ── */
  --chrome-bg: rgb(18 20 25 / 86%);
  --chrome-blur: 20px;
  --chrome-edge: rgb(255 255 255 / 7%);

  /* ── Phosphor texture ── */
  --scanlines: repeating-linear-gradient(
    0deg, rgb(0 0 0 / 28%) 0 1px, transparent 1px 3px
  );
  --vignette: radial-gradient(
    120% 90% at 50% 45%, transparent 40%, rgb(0 0 0 / 55%) 100%
  );

  /* Semantic aliases — keep, existing modules reference them */
  --bg: var(--color-bg);
  --surface: var(--color-surface);
  --overlay: var(--color-overlay);
  --text: var(--color-text);
  --muted: var(--color-text-muted);
  --border: var(--color-border);
  --focus: var(--color-focus);
}
```

`--color-accent-text: #0c0d10` is the one easy mistake to make: ember used white text on
accent, amber needs **dark** text on accent. Every filled primary button, `BEST` badge, and
active segmented pill in Phosphor is dark-on-amber.

### Light theme — removed

**Decision: dark only. Delete the light theme and `ThemeToggle`.**

Phosphor was designed dark-only — a media app viewed in a dark room, with artwork as the
light source. Amber also cannot carry accent *text* on a light background (`#FFB454` on
paper is ~1.7:1), so a light Phosphor would need a second accent value and its own design
pass. Not worth it now.

What to remove:

- The entire `:root[data-theme="light"]` block in `tokens.css`.
- `src/components/shell/ThemeToggle.tsx` and its render in `Topbar.tsx`.
- Any persisted theme preference and the `data-theme` attribute write — check
  `app/layout.tsx` for where the attribute is set on `<html>`.
- `color-scheme` stays `dark` in `:root` — keep it, so form controls and scrollbars render
  dark natively.

Two things to keep in mind while removing it:

- **Grep for `data-theme` before deleting.** Any component CSS with a
  `[data-theme="light"]` override becomes dead code; remove those rules too rather than
  leaving selectors that can never match.
- **Don't hardcode what the tokens abstracted.** The tokens stay — they are the design
  system, not the theming mechanism. A future light theme should still be possible by adding
  the block back, so keep component CSS referencing custom properties and resist inlining
  literal hexes now that there is only one value each.

This is a user-visible feature removal. It is agreed, but note it in the changelog rather
than letting it land silently.

### Accent as a user preference

Accent is a **runtime-switchable prop** in the prototype with four options:
`#FFB454` (amber, default), `#CDF34C` (lime), `#4CE0B3` (mint), `#8AB8FF` (blue). It is
applied as a single CSS custom property `--acc` on `document.body`. If the owner wants a
user-selectable accent in the product, this is the mechanism — one variable, everything
downstream uses `var(--acc)` and `color-mix()`. Otherwise drop it and use `--color-accent`.

Poster / scene artwork is faked with `linear-gradient(160deg, oklch(0.4 0.09 <hue>),
oklch(0.18 0.04 <hue>))` and a large translucent initial letter. In production these are
real images — use the existing `blurhash-canvas.ts` / `image-url.ts` path, and keep the
gradient as the **missing-artwork fallback** (it pairs with `--color-dominant-fallback`).

**Typography**

Phosphor uses two families:

- `Archivo` — variable, axes `wdth 62..125`, `wght 100..900`. Loaded from Google Fonts.
  Headings exploit the width axis: `font-stretch: 114%` (screen titles), `118%` (movie
  title display), `125%` (wordmark), `62%` (the oversized poster initial). This width
  variation is the single most distinctive thing about the direction — if you adopt
  Phosphor, self-host the variable font and keep `font-stretch`; a static-width substitute
  loses the effect.
- `IBM Plex Mono` — 400/500/600, used for **all** metadata, labels, counts, paths, log
  lines, and status chips, typically uppercase with `letter-spacing: .06em–.18em`.

Desktop scale: 52/26/21/19/14.5/13.5/13/12/10.5 px, mono 8–11 px.
Mobile scale: 31/23/21/19/16/15.5/15/14.5/14/13.5/13/12.5/11.5 px, mono 8–11.5 px.
Line heights: `.98`–`1.15` display, `1.45` body, `1.5`–`1.7` dense mono blocks.
`text-wrap: pretty` on all multi-line body copy.

**Spacing** — 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 30,
34, 36, 40 px. Maps cleanly onto the existing `--space-*` scale (2/4/8/12/16/24/32/48/64)
with intermediate values rounded to the nearest step. Desktop page padding `26px 28px 90px`
(the 90px bottom clears the fixed prototype chrome — **drop it in production**). Mobile
content padding `14px 16px 26px`.

**Radii** — desktop 6, 8, 12, 14, 18, 999px; mobile 9, 11, 12, 13, 14, 16, 18, 20, 999px;
phone bezel 46px. Map: pills/chips/inputs/buttons → `--radius-pill`; cards/dialogs/sheets →
`--radius-lg`; posters/thumbnails/tiles → `--radius-md`; nested chips and inline blocks →
`--radius-sm`; avatars and icon buttons → `--radius-full`.

**Motion**

| Name | Value | Used for |
|---|---|---|
| `lmUp` | `.35s ease` — `opacity 0→1`, `translateY(10px)→0` | screen enter |
| `lmUp` | `.3s` | settings pane switch |
| `lmUp` | `.22s` | modals, bottom sheets |
| `lmPulse` | `3s` / `1.6s` infinite — `opacity 1→.3→1` | live status dots |
| `lmEq` | `1s ease-in-out` infinite, staggered `0 / .25s / .5s` — `scaleY(.3→1)` | now-playing equalizer bars |
| `lmSpin` | `linear` infinite | scan spinners |
| transitions | `.15s` / `.2s` / `.25s` `cubic-bezier(.22,1,.36,1)` | hover, toggles, layout shifts |

Map to `--motion-fast/base/slow` and `--ease-spring` (enter) / `--ease-out` (exit).
Respect the existing `prefers-reduced-motion` block — it already clamps these.

**Other**

- Scanline overlay: `repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px)`
  over all hero/scene artwork, opacity toggled by a `scanlines` boolean prop (default on).
  A tasteful CRT-phosphor cue — the name of the direction. Ship it behind a user preference
  or drop it; do not make it non-optional.
- Vignette on player/hero: `radial-gradient(120% 90% at 50% 45%, transparent 40%, rgba(0,0,0,.55) 100%)`.
- Shadows: `0 8px 24px rgba(0,0,0,.5)`, `0 16px 48px rgba(0,0,0,.6)`,
  `0 24px 64px rgba(0,0,0,.55–.6)` (posters), `0 32px 90px rgba(0,0,0,.7)` (modals),
  `0 -20px 60px rgba(0,0,0,.6)` (bottom sheets). Map to `--shadow-md/lg`.
- **Mobile touch targets are never below 44px.** This is enforced throughout via
  `min-height:44px` and 36–44px icon-button hit boxes. Preserve it.

---

## Screens

### Desktop

`Movies` and `TV Shows` are **library shortcuts, not separate routes** — both open `/browse`
with the library filter preset (`lib=Movies` / `lib=TV`); their nav items light when Browse
shows that library, while the Browse item lights for All/Music. The film and tv icons follow
the same SF-Symbols style as the rest of the set (paths in the prototype).

Route mapping assumes the existing `apps/web/src/app` tree. Screens marked **NEW** have no
route today.

| Screen | Prototype id | Route | Exists in repo? |
|---|---|---|---|
| Home | `home` | `/home` | ✅ `app/home/` |
| Browse | `browse` | `/browse` | ✅ `app/browse/` |
| Movie detail | `movie` | `/items/[id]` | ✅ `app/items/` |
| Series detail | `series` | `/items/[id]` | ✅ `app/items/` |
| Person | `person` | `/people/[id]` | **NEW** |
| Watchlist | `watchlist` | `/watchlist` | **NEW** |
| Restricted zone | `restricted` | `/restricted` | **NEW** |
| Search | `search` | `/search` | ✅ `app/search/` |
| Music / album | `music` | `/items/[id]` (album) | partial — `components/music/` |
| Player | `player` | `/watch/[id]` | ✅ `app/watch/` |
| Playback unavailable | `unavailable` | `/watch/[id]` state | ✅ `components/player/UnavailableScreen.tsx` |
| Admin dashboard | `admin` | `/admin` | ✅ `app/admin/` |
| System panel | `system` | `/admin/system` | ✅ |
| Settings (8 tabs) | `settings` | `/settings`, `/admin/settings` | ✅ |
| Login | `login` | `/login` | ✅ |
| Setup wizard (7 steps) | `onboarding` | `/setup` | ✅ `app/setup/` |
| TV / 10-foot | `tv` | — | **NEW**, exploratory — confirm scope before building |

**Shell.** 210px fixed sidebar: wordmark + `MEDIA SERVER · V0.9.2`; a `LIBRARY` group
(Home, Browse, Movies + count, TV Shows + count, Watchlist + count, Restricted + `PIN`
badge/count, Search — **no Music entry**: the music library is reached through Browse's
`Music` pill and Home's album rail, and the album/queue screen keeps its route); a `SYSTEM` group (Dashboard + live `SCAN`
badge, System, Settings); a storage-pool meter (`POOL 43.1 / 60.8 TB`, 71% bar); and a user
row (avatar, `Maya Reyes`, `OWNER · SIGN OUT`). Nav items are 999px pills, `13px/500`,
`9px 16px` padding, `11px` gap to a 17px icon; active = accent text on
`color-mix(in srgb, var(--acc) 12%, transparent)`. Topbar: breadcrumb, a live scan chip, a
restricted-lock icon button, a `⌘K` search field, and an avatar.

**Home.** Opens on a **Featured banner** (min-height 252px, growing to at most 282px) — scene
gradient, scanlines, a left-to-right scrim, a rotation-control header row, a 118×177 poster, an
accent `FEATURED · <tag>` eyebrow, a 40px display title clamped to two lines, a spec
line, a two-line clamped blurb, and `Play` / `Details` / watchlist-toggle pills (all 38px
tall). Below it: a `Continue Watching` rail of 16:9 cards with progress bars and
`position · device`, a `Recently Added` 2:3 poster grid, a `Your Watchlist` rail (hidden when
empty, each card offering inline `REMOVE`), and a `New in Music` album rail.

**The featured candidates must be titles that appear in none of those rails.** Build the
exclusion set from the continue-watching items, the Recently Added grid, and the watchlist,
then take **up to five** of the remaining library titles (movies and series) as the rotation
pool. Two
earlier revisions shipped a featured item that duplicated a card in the same fold — first
from Continue Watching, then from Recently Added — so make this a real query constraint, not
a preference ordering.

**The banner rotates** through that pool: 7s dwell, 260ms opacity crossfade on both the
artwork layer and the content layer (the artwork is a gradient, so it cannot be transitioned
in place — fade two stacked layers). Rotation pauses on pointer hover and while the player,
any modal, any bottom sheet, or the command palette is open. Manual controls sit **top-right**
on both layouts: a dot per candidate (the active one widens to 18px) plus prev/next arrows on
desktop; interacting resets the dwell timer. Hide the whole control cluster when the pool has
one item. Series candidates
render the same banner with a `SERIES IN YOUR LIBRARY` tag and a `years · status · N seasons`
spec line.

Two constraints that cost three rounds to get right — don't rediscover them:

- **Cap the pool.** "Every eligible title" is not a carousel; a real library would render
  hundreds of dots. Five is the design's number — the server decides *which* five (editorial
  order, or most-recently-scanned-and-unwatched).
- **Separate the controls from the text by ROW, not by column, and let the banner grow.** The
  banner is a vertical flex: a 30px header row holding the dot/arrow cluster right-aligned,
  then a `flex:1` body row with the poster and the text column. Two approaches that failed:
  padding on the title (it insets the content box, but a long word paints straight through it,
  and because the body is vertically centred, which row collides changes with content height),
  and reserving a 168px grid *column* for the controls (it starved the text column to 248px, so
  the 40px title wrapped to four lines and the button row was pushed outside the fixed-height
  banner and clipped). Row separation makes collision geometrically impossible and gives the
  text the full width. Also: `min-height` on the banner rather than `height` so content can
  never be clipped, `-webkit-line-clamp:2` + `overflow-wrap:anywhere` on the title so a long
  title bounds the banner at 282px instead of growing unbounded, and `white-space:nowrap` on
  the three pills so their labels can't wrap inside the 38px pill.

For the product: pool and order should come from the server (an editorial or
recently-scanned-but-unwatched query), not the client, so every device features the same
thing. Respect `prefers-reduced-motion` by disabling auto-advance and keeping the dots as
manual navigation.

There is deliberately **no resume hero**. An earlier revision had one above the rail; it
duplicated the first rail card and gave Home two competing "Resume" actions. Resume lives in
the rail only, on both desktop and mobile.

**Browse.** Library pills with counts (All / Movies / TV / Music), toggle filter chips,
a cycling sort chip, a mono result readout, then an `auto-fill minmax(148px,1fr)` poster
grid. Cards lift `translateY(-4px)` on hover.

**Movie detail.** 340px scene banner with a `← LIBRARY` glass pill; content pulled up
`-190px` with a 218px poster (2:3, oversized initial, inner hairline) beside a metadata
column: accent eyebrow (`MOVIE · year · rating · runtime · genres`), 52px uppercase title,
blurb, then `Play` / watchlist toggle / `✓ Mark watched` and a `DIRECT PLAY OK ON THIS
DEVICE` capability line. Two-column body: `VERSIONS · 2 FILES` (per-file cards with
`DEFAULT` badge, size, codec specs, direct-play line, full path) and `CAST` rail on the
left; a `METADATA` card on the right with `EDIT` / `FIX MATCH` actions and six rows
(Match confidence, Director, Studio, Audio, Subtitles, Added).

**Series detail.** 320px banner, `Continue S2E4` primary action, season pill tabs, then
episode rows: 62×38 thumbnail with progress sliver, `E04` mono index, `WATCHED` accent
badge, title, runtime.

**Music.** 230px album art, title/artist/`meta · FLAC`, `Play album`, an `Up next` queue
row, then a track table. Queue drawer supports reorder-up and remove; the current track
cannot be removed; an animated 3-bar equalizer marks it.

**Player.** Full-bleed scene, scanlines, vignette. Title, sub, transport (back-15 / play-pause /
forward-30 with numerals in the glyphs), a click-to-seek scrubber, and capability chips
(`DIRECT PLAY`, `SUBTITLES OFF`, `AIRPLAY`, `QUEUE n`). A signal/stats overlay toggles.

**Playback unavailable.** Refusal screen: what was attempted, an itemized reason list
(each with a severity dot, plain-language explanation, and a machine code), and the
fallback action (`Play the 1080p SDR version`). The design principle here is explicit —
**never silently downgrade quality; always state the reason and offer the choice.**

**Admin dashboard.** Four health cards (CPU with a 10-segment bar, GPU/NVENC + session
count, memory, storage pool). Left column: `ACTIVE STREAMS · 3` (mode badge DIRECT PLAY /
TRANSCODE, item, user · device, progress, detail, and a `WHY:` band explaining any
transcode) and `LIBRARIES` (name, kind, item count, state, last scan, `SCAN NOW` / `PAUSE`,
and an `n UNMATCHED · REVIEW` disclosure that expands scan errors with a `FIX MATCH`
action). Right column: users online with presence dots, a collapsible job queue, and a
collapsible event log.

**Settings.** 200px pill tab list + a 760px max-width pane. Tabs:

1. **Server** — name/address (RENAME), hardware transcoding status, and a telemetry row
   that reads `NONE. THERE IS NO PHONE-HOME CODE TO TURN OFF. — BY DESIGN`.
2. **Libraries** — three library rows (MANAGE) + a dashed `+ ADD LIBRARY` tile → modal
   (path, detected file count, read-only reassurance, kind chips, `Create & scan`).
3. **Users & Profiles** — `USERS · n` + `+ Add user` → modal (name, role chips
   MEMBER/RESTRICTED/GUEST, restricted-content toggle, `Create user`). User rows show
   avatar, name, a `🔒 PIN` badge for restricted profiles, role, capability chips, and a `⋯`
   menu. Followed by an explainer: enforcement is in the database layer, not the UI.
4. **Playback** — direct-play preference, remote quality cap, skip-intros.
5. **Remote Access** — detected reverse proxy, TLS/HSTS/`TRUST_PROXY`, and
   `TOKEN REDACTION IN PROXY LOGS: VERIFIED`.
6. **Plugins** — metadata provider cards (TMDB, TVDB, + one more): status badge, coverage,
   rate limit, cache TTL, and **write-only API-key management** — set / replace / remove
   with a confirm step. The value is never displayed after saving; only whether a key is
   set, its source, and when it was last set are ever reported.
7. **Advanced Server** — the schema-driven registry: a filter field, category pills with
   counts, and one card per key showing the key name, a source badge, a `RESTART` badge
   where applicable, description, optional caution, the right editor for its kind
   (bool / enum / num with steppers / JSON textarea), inline validation, `Save` / `Reset`,
   a `SAVED · APPLIED IMMEDIATELY` confirmation, and a `DEFAULT` + `PINNABLE <ENV_VAR>`
   footer. Env-pinned and env-only keys render **locked** with a padlock, the current
   value, and an explanation instead of an editor. A restart-pending banner appears when a
   saved key needs one.
8. **About** — version, runtime, build/migration, and
   `GROUND-UP. NOT A FORK. NO TELEMETRY.`

Tabs 1–4 also surface their handful of everyday registry keys inline, with an
`ADVANCED →` link through to tab 7. **`packages/shared/src/settings-registry.ts` is the
source of truth for keys, kinds, defaults, env names, and restart flags — read it rather
than transcribing values from the prototype fixtures.**

### Mobile

One screen in the prototype (`mobile`), rendered inside an iPhone frame with Dynamic
Island, status bar, Safari bottom toolbar, and home indicator. **The frame, status bar,
and Safari chrome are presentation for the mock — do not build them.** Everything inside is
the spec.

Chrome: a large-title header (31px, `-.02em`) with subtitle, a back chevron with contextual
label, a restricted-lock icon button, and an avatar that opens the account sheet. A 6-tab
bottom bar — **Home, Movies, TV Shows, Search, Restricted, Settings** — with a now-playing
mini-bar docked
above it when audio is active. Movies and TV Shows are the Browse view with the library
preset (same as desktop); Browse-All and the music library remain reachable via the library
pills inside that view, and the music screen via Home's album rail and the now-playing bar.
The header large-title reads `Movies` / `TV Shows` to match the active library. The
Restricted tab opens the zone as an overlay view on whatever tab is active (back chevron
returns); it lights while the zone is open. **Exactly one tab is lit at a time:** while the
zone overlay is open, the underlying tab's active state is suppressed (every other tab's
check includes "and the zone is not open"), and tapping any other tab dismisses the overlay.

Mobile Home carries the same five sections in the same order as desktop — Featured banner,
`KEEP WATCHING`, `RECENTLY ADDED`, `WATCHLIST`, `ALBUMS` — with the featured banner in its
vertical form: full-width, 232px, bottom-anchored text over a scrim, `Play` + watchlist pills
at 44px, and the rotation dots top-right. Same candidate pool, rotation, and exclusion rule
as desktop.

Small-viewport variants of desktop screens (build these as the responsive form of the same
components): Home, Browse, Search, Music, Movie detail, Series detail, Person, Watchlist,
and every Settings section — including the Dashboard and System admin panels, which reflow
to stacked cards with a 2-up stat grid.

Phone-only additions (genuinely new UI, not reflow):

- **Bottom sheets** replace desktop modals. Sheet shell: 20px top corners, grab handle,
  title + sub + `Done`, `max-height: 82%`, scrollable body. Nine sheets: account, queue,
  PIN entry, resume prompt, playback-unavailable, add user, add library, edit metadata,
  fix match.
- **Settings hub** — an inset grouped list of the ten sections with sub-labels and badges
  (`LIVE`, key count, provider count), instead of the desktop's side tabs.
- **Segmented controls** replace desktop pill-chip rows for role and library-kind pickers.
- **PIN keypad** — 74px circular keys in a 3-column grid with filled dot indicators.
- **Signed-out overlay** — an in-frame sign-in state, since there is no separate route.

The mobile Settings sections mirror desktop capability exactly, including add-user,
add-library, the registry filter, plugin key management, and the dashboard's scan-error →
fix-match flow. **Maintaining that parity is the reason to build one responsive tree.**

---

## Interactions & behavior

**Navigation.** Sidebar / tab bar switch screens. Posters and rows open detail. Cast opens
Person. Hero and continue-watching cards open detail; their play button opens the resume
prompt instead. Back chevron on mobile pops detail → tab, or section → settings hub.

**Resume prompt.** Playing anything with saved progress > 0 opens a prompt first, showing
where you stopped, on which device, a progress bar, and two choices: `Resume from <pos>` or
`Start over`. Never auto-resume without asking.

**Playback refusal.** Attempting a version the device cannot play does **not** silently
transcode. It opens the unavailable screen / sheet with itemized reasons and machine codes,
plus an explicit fallback button. On accepting the fallback, a toast confirms
`SWITCHED TO 1080P SDR — DIRECT PLAY`.

**Restricted content.** Restricted titles live in a **dedicated zone with its own screen**
(`/restricted`), fully separated from the general library — they never appear in Browse,
Search, Home rails, the featured pool, or the watchlist, locked or not. The lock only
governs access to the zone itself.

- **Navigation:** a `Restricted` entry sits in the sidebar's LIBRARY group — amber `PIN`
  badge while locked, item count once unlocked. Browse shows an amber
  `N RESTRICTED · PIN-GATED ZONE →` chip that navigates there (mobile: a 44px tappable row
  above the grid; plus a `Restricted zone` row in the account sheet).
- **Locked (default):** the screen is a gate — lock roundel, `This zone is locked`, the item
  count, the separation rule restated, `SESSION-SCOPED · RE-LOCKS ON SIGN-OUT AND AFTER 30
  MIN IDLE · ALL DEVICES TOGETHER`, and an `Unlock with PIN` button → 4-digit PIN entry,
  auto-submits on the fourth digit. Opening a restricted item by any path while locked
  routes to PIN entry, never to content.
- **Unlocked:** the gate becomes an amber-accented poster grid (amber card borders instead
  of the library's white hairlines), with a `LOCK NOW` control in the header (mobile: a
  lock row above the grid). The zone has its **own query toolbar** — all of it zone-scoped,
  never touching the general library's search/filter state: a `Search this zone…` field,
  genre pills derived from the zone's titles (`ALL / THRILLER / WESTERN / WAR` in the
  fixtures — derive, don't hardcode), `4K` / `HDR` toggle chips, and the same cycling sort
  as Browse (`Recently Added / Title A–Z / Year`). Active genre/filter chips fill amber
  (`#E0A548` with dark text), not accent — the zone keeps its warning colour. A mono
  readout reads `N OF TOTAL · SORT · ZONE-ONLY INDEX`; an empty result shows a dashed
  empty state with a `CLEAR SEARCH & FILTERS` reset. On mobile the toolbar is a 44px search
  row + one horizontally scrolling pill row (genres · divider · filters · sort) above the
  readout and grid. Detail pages of zone titles carry a `RESTRICTED · PIN HOLDERS
  ONLY` chip beside the eyebrow (full-width amber band on mobile). Re-locking is instant,
  toasts `RESTRICTED ITEMS HIDDEN · PIN TO UNLOCK`, and returns the zone to its gate.
  Zone search must hit a **separate index** server-side — the general FTS index must not
  contain zone titles, or a timing/count side-channel leaks them.
- The zone's existence is deliberately visible (sidebar entry, Browse chip, aggregate
  count) — the owner accepts revealing *that* a zone exists; titles and artwork never leak.
- Restricted-profile users (June) get no zone entry and no PIN prompt at all — for them the
  filter is compiled into every query server-side; the zone does not exist.
- Enforcement belongs in the query layer — the UI lock is affordance, not the security
  boundary. In the prototype every general list passes through one `vis()` filter that
  strips zone titles unconditionally; mirror that as a server-side query constraint.

**Watchlist.** Toggle from any detail screen; toasts `ADDED TO / REMOVED FROM WATCHLIST`.
Syncs across profiles and devices. Empty state invites the first save.

**Queue.** Reorder up, remove, jump-to-track. The current track cannot be removed. Footer
notes gapless readiness and server-side persistence.

**Registry editing.** Typing marks a field dirty and enables `Save`; `Save` validates
client-side against the schema and shows an inline mono error on failure; success shows
`SAVED · APPLIED IMMEDIATELY` and, for restart-flagged keys, raises the restart banner.
`Reset` returns a key to its default and is only offered when the value has been changed.
Env-pinned keys have no editor at all.

**Provider keys.** Idle → `Set` or `Replace` + `Remove`. Replace reveals a password input
and Save/Cancel. Remove requires a confirm step in a danger-tinted block. Copy: once saved,
the value is never shown again.

**Scanning.** `SCAN NOW` starts a scan and shows a live percentage bar; `PAUSE` while
running. `n UNMATCHED · REVIEW` expands per-file errors; fixable ones offer `FIX MATCH`,
which opens a candidate list with confidence bars and a `BEST` badge — applying re-fetches
artwork and NFO and never touches the original file.

**Add user / add library.** Both are real create flows in the prototype: add-user appends
to the user list, updates the count, and toasts `USER CREATED · INVITE LINK COPIED`;
selecting the RESTRICTED role forces the restricted-content toggle on. The `Create user`
button is disabled-looking (45% opacity) and inert until a name is entered.

**Feedback.** All confirmations are a single bottom-center toast: 999px pill, accent dot,
uppercase mono, 2.6s auto-dismiss. No inline success banners except the registry's
per-field `SAVED` line.

**Keyboard.** `⌘K` / `Ctrl+K` opens a command palette (fuzzy screen + action jump);
`Escape` closes palette, modals, and sheets.

**Hover states** (desktop only): nav rows lighten to `rgba(255,255,255,.04)`; poster cards
lift 4px and gain a shadow; outline chips brighten border and text to accent or white;
primary buttons `filter: brightness(1.1)`.

---

## State management

The prototype holds everything in one component's state. In production most of this is
server state — use the existing `api-client.ts` / `events-socket.ts` / `auth-store.ts`
patterns and keep only genuine UI state local.

**Server state (fetch, don't store):** libraries and scan progress, items, active streams,
job queue, event log, online users, users list, registry values and their sources, provider
key *status*, system info, storage pool, watch progress.

**Shared client state:** `watchlist` (id → bool), `restrictedLocked` (bool, session-scoped,
must sync across devices via the events socket, and it filters every content query — see
*Restricted content*), `nowPlaying` (album + index),
`queueOrder` (null = natural order), `playing` (title, sub, artwork, position, duration,
percent), `paused`, accent + scanlines preferences.

**Per-surface UI state:** current screen/route, selected library filter, active filter
chips, sort mode, search query and recent queries, restricted-zone query + genre + filter
chips + sort (separate from the general library's), selected season, featured rotation index +
fade + pause flags, settings tab, registry
category and filter query, registry drafts / dirty / saved / validation errors, restart
pending, provider key mode (`idle` / `replacing` / `confirming`) + draft, open modal + its
context, open sheet, resume-prompt payload, PIN buffer, toast message, and the new-user /
new-library form drafts.

Note the two flags that must be **derived, not stored**: user count and restricted-profile
count. Storing them is how the prototype's mobile subtitle went stale.

---

## Icons

Phosphor uses a custom SF-Symbols-style set drawn as inline SVG paths at `viewBox="0 0 24 24"`,
stroke `1.55`, `stroke-linecap="round"`, `stroke-linejoin="round"`, `fill="none"`,
`stroke="currentColor"`. Desktop renders them at 17px, the mobile tab bar at 24px. All
glyph bounding boxes are optically balanced to ~15.4 × 15.4 within the 24-unit box, and
centered on `x=12`.

The repo uses `lucide-react` through `components/icon/Icon.tsx`. Two viable paths:

- **Use lucide equivalents** — `House`, `LayoutGrid`, `Bookmark`, `Search`, `Music`,
  `BarChart3`, `Cpu`, `Settings` (or `Settings2`). Closest match, zero new assets, but
  lucide's gear is the multi-lobed Feather style, which is the specific "Android-like" look
  this design moved away from. Lucide's default 2px stroke will also read heavier.
- **Add a small custom set** (recommended if fidelity matters) — 8 desktop + 5 tab-bar
  glyphs as a typed `Record<string, string>` of path data rendered by the existing `Icon`
  wrapper. The exact path data is in the prototype file; the seek-button glyphs additionally
  carry `15` / `30` numerals as `<text>` inside the arc, matching iOS `gobackward.15` /
  `goforward.30`.

Everything else — badges, chevrons, status dots, the equalizer — is CSS or trivial inline SVG.

---

## Assets

**None to transfer.** The prototype has no binary assets:

- Artwork is CSS gradients + a typographic initial (see *Design tokens*). Replace with real
  images via `image-url.ts` and `blurhash-canvas.ts`; keep the gradient as fallback.
- Avatars are `oklch(0.45 0.1 <hue>)` circles with initials. Fine to ship as-is.
- Fonts are Google Fonts (`Archivo`, `IBM Plex Mono`). **Self-host if adopted** — a
  self-hosted media server should not require a third-party font CDN at runtime, and the
  existing `csp.ts` will need updating either way.
- Icons are inline paths (above).

---

## Files in this bundle

| File | What it is |
|---|---|
| `Loombre Phosphor.dc.html` | The full prototype — every screen, both layouts. Open in a browser; use the floating `SCREENS` button (bottom right) to jump between screens, and `Settings → OPEN MOBILE VIEW` for the phone layout. |
| `Loombre Directions.dc.html` | The earlier direction exploration Phosphor was selected from — context for why this palette and type treatment. |
| `support.js` | Runtime required for the two HTML files to open. Not part of the design. |

The prototype's own chrome — the `SCREENS` jumper, the `← BACK TO DESKTOP` link, the phone
bezel, and the `90px` bottom padding that clears the jumper — is scaffolding. Do not
implement it.

---

## Suggested implementation order

1. **Retheme `tokens.css`** to the block above, self-host both fonts, update `csp.ts`, and
   sweep every existing CSS module for stacked-alpha and accent-text-colour regressions.
   Land this alone, verify the existing screens, then continue — do not mix the retheme with
   new features in one change.
2. Replace `NavRail` with the labelled 210px sidebar; remove the light theme and
   `ThemeToggle`.
3. Add the responsive breakpoint to `AppShell`: `NavRail` ⇄ bottom tab bar, and the
   large-title mobile header. Everything else depends on the chrome existing.
4. Bottom-sheet primitive + toast primitive. Nearly every flow below needs one.
5. Settings: Users & Profiles (add-user), Libraries (add-library) — the highest-value gap.
6. Admin dashboard reflow: streams, libraries with scan controls, scan errors → fix match.
7. Watchlist route + Person route.
8. Movie-detail metadata card (edit / fix match) and mark-watched.
9. Resume prompt and playback-refusal flows.
10. Registry filter on mobile; verify env-locked shapes still render correctly narrow.
11. Icons, scanlines preference, accent preference.

Steps 5–10 are each independently shippable. If scope has to be cut, cut from the bottom —
but steps 1–2 are all-or-nothing: a half-applied retheme is worse than either theme.
