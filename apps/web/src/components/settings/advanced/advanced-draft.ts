// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/advanced/advanced-draft.ts
//
// UIFIX-2026-08-29 Lane K: the text ⇄ value edge of the workbench, kept
// pure and separate from advanced-model.ts's filtering/copy rules.
//
// Every parse routes through lib/settings-schema-widget.ts's
// validateAgainstJsonSchema — the SAME projected JSON Schema the widget was
// chosen from — so a draft that would 422 is refused here first. D-5 defect
// D6: the prototype validated nothing except JSON parseability, so every
// documented registry bound (majorityAgeYears ≥ 18, the 1–64 and 1–100
// ranges) was described in prose and enforced nowhere.

import { formatSettingValue, validateAgainstJsonSchema } from "../../../lib/settings-schema-widget.js";
import type { AdvancedEntry } from "./advanced-model.js";

export type DraftParse = { ok: true; value: unknown } | { ok: false; message: string };

/** The editable text for a key's CURRENT value. Structured values get
 *  pretty-printed JSON (a textarea the operator can actually read);
 *  everything else its plain string form. */
export function draftTextFor(entry: AdvancedEntry, value: unknown): string {
  if (entry.widget === "structured") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}

/**
 * Turns a draft string back into a wire value for its key, or explains why
 * it cannot. Invalid structured JSON is HELD, never sent: the caller keeps
 * the raw text in the draft map, flags the field inline, and leaves the
 * last valid value in place.
 */
export function parseDraft(entry: AdvancedEntry, text: string): DraftParse {
  let candidate: unknown;
  switch (entry.widget) {
    case "boolean":
      candidate = text === "true";
      break;
    case "number": {
      if (text.trim().length === 0) return { ok: false, message: "Must be a number." };
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, message: "Must be a number." };
      candidate = n;
      break;
    }
    case "structured": {
      try {
        candidate = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, message: "Invalid JSON — not saved yet." };
      }
      break;
    }
    default:
      candidate = text;
      break;
  }
  const violation = validateAgainstJsonSchema(candidate, entry.valueSchema);
  if (violation !== null) return { ok: false, message: violation };
  return { ok: true, value: candidate };
}

/** The label on the VALUE cell's summary button (enum, structured, and
 *  every read-only key). Mirrors the prototype's fmt(): a structured value
 *  is described by shape rather than dumped into a 204px cell. */
export function summaryText(entry: AdvancedEntry, value: unknown): string {
  if (entry.widget === "structured") {
    if (Array.isArray(value)) {
      if (value.length === 0) return "empty list";
      return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
    }
    if (value !== null && typeof value === "object") return "object";
  }
  const text = formatSettingValue(value);
  return text.length === 0 ? "not set" : text;
}

/** Short, human name for a key inside toast copy — the LAST segment, the
 *  same split the dotted-prefix device uses (advanced-model.ts's `leaf`). */
export function shortName(entry: AdvancedEntry): string {
  return entry.leaf;
}
