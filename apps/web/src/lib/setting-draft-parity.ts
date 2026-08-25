// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/setting-draft-parity.ts
//
// "Is this in-progress edit still exactly the value that was loaded?" — one
// answer per widget kind, for components/admin/settings/SettingField.tsx's
// `dirty` flag.
//
// WHY (d3-e7, G/settingfield-dirty-nonbool): browser-restricted-settings-F8
// fixed this for the BOOLEAN editor and said so in its own comment —
// "unlike a keystroke on the number/string/JSON editors (where 'back to the
// original text' is rare and ambiguous to detect losslessly — e.g.
// re-typing the same number with different formatting), a boolean has
// exactly two states". Every other kind therefore kept latching
// `dirty = true` on every keystroke and segment click, so typing away and
// back left Save and Reset enabled with nothing to write — and a Save from
// that state is a real no-op write that flips the setting's source pill
// from "default" to "database" for zero actual change, which is exactly
// what F8 was filed about.
//
// The ambiguity F8 flagged is real, but it is per-KIND, not intractable:
//   * number   — compare NUMERICALLY. "1.0", " 1 " and "1e0" are all the
//                loaded 1; string equality would call each of them an edit.
//   * string   — compare exactly, against the same `String(value ?? "")`
//                seed the widget itself renders from, so an untouched field
//                is parity by construction.
//   * enum     — identity on the selected token, against the same
//                `typeof value === "string" ? value : ""` seed.
//   * boolean  — `Boolean(value)`, F8's own rule, moved here so all five
//                kinds live together.
//   * structured — DEEP equality of the parsed document, not of its text.
//                Reformatting (indentation, spacing) and object key order
//                are not changes; array order and null-vs-missing are.
//
// THE SAFE ANSWER IS ALWAYS `false`. A wrong `true` disables Save on a
// genuine edit — the admin cannot write their change and has no way to see
// why. A wrong `false` merely leaves Save enabled on a no-op, which is the
// behaviour that existed before this module. So every uncertain case
// (unparseable draft, blank numeric text, a loaded value whose type does
// not match the widget's kind) returns false rather than guessing.
//
// Pure and framework-free, like every other lib/ helper the settings
// screens lean on (settings-schema-widget.ts, admin-session-merge.ts).

/** One editor's current draft, tagged by the widget kind that produced it
 *  (lib/settings-schema-widget.ts's SettingsWidgetKind). The three text
 *  kinds share a shape but never a comparison. */
export type SettingDraft =
  | { kind: "boolean"; checked: boolean }
  | { kind: "enum"; selected: string }
  | { kind: "number"; text: string }
  | { kind: "string"; text: string }
  | { kind: "structured"; text: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural equality over JSON-shaped data: arrays compare element-wise in
 * order, objects compare as key SETS (order is a serialization detail, not
 * a value), everything else compares with `Object.is`. `null` is a value
 * here, distinct from a key being absent — `{a: null}` and `{}` differ.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualJson(item, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    // Key SETS, not key order: `{a:1,b:2}` and `{b:2,a:1}` are the same
    // document. `Object.hasOwn` rather than a truthiness check on b[key],
    // so an explicit `undefined`/`null` is not mistaken for absence.
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqualJson(a[key], b[key]));
  }

  return false;
}

/**
 * True only when `draft` provably still represents `loaded`. See this
 * module's header for the per-kind rules and for why every uncertain case
 * answers false.
 */
export function isSettingDraftAtValue(draft: SettingDraft, loaded: unknown): boolean {
  switch (draft.kind) {
    case "boolean":
      return draft.checked === Boolean(loaded);

    case "enum":
      return draft.selected === (typeof loaded === "string" ? loaded : "");

    case "number": {
      // A blank draft is not a number at all, and `Number("")` is 0 — which
      // would claim parity with a loaded 0 while the field sits empty and
      // unsavable. Refuse before converting.
      if (draft.text.trim().length === 0) return false;
      if (typeof loaded !== "number") return false;
      const parsed = Number(draft.text);
      return Number.isFinite(parsed) && parsed === loaded;
    }

    case "string":
      // The exact seed the widget renders from, so an untouched field is
      // parity without needing a separate "has the user typed yet" flag.
      return draft.text === String(loaded ?? "");

    case "structured": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.text);
      } catch {
        return false;
      }
      return deepEqualJson(parsed, loaded);
    }
  }
}
