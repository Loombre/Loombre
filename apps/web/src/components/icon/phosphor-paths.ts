// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/icon/phosphor-paths.ts
//
// Phosphor custom icon set (STATE.md U7, Wave 2 lane L7): typed path-data
// record, PARSED verbatim out of design/phosphor/Loombre Phosphor.dc.html
// (every `d`/`points`/`x,y,w,h` value below is transcribed, not redrawn —
// polylines/polygons were converted to an equivalent `path` `d` string
// 1:1, and duplicate hand-authored copies of the same glyph at different
// pixel sizes across the prototype's many screens were collapsed to one
// canonical definition here). Rendered through the existing Icon wrapper
// (./Icon.tsx), which resolves a PhosphorIconName BEFORE falling back to
// lucide-react (U7's rule: lucide stays only where the prototype draws no
// custom glyph — see that lane's freeze report for the full kept-lucide
// inventory with justification per item).
//
// Every glyph is viewBox="0 0 24 24" (README "Icons"): the wrapper is the
// ONLY place stroke-width (1.55), cap/join (round), and rendered size
// (17px desktop / 24px tab bar) are set — never repeat them at a call
// site, same discipline Icon.tsx already documents for lucide.
//
// `variant: "fill"` glyphs (play/pause/seek transport + skip) are the
// prototype's solid/filled style (fill:currentColor, stroke:none) — a
// deliberate departure from the outline nav/tab-bar set, matching the
// prototype's own markup exactly (its play/pause buttons never carry
// stroke="currentColor"/fill="none"; they're `fill="currentColor"`
// polygons/rects throughout, every size, every screen).
//
// `text` elements (the seek glyphs' baked-in "15"/"30" numerals, iOS
// gobackward.15/goforward.30 convention) are always rendered fill-only
// regardless of the glyph's own variant — the wrapper hardcodes
// fill="currentColor" stroke="none" on every <text>, matching the
// prototype's own explicit per-element override.

export type PhosphorIconName =
  | "home"
  | "browse"
  | "film"
  | "tv"
  | "search"
  | "settings"
  | "dashboard"
  | "cpu"
  | "lock"
  | "unlock"
  | "play"
  | "pause"
  | "seekBack15"
  | "seekForward30"
  | "reset"
  | "skipBack"
  | "skipForward";

export type PhosphorIconElement =
  | { tag: "path"; d: string }
  | { tag: "rect"; x: number; y: number; width: number; height: number; rx?: number }
  | { tag: "text"; x: number; y: number; value: string };

export interface PhosphorIconDef {
  elements: PhosphorIconElement[];
  /** "stroke" (default, the SF-Symbols-style outline set: fill:none,
   *  stroke:currentColor) or "fill" (solid glyphs — see header). */
  variant?: "fill";
}

function path(d: string): PhosphorIconElement {
  return { tag: "path", d };
}

function rect(x: number, y: number, width: number, height: number, rx?: number): PhosphorIconElement {
  return rx !== undefined ? { tag: "rect", x, y, width, height, rx } : { tag: "rect", x, y, width, height };
}

function text(x: number, y: number, value: string): PhosphorIconElement {
  return { tag: "text", x, y, value };
}

