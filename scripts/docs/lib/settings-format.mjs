// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs/lib/settings-format.mjs
//
// Addendum A, lane D1 — value-formatting helpers shared by
// gen-settings-reference.mjs and gen-env-reference.mjs. Kept separate from
// settings-titles.mjs because these operate on VALUES (defaults), not
// static presentation metadata.

/** `key`s ending in "Ms" hold millisecond durations throughout the
 *  registry (sessions.staleCutoffMs, restricted.defaultUnlockDurationMs,
 *  transcode.segmentAhead*Threshold are counts, not durations, and don't
 *  match this suffix). Renders as the largest whole unit that divides
 *  evenly, falling back to milliseconds. */
function humanizeMs(ms) {
  if (typeof ms !== "number") return String(ms);
  if (ms !== 0 && ms % 3_600_000 === 0) {
    const n = ms / 3_600_000;
    return `${n} hour${n === 1 ? "" : "s"}`;
  }
  if (ms !== 0 && ms % 60_000 === 0) {
    const n = ms / 60_000;
    return `${n} minute${n === 1 ? "" : "s"}`;
  }
  if (ms !== 0 && ms % 1000 === 0) {
    const n = ms / 1000;
    return `${n} second${n === 1 ? "" : "s"}`;
  }
  return `${ms} ms`;
}

/**
 * Renders a registry entry's default value for display. Handles the
 * handful of non-trivial shapes actually present in the registry as of
 * this writing (a plain boolean/number/string/enum covers most entries);
 * anything unrecognized falls back to JSON.stringify so a future registry
 * addition never renders as `undefined` or throws.
 */
export function formatDefaultValue(entry) {
  const { key, default: value } = entry;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (key.endsWith("Ms") && typeof value === "number") return humanizeMs(value);
  if (key === "transcode.ladderRungs" && Array.isArray(value)) {
    return `the standard quality ladder (${value.length} levels, highest first)`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    // Backticked, not bare — a bare "http://localhost:3000"-shaped string
    // in Markdown prose gets auto-linkified and then fails VitePress's
    // build-time dead-link check (a localhost URL is never reachable at
    // build time, correctly so — it isn't a real link, it's a value).
    return value.map((v) => `\`${typeof v === "string" ? v : JSON.stringify(v)}\``).join(", ");
  }
  if (value === "") return "(empty — not set)";
  if (typeof value === "object" && value !== null) return `\`${JSON.stringify(value)}\``;
  // Same auto-linkify concern applies to any scalar string default that
  // happens to look like a URL (e.g. database.url's connection string) —
  // backtick every string default, not just arrays.
  if (typeof value === "string") return `\`${value}\``;
  return String(value);
}

/** Tier-aware default line: plain "Default: X" when no tierDefaults, else
 *  one line per tier. Caller decides whether tiers need explaining (both
 *  generators link to docs/install/index.md's tier table on first use). */
export function formatDefaultWithTiers(entry) {
  if (!entry.tierDefaults) return formatDefaultValue(entry);
  const parts = [0, 1, 2]
    .filter((tier) => entry.tierDefaults[tier] !== undefined)
    .map((tier) => `${formatDefaultValue({ ...entry, default: entry.tierDefaults[tier] })} (Tier ${tier})`);
  return parts.join(" / ");
}

/**
 * Strips source-code citations from a registry description — both the
 * parenthetical form (`(apps/.../src/...)`) and the standalone trailing-
 * clause form actually present in a few registry entries ("See
 * apps/server/src/tls/config.ts.", "— see apps/server/src/cli/
 * app-paths.ts."). These are exactly what register-lint.mjs's
 * operator-guide-source-reference rule flags, and the Operator Guide's
 * audience rule is "no source-code references" (that's Developer Guide
 * territory). Spec citations like "(docs/PLAYBACK.md §9 ...)" are NOT
 * source-code paths and are deliberately left alone — they're exactly the
 * kind of traceability an operator benefits from. Only strips text that
 * actually contains an apps/ or packages/ .../src|test path.
 */
export function stripSourceCodeRefs(description) {
  const stripped = description
    // Parenthetical form: "(apps/server/src/main.ts's resolveX)".
    .replace(/\s*\([^)]*\b(?:apps|packages)\/[a-zA-Z0-9_./-]*\/(?:src|test)\b[^)]*\)/g, "")
    // Standalone trailing-clause form: "See apps/.../src/x.ts." or
    // "— see apps/.../src/x.ts." (with or without a leading em-dash).
    .replace(
      /\s*(?:—\s*)?\bSee\s+(?:apps|packages)\/[a-zA-Z0-9_./-]*\/(?:src|test)\/[a-zA-Z0-9_./-]+\.?/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
  // A stripped trailing clause sometimes takes the sentence's closing
  // punctuation with it — restore a period so the sentence doesn't just
  // trail off.
  return /[.!?]$/.test(stripped) ? stripped : `${stripped}.`;
}
