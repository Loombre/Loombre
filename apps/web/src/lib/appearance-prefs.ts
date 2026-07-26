// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/appearance-prefs.ts
//
// Wave 2 L7 (accent + scanlines user preferences, README "Design tokens →
// Accent as a user preference" / "Other"): client-persisted only, NOT the
// server's user_settings.prefs JSONB column (CLAUDE.md invariant 3 /
// packages/db/schema.sql:29's whitelist) — ground-truthed against
// apps/server/src/catalog/users.controller.ts's GET/PUT /users/me/settings
// (Addendum A's UserSettings shape) before writing this file:
//   1. openapi.yaml's UserSettings schema has `additionalProperties: false`
//      and no generic prefs bucket — only named fields (theme, locale,
//      subtitle/audioPreferredLanguage, autoplayNextEpisode), none of which
//      fit "accent"/"scanlines".
//   2. PUT /users/me/settings is a COMPLETE STUB today (that controller's
//      own comment: "Phase 1 has no typed columns for the free-form
//      preference fields this schema documents... echoing the current
//      settings back keeps this endpoint idempotent-safe rather than
//      silently discarding a client's write with no persistence at all")
//      — it never reads or writes user_settings.prefs at all, for ANY
//      key, including the ones the schema already names (theme is stuck
//      the same way — STATE.md Phosphor Open already tracks it as a gap).
// This is exactly the case the lane brief's hard line names: "no contract
// changes unless the prefs mechanism genuinely lacks a slot for two small
// keys — then STOP and report." It does lack one (the contract shape AND
// the server-side persistence are both missing, not just these two keys),
// so this lane stops at that boundary instead of opening UserSettings up
// or bolting on server persistence unasked. Logged as an open item in the
// freeze report for whoever eventually wires real user_settings.prefs
// read/write.
//
// What this file does instead: the same class of client-only persistence
// auth-store.ts already uses for serverUrl/refreshToken/deviceId (a
// localStorage-backed store, SSR-safe, corrupt-data-safe), applied as a
// pair of root-level attributes so every consumer is CSS-only — no
// per-component JS branch anywhere (see tokens.css's `[data-accent]`
// rules and `[data-scanlines="off"]` rule, and AmbientHero/AmbientBackdrop
// for the two real hero/scene-artwork consumers). Amber + scanlines-on
// are :root's own defaults already, so the common case (fresh browser, no
// preference ever set) never touches the DOM and never flashes.

const STORAGE_KEY = "loombre.appearance.v1";

export type AccentName = "amber" | "lime" | "mint" | "blue";

export interface AppearancePrefs {
  accent: AccentName;
  /** Default true (README "Other": "opacity toggled by a `scanlines`
   *  boolean prop (default on)"). */
  scanlines: boolean;
}

/** README "Accent as a user preference" — hex values live in tokens.css's
 *  `[data-accent]` rules; this map is for the settings-row swatches only
 *  (it never touches the DOM itself). */
export const ACCENT_HEX: Record<AccentName, string> = {
  amber: "#FFB454",
  lime: "#CDF34C",
  mint: "#4CE0B3",
  blue: "#8AB8FF",
};

export const ACCENT_NAMES: readonly AccentName[] = ["amber", "lime", "mint", "blue"];

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = { accent: "amber", scanlines: true };

function isAccentName(value: unknown): value is AccentName {
  return typeof value === "string" && (ACCENT_NAMES as readonly string[]).includes(value);
}

export function getAppearancePrefs(): AppearancePrefs {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE_PREFS;
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs>;
    return {
      accent: isAccentName(parsed.accent) ? parsed.accent : DEFAULT_APPEARANCE_PREFS.accent,
      scanlines: typeof parsed.scanlines === "boolean" ? parsed.scanlines : DEFAULT_APPEARANCE_PREFS.scanlines,
    };
  } catch {
    return DEFAULT_APPEARANCE_PREFS;
  }
}

function writeAppearancePrefs(prefs: AppearancePrefs): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

/** Sets the root-level attributes tokens.css's rules key off — the ONLY
 *  place either preference touches the DOM. Non-default values only: a
 *  fresh browser with no preference ever set writes nothing at all. */
export function applyAppearancePrefs(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (prefs.accent === DEFAULT_APPEARANCE_PREFS.accent) {
    root.removeAttribute("data-accent");
  } else {
    root.setAttribute("data-accent", prefs.accent);
  }
  if (prefs.scanlines) {
    root.removeAttribute("data-scanlines");
  } else {
    root.setAttribute("data-scanlines", "off");
  }
}

/** Reads + applies in one call — what the root lifecycle effect
 *  (AppProviders.tsx) wants on mount. */
export function loadAndApplyAppearancePrefs(): AppearancePrefs {
  const prefs = getAppearancePrefs();
  applyAppearancePrefs(prefs);
  return prefs;
}

/** Merge-patch, persist, and apply in one call — what the settings-row
 *  component's swatch/toggle handlers want. */
export function setAppearancePrefs(patch: Partial<AppearancePrefs>): AppearancePrefs {
  const next: AppearancePrefs = { ...getAppearancePrefs(), ...patch };
  writeAppearancePrefs(next);
  applyAppearancePrefs(next);
  return next;
}