export const PHOSPHOR_ICONS: Record<PhosphorIconName, PhosphorIconDef> = {
  // ── Sidebar / tab-bar set (README "Icons": 8 desktop + 5 tab-bar — the
  // tab bar reuses 5 of these 8 at 24px; dashboard/browse/cpu are
  // desktop-sidebar-only, no mobile tab) ─────────────────────────────────
  home: {
    elements: [
      path("M4 11.4 L12 4.6 L20 11.4"),
      path("M6.1 9.6 V18.6 a1.5 1.5 0 0 0 1.5 1.5 h8.8 a1.5 1.5 0 0 0 1.5 -1.5 V9.6"),
    ],
  },
  browse: {
    elements: [
      path(
        "M5.8 4.3 h3.7 a1.5 1.5 0 0 1 1.5 1.5 v3.7 a1.5 1.5 0 0 1 -1.5 1.5 h-3.7 a1.5 1.5 0 0 1 -1.5 -1.5 v-3.7 a1.5 1.5 0 0 1 1.5 -1.5 z " +
          "M14.5 4.3 h3.7 a1.5 1.5 0 0 1 1.5 1.5 v3.7 a1.5 1.5 0 0 1 -1.5 1.5 h-3.7 a1.5 1.5 0 0 1 -1.5 -1.5 v-3.7 a1.5 1.5 0 0 1 1.5 -1.5 z " +
          "M5.8 13 h3.7 a1.5 1.5 0 0 1 1.5 1.5 v3.7 a1.5 1.5 0 0 1 -1.5 1.5 h-3.7 a1.5 1.5 0 0 1 -1.5 -1.5 v-3.7 a1.5 1.5 0 0 1 1.5 -1.5 z " +
          "M14.5 13 h3.7 a1.5 1.5 0 0 1 1.5 1.5 v3.7 a1.5 1.5 0 0 1 -1.5 1.5 h-3.7 a1.5 1.5 0 0 1 -1.5 -1.5 v-3.7 a1.5 1.5 0 0 1 1.5 -1.5 z",
      ),
    ],
  },
  film: {
    elements: [
      path(
        "M4.4 5.6 h15.2 a1.6 1.6 0 0 1 1.6 1.6 v9.6 a1.6 1.6 0 0 1 -1.6 1.6 H4.4 a1.6 1.6 0 0 1 -1.6 -1.6 V7.2 a1.6 1.6 0 0 1 1.6 -1.6 z " +
          "M7.5 5.6 V18.4 M16.5 5.6 V18.4 M2.8 9.1 H7.5 M2.8 12 H7.5 M2.8 14.9 H7.5 M16.5 9.1 H21.2 M16.5 12 H21.2 M16.5 14.9 H21.2",
      ),
    ],
  },
  tv: {
    elements: [
      path(
        "M4.2 6.4 h15.6 a1.6 1.6 0 0 1 1.6 1.6 v7.8 a1.6 1.6 0 0 1 -1.6 1.6 H4.2 a1.6 1.6 0 0 1 -1.6 -1.6 V8 a1.6 1.6 0 0 1 1.6 -1.6 z M8.6 20.4 h6.8",
      ),
    ],
  },
  search: {
    elements: [path("M10.9 4.7 a6.2 6.2 0 1 0 0 12.4 a6.2 6.2 0 0 0 0 -12.4"), path("M15.4 15.5 L19.9 20")],
  },
  settings: {
    elements: [
      path(
        "M10.13 4.48 A7.75 7.75 0 0 1 13.87 4.48 L14.19 6.58 A5.85 5.85 0 0 1 15.60 7.39 L17.57 6.62 A7.75 7.75 0 0 1 19.45 9.86 " +
          "L17.79 11.19 A5.85 5.85 0 0 1 17.79 12.81 L19.45 14.14 A7.75 7.75 0 0 1 17.57 17.38 L15.60 16.61 A5.85 5.85 0 0 1 14.19 17.42 " +
          "L13.87 19.52 A7.75 7.75 0 0 1 10.13 19.52 L9.81 17.42 A5.85 5.85 0 0 1 8.40 16.61 L6.43 17.38 A7.75 7.75 0 0 1 4.55 14.14 " +
          "L6.21 12.81 A5.85 5.85 0 0 1 6.21 11.19 L4.55 9.86 A7.75 7.75 0 0 1 6.43 6.62 L8.40 7.39 A5.85 5.85 0 0 1 9.81 6.58 Z " +
          "M12 9.4 A2.6 2.6 0 1 0 12 14.6 A2.6 2.6 0 1 0 12 9.4",
      ),
    ],
  },
  dashboard: {
    elements: [path("M5.4 19.3 V13"), path("M12 19.3 V5.9"), path("M18.6 19.3 V15.4")],
  },
  cpu: {
    elements: [rect(7.6, 7.6, 8.8, 8.8, 2.2), path("M12 4.4 V7.6 M12 16.4 V19.6 M4.4 12 H7.6 M16.4 12 H19.6")],
  },

  // ── Lock (README Restricted-zone affordance; RestrictedLockControl,
  // PinModal, and the admin registry's env-locked field state all use the
  // same padlock pair) ────────────────────────────────────────────────────
  lock: {
    elements: [rect(5, 11, 14, 9, 1.5), path("M8 11 V7 a4 4 0 0 1 8 0 V11")],
  },
  unlock: {
    elements: [rect(5, 11, 14, 9, 1.5), path("M8 11 V7 a4 4 0 0 1 8 0")],
  },

  // ── Player transport (README "Player": play/pause, back-15/forward-30
  // with numerals baked into the glyph per iOS gobackward.15/goforward.30)
  // — filled style, matching the prototype's own play/pause everywhere. ──
  play: {
    variant: "fill",
    elements: [path("M6 4 L20 12 L6 20 Z")],
  },
  pause: {
    variant: "fill",
    elements: [rect(6, 4, 4.5, 16, 1), rect(13.5, 4, 4.5, 16, 1)],
  },
  seekBack15: {
    elements: [path("M12 4.9 a7.1 7.1 0 1 1 -6.6 4.5"), path("M4.1 3.9 L5.5 9.6 L11.1 8.1"), text(12, 15.2, "15")],
  },
  seekForward30: {
    elements: [path("M12 4.9 a7.1 7.1 0 1 0 6.6 4.5"), path("M19.9 3.9 L18.5 9.6 L12.9 8.1"), text(12, 15.2, "30")],
  },

  // ── Admin registry "reset to default" (SettingField/SettingsCategoryCard)
  // — a distinct glyph from the seek buttons above (arc + small arrowhead,
  // no numeral), also drawn in the prototype. ────────────────────────────
  reset: {
    elements: [path("M4 12 a8 8 0 1 0 3-6.2"), path("M4 4 L4 7.5 L7.5 7.5")],
  },

  // ── Music mini-player track skip (MiniPlayerBar) — filled triangle+bar,
  // same family as play/pause. ───────────────────────────────────────────
  skipBack: {
    variant: "fill",
    elements: [path("M18 5 L8 12 L18 19 Z"), rect(5, 5, 2.5, 14)],
  },
  skipForward: {
    variant: "fill",
    elements: [path("M6 5 L16 12 L6 19 Z"), rect(16.5, 5, 2.5, 14)],
  },
};
