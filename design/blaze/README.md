# Handoff: Loombre Logo & Brand Identity ("Blaze")

> **Status: integrated — now a historical brand-asset reference.** The
> rollout this handoff describes has shipped in `apps/web` and is
> recorded as closed in root `STATE.md`'s Blaze exit gate: sidebar
> lockup, favicon + app-manifest icons, boot splash, and the loading
> spinner/indeterminate bar are all live. One integration point remains
> open — the GitHub repo social-preview upload — tracked as an owner
> action (D12; it is a repo-settings upload, so nothing in-tree can
> close it). The mark geometry, palette, lockup and token content below
> is still the cited spec authority for the shipped brand assets.

## Overview
Final logo identity for Loombre, the self-hosted media server (repo: `Loombre/Loombre`). The mark — "Blaze" — is a three-tongue flame with the inner flame carved out as **negative space**, in amber phosphor on near-black. It was designed for the in-progress "Phosphor" UI overhaul (amber `#FFB454` accent, CRT/scanline motifs, Archivo expanded caps + IBM Plex Mono) and replaces the placeholder pulsing dot currently in the sidebar.

Deliverables: static marks (SVG/PNG), lockups, app icons, favicons, a social banner, and a reference boot-splash animation with loading states.

## About the Design Files
Everything in `assets/` is a **design reference created in HTML/SVG** — not production code to copy verbatim. The task is to integrate these assets and recreate the animations inside the Loombre web app (`apps/web`, Next.js + CSS custom properties per `src/styles/tokens.css` conventions) using its established patterns. The SVG files themselves ARE production-ready assets; the splash HTML shows intended motion, to be rebuilt as a component.

## Fidelity
**High-fidelity.** Colors, geometry, typography, spacing, and animation timings are final. Recreate pixel-perfectly.

## The Mark
One path pair, viewBox `0 0 96 96`:

- Outer flame: `M56 6 C50 12 44 20 41 30 C37 27 33 23 28 18 C26 28 21 34 19 44 C16 55 19 66 27 73 C34 79 41 83 48 84 C57 84 65 79 69 70 C72 63 72 55 68 46 C67 43 66 41 67 38 C70 36 74 33 77 28 C73 25 68 24 64 24 C59 18 57 12 56 6 Z`
- Inner core (cut-out): `M50 34 C47 40 43 45 42 52 C40 49 38 47 36 46 C34 52 33 57 34 62 C36 71 42 77 49 78 C56 77 62 71 63 62 C63 54 58 47 54 41 C52 38 51 36 50 34 Z`
- Combine both in ONE `<path>` with `fill-rule="evenodd"` so the core is a true hole (works on any background). When animating the core independently (see Motion), render two paths instead and fill the core with the surface color behind it.

### Variants (in `assets/svg/`)
- `loombre-mark.svg` — vertical gradient `#FFD9A0` (0%) → `#FFB454` (50%) → `#E08F2E` (100%), bottom→top. Hero/splash use.
- `loombre-mark-scanline.svg` — gradient + horizontal scanlines (1.2px black @ 35% every 3.2px), clipped to the flame. In-UI dark contexts.
- `loombre-mark-flat.svg` — solid `#FFB454`. Below 24px, single-color contexts, print.
- Glow (hero contexts only): `filter: drop-shadow(0 0 12px rgba(255,180,84,.45))`.

## Lockups
- **Horizontal** (sidebar, docs): flat mark 84px + wordmark. Wordmark: "LOOMBRE", Archivo, weight 800, `font-stretch:125%`, letter-spacing `.22em`, fill `#E9EBEE`. Subline: "SELF-HOSTED MEDIA SERVER", IBM Plex Mono 500, letter-spacing `.16em`, `#61666E`.
- **Stacked** (splash, packaging): gradient mark, wordmark below at letter-spacing `.24em` (add `padding-left:.24em` to optically center), mono subline under.
- Sidebar-size reference: mark 18–19px + wordmark 14.5px next to it; version line `MEDIA SERVER · Vx.y.z` in mono 8.5px below (matches current sidebar structure; the version digits are a placeholder — the shipped sidebar renders the live app version, never a literal).

## App Icons & Favicons
- `loombre-app-icon-dark`: 1024×1024, rounded rect radius 22.4% (229px), bg `#101218`, flat amber mark at 680px centered (x 183, y 193).
- `loombre-app-icon-amber`: same geometry, bg `#FFB454`, mark `#0B0C0F`.
- Favicon: flat mark, tight viewBox `4 1 88 88`. Ship `loombre-favicon.svg` as primary (`<link rel="icon" type="image/svg+xml">`), PNGs 48/32/16 as fallbacks. Replace whatever `apps/web` currently serves.

## Interactions & Behavior (Motion)
Reference implementation: `assets/loombre-splash.html` (reduced-motion safe — replicate that media query).

Boot splash sequence (plays once on app load / server connect):
1. Flame entrance: rise + settle — `translateY(14px) scale(.9) → none`, `.9s cubic-bezier(.22,1,.36,1)`, transform-origin `50% 85%`.
2. Bloom flash on the whole mark: brightness 1 → 2.1 @35% → 1, plus drop-shadow 0 → `26px rgba(255,180,84,.85)` → settle `13px @ .4`; `1.4s ease`.
3. Idle burn (infinite, starts after entrance): outer shell "blaze" — scale/rotate wobble (`.94–1.06`, ±2.4°), `1.05s ease-in-out infinite`, origin `50% 84%`. Inner core "flicker" — same idea, smaller amplitude, `.72s`, origin `50% 68%`. The two run **out of phase** — that's what makes it feel alive.
4. Wordmark + boot log lines fade/rise in staggered delays (wordmark at `.5s`; boot lines at `1.0s`/`1.35s`/`1.7s` — per `assets/loombre-splash.html`, matched by the shipped `BootSplash.module.css`), log values in amber.

Loading states:
- Spinner: the mark with both idle animations at ~80% duration (`.85s` / `.6s`).
- Indeterminate bar: 3px track `rgba(255,255,255,.08)`, amber segment ~34% width sliding `translateX(-110% → 360%)`, `1.6s ease-in-out infinite`.

## State Management
None beyond a `booted` flag to gate the one-shot entrance vs. idle loop, and existing loading states to swap spinner in.

## Design Tokens
Colors: amber `#FFB454`, amber-bright `#FFD9A0`, amber-deep `#E08F2E`, bg `#0B0C0F`, tile `#101218`, splash bg `#07080A`, text `#E9EBEE`, muted `#9BA0A8`, subtle `#61666E`.
Type: Archivo (variable, wdth up to 125, wght 800 for wordmark); IBM Plex Mono 500 for technical sublines.
Note: these belong to the Phosphor redesign; fold them into `src/styles/tokens.css` as that overhaul lands rather than hardcoding.

## Rules
- Minimum mark size 16px; lockups ≥120px wide.
- Clearspace: the width of the inner core on all sides.
- Below 24px use the flat variant (gradient/scanlines mush).
- Scanline overlay in UI contexts: `repeating-linear-gradient(0deg, rgba(0,0,0,.35) 0 1px, transparent 1px 3px)`.

## Assets
All in `assets/` (also independently downloadable):
- `svg/` — mark ×3, favicon, lockup-horizontal, lockup-stacked, app-icon-dark, app-icon-amber (vector masters)
- `png/` — app icons + mark @1024, favicons 48/32/16, banner 1280×640 (GitHub social preview / OG image), lockups @2x
- `icons/` — packaged platform icons: `loombre.icns` (macOS bundle icon), `loombre.ico` (Windows multi-res icon)
- `loombre-splash.html` — animated boot splash reference
- `README.md` — condensed brand sheet
Typefaces: Archivo (variable width axis) + IBM Plex Mono. The lockup SVGs embed **no** webfont — they carry plain `font-family` text nodes, so they render with whatever fonts the viewer has installed (silent fallback if Archivo/IBM Plex Mono are absent); design tools need both installed locally.

## Files
- `assets/…` — everything above
- `screenshots/` — visual references (JPEG, `.jpg`): boot splash (entrance + settled), brand asset sheet, export banner/lockups, mark variants & lockups in UI context.
  **Known gap:** `02-boot-splash-settled.jpg` is byte-identical to `01-boot-splash-entrance.jpg` — it does not actually show the post-entrance idle/settled frame. Verify idle-loop fidelity against `assets/loombre-splash.html` (the motion reference) instead.
- Design exploration references, both under `design/phosphor/` (not at the project root): `Loombre Directions.dc.html` (original direction exploration) and `Loombre Phosphor.dc.html` (the Phosphor UI canvas the mark was designed against). The `Brand Assets.dc.html` sheet cited by earlier revisions of this file was never committed to the repo; it survives only as `screenshots/03-brand-assets-sheet.jpg`.

## Suggested integration points in the repo (four of five shipped — see Status above)
- Sidebar header (replace pulse-dot + text with horizontal lockup) — SHIPPED
- Favicon + app manifest icons in `apps/web` public assets (packaged platform icons ready in `assets/icons/`: `loombre.icns` for macOS bundles, `loombre.ico` for Windows) — SHIPPED
- Login / first-connect boot splash (new component from `loombre-splash.html`) — SHIPPED
- Loading spinner + indeterminate bar components — SHIPPED
- GitHub repo social-preview image (`png/loombre-banner-1280x640.png`) — STILL OPEN (owner action D12: a GitHub repo-settings upload, not an in-tree file)
