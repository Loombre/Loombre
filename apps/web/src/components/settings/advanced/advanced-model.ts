// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/advanced/advanced-model.ts
//
// UIFIX-2026-08-29 Lane K (Settings › Advanced rework): the PURE decision
// layer behind the three-pane workbench — merge, scope filtering, search,
// rail counts, context/empty copy, the dotted-prefix split and the
// inline-vs-drawer breakpoint arithmetic. No React, no I/O, no clock, so
// every rule below is unit-testable on its own (same posture as
// lib/settings-schema-widget.ts, which stays the WIDGET brain this module
// composes with rather than duplicates: resolveWidgetKind /
// validateAgainstJsonSchema / isAtDefault / describeLocked / isEditable /
// formatSettingValue all still live there).
//
// Two responses, merged HERE (D-4 §3.4): GET /admin/settings/schema carries
// the registry projection with no live value; GET /admin/settings carries
// value + source + locked + the page-level restartPendingKeys. Neither is
// self-sufficient and the server never merges them.

import {
  isAtDefault,
  isEditable,
  resolveWidgetKind,
  type JsonSchemaLike,
  type SettingsWidgetKind,
} from "../../../lib/settings-schema-widget.js";
import type { components } from "@loombre/sdk";

type AdminSettingSchemaEntry = components["schemas"]["AdminSettingSchemaEntry"];
type AdminSettingValue = components["schemas"]["AdminSettingValue"];
type SettingsValueSource = components["schemas"]["SettingsValueSource"];

/** One key, schema and live value already reconciled. Every field here is
 *  either straight off the wire or derived from it — nothing is invented
 *  (UD-4): no unit map (UD-20a DROPPED them: the prototype's 22 unit
 *  suffixes have no registry, contract or SDK backing), no synthesised
 *  technicalDetails, no client-side secret mask (the server masks
 *  `database.url` before serialisation — settings.service.ts's
 *  maskSecretValue — so a secret arrives already-masked and renders as
 *  served). */
export interface AdvancedEntry {
  key: string;
  category: string;
  categoryLabel: string;
  description: string;
  caution?: string;
  technicalDetails?: string;
  envVar?: string;
  scope: AdminSettingSchemaEntry["scope"];
  requiresRestart: boolean;
  defaultValue: unknown;
  valueSchema: JsonSchemaLike;
  locked: boolean;
  lockedBy?: string;
  value: unknown;
  source: SettingsValueSource;
  widget: SettingsWidgetKind;
  /** scope 'ui' AND no active env pin — lib/settings-schema-widget.ts's own
   *  isEditable(), not a second rule. */
  editable: boolean;
  /** Differs from the registry default AND is actually editable. A
   *  read-only key can never read as "changed by me" — it is not yours to
   *  have changed. */
  modified: boolean;
  /** Everything up to and INCLUDING the last dot, dimmed
   *  (--color-text-subtle, UD-20f). D-5 anomaly A9: the prototype's
   *  shortName() stripped only the FIRST segment, so the registry's one
   *  three-segment key (stash.sync.scheduleIntervalMs) rendered a bright
   *  "sync.scheduleIntervalMs" leaf against a "stash." prefix. Splitting on
   *  the LAST dot is the rule the dotted-prefix device actually means. */
  prefix: string;
  leaf: string;
}

export type AdvancedScope =
  | { type: "all" }
  | { type: "mod" }
  | { type: "env" }
  | { type: "cat"; id: string };

/** Pane geometry (UD-20d — spacing SNAPS TO TOKENS, so the prototype's
 *  off-scale 20px pane gap becomes --space-lg/24px and the threshold moves
 *  with it: 230 + 24 + 352 + 24 + 520 = 1150, not the prototype's 1142).
 *  TABLE_MIN_INLINE is breakpoint arithmetic only — the CSS floor the table
 *  actually carries is ROW_MIN_WIDTH below. */
export const RAIL_WIDTH = 230;
export const PANE_GAP = 24;
export const DETAIL_WIDTH = 352;
export const TABLE_MIN_INLINE = 520;
export const INLINE_MIN = RAIL_WIDTH + PANE_GAP + DETAIL_WIDTH + PANE_GAP + TABLE_MIN_INLINE;

/** The key table's own horizontal floor: below this the pane scrolls
 *  sideways rather than crushing column 1 to nothing. */
export const ROW_MIN_WIDTH = 430;

/**
 * Inline detail panel (wide) vs. fixed drawer + scrim (narrow).
 *
 * `availW` is the WORK AREA's INNER width — clientWidth minus its own left
 * and right padding — never the viewport's. AppShell's sidebar sits OUTSIDE
 * this component and is 210px at desktop but 76px collapsed (≤1279.98px),
 * so a viewport media query would be wrong by a number that itself changes
 * at a different breakpoint. Hence a ResizeObserver, per UD-20d.
 *
 * 0 means "not measured yet" and counts as wide: first paint renders the
 * three-pane shape rather than flashing a drawer open.
 */
export function isWideLayout(availW: number): boolean {
  return availW === 0 || availW >= INLINE_MIN;
}

/** clientWidth includes the element's own padding; the panes do not. */
export function innerWidthOf(clientWidth: number, paddingLeft: number, paddingRight: number): number {
  return Math.round(clientWidth - paddingLeft - paddingRight);
}

function splitKey(key: string): { prefix: string; leaf: string } {
  const cut = key.lastIndexOf(".");
  if (cut < 0) return { prefix: "", leaf: key };
  return { prefix: key.slice(0, cut + 1), leaf: key.slice(cut + 1) };
}

/**
 * Reconciles the two responses into one row list, in registry (wire) order.
 *
 * A schema entry with no matching value row is DROPPED — the same posture
 * SettingsCategoryCard.tsx already had — but the caller is handed the count
 * so the "N of M" copy can never claim rows it isn't showing.
 */
export function mergeEntries(
  schemaEntries: readonly AdminSettingSchemaEntry[],
  values: readonly AdminSettingValue[],
  labelFor: (category: string) => string,
): AdvancedEntry[] {
  const byKey = new Map(values.map((v) => [v.key, v] as const));
  const out: AdvancedEntry[] = [];
  for (const entry of schemaEntries) {
    const live = byKey.get(entry.key);
    if (!live) continue;
    const lockable = {
      scope: entry.scope,
      locked: live.locked,
      ...(entry.envVar !== undefined ? { envVar: entry.envVar } : {}),
      ...(live.lockedBy !== undefined ? { lockedBy: live.lockedBy } : {}),
    };
    const editable = isEditable(lockable);
    const valueSchema = entry.valueSchema as unknown as JsonSchemaLike;
    const { prefix, leaf } = splitKey(entry.key);
    out.push({
      key: entry.key,
      category: entry.category,
      categoryLabel: labelFor(entry.category),
      description: entry.description,
      ...(entry.caution !== undefined ? { caution: entry.caution } : {}),
      ...(entry.technicalDetails !== undefined ? { technicalDetails: entry.technicalDetails } : {}),
      ...(entry.envVar !== undefined ? { envVar: entry.envVar } : {}),
      scope: entry.scope,
      requiresRestart: entry.requiresRestart,
      defaultValue: entry.default,
      valueSchema,
      locked: live.locked,
      ...(live.lockedBy !== undefined ? { lockedBy: live.lockedBy } : {}),
      value: live.value,
      source: live.source,
      widget: resolveWidgetKind(valueSchema),
      editable,
      modified: editable && !isAtDefault(live.value, entry.default),
      prefix,
      leaf,
    });
  }
  return out;
}

/** Which control the VALUE cell renders. Derived from the SCHEMA, never
 *  from the committed value's length — D-5 defect D2: the prototype's
 *  `kind === "text" && String(value).length <= 24` test, evaluated against
 *  a value it re-committed on every keystroke, unmounted the input mid-edit
 *  the moment a 25th character landed, losing focus and caret. Widget kind
 *  is a property of the key, so it cannot flip while you type. */
export type RowEditorKind = "switch" | "number" | "text" | "summary";

export function rowEditorKind(entry: AdvancedEntry): RowEditorKind {
  if (!entry.editable) return "summary";
  switch (entry.widget) {
    case "boolean":
      return "switch";
    case "number":
      return "number";
    case "string":
      return "text";
    default:
      // enum + structured open the detail panel: neither fits a 204px cell.
      return "summary";
  }
}

/** Case-insensitive substring over key · description · CATEGORY LABEL.
 *  The third leg is why this lives here and not in
 *  lib/settings-schema-widget.ts's matchesRegistryQuery, which covers only
 *  key + description and is shared with surfaces that have no label map;
 *  that util is deliberately left untouched. */
export function matchesAdvancedQuery(entry: AdvancedEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    entry.key.toLowerCase().includes(q) ||
    entry.description.toLowerCase().includes(q) ||
    entry.categoryLabel.toLowerCase().includes(q)
  );
}

/**
 * The visible row set. A non-empty query OVERRIDES the scope entirely
 * (never combines with it) and searches every key including the read-only
 * ones — the same semantics the shipping page already had, and the reason
 * selecting a rail item clears the query (see `selectScope` in the view).
 */
export function visibleEntries(
  entries: readonly AdvancedEntry[],
  scope: AdvancedScope,
  query: string,
): AdvancedEntry[] {
  if (query.trim().length > 0) return entries.filter((e) => matchesAdvancedQuery(e, query));
  switch (scope.type) {
    case "all":
      return entries.filter((e) => e.editable);
    case "mod":
      return entries.filter((e) => e.modified);
    case "env":
      return entries.filter((e) => !e.editable);
    case "cat":
      return entries.filter((e) => e.category === scope.id && e.editable);
  }
}

/** The dotted prefix is a WAYFINDING device: it only earns its place when
 *  the list spans more than one category. Inside a single category every
 *  row would repeat the same prefix, so the full key renders bright. */
export function showsKeyPrefix(scope: AdvancedScope, query: string): boolean {
  return query.trim().length > 0 || scope.type !== "cat";
}

export interface RailCategory {
  category: string;
  label: string;
  /** Editable keys in this category. */
  count: number;
  /** True when the category has NO editable key at all — the rail renders
   *  the literal "env" instead of a number and dims the row. */
  envOnly: boolean;
  hasModified: boolean;
}

/** Categories in REGISTRY RUNTIME ORDER (first-seen over the wire's own
 *  entry order — database, network, paths, ffmpeg, transcode, …), which is
 *  the order the server projects and the order groupByCategory preserves.
 *  Deliberately NOT the prototype's hand-authored CATS order, nor the
 *  SettingsCategory type-union order, nor the old pill row's
 *  alphabetical-by-label sort (D-4 anomaly 9: four orderings were in play). */
export function railCategories(entries: readonly AdvancedEntry[]): RailCategory[] {
  const order: string[] = [];
  const buckets = new Map<string, AdvancedEntry[]>();
  for (const entry of entries) {
    let bucket = buckets.get(entry.category);
    if (!bucket) {
      bucket = [];
      buckets.set(entry.category, bucket);
      order.push(entry.category);
    }
    bucket.push(entry);
  }
  return order.map((category) => {
    const own = buckets.get(category)!.filter((e) => e.editable);
    return {
      category,
      label: buckets.get(category)![0]!.categoryLabel,
      count: own.length,
      envOnly: own.length === 0,
      hasModified: own.some((e) => e.modified),
    };
  });
}

export interface ScopeCounts {
  all: number;
  modified: number;
  envLocked: number;
  categories: number;
}

export function scopeCounts(entries: readonly AdvancedEntry[]): ScopeCounts {
  return {
    all: entries.filter((e) => e.editable).length,
    modified: entries.filter((e) => e.modified).length,
    envLocked: entries.filter((e) => !e.editable).length,
    categories: railCategories(entries).length,
  };
}

export interface ContextCopy {
  title: string;
  meta: string;
}

/** Toolbar copy. Every count is derived — D-5 anomaly A8: the prototype
 *  hardcoded "58" into the search placeholder and "16 categories" into this
 *  line, both of which start lying the moment the registry changes. */
export function contextCopy(
  entries: readonly AdvancedEntry[],
  visible: readonly AdvancedEntry[],
  scope: AdvancedScope,
  query: string,
): ContextCopy {
  const q = query.trim();
  if (q.length > 0) {
    return { title: `Results for “${q}”`, meta: `${visible.length} of ${entries.length} settings match` };
  }
  const counts = scopeCounts(entries);
  switch (scope.type) {
    case "all":
      return { title: "All settings", meta: `${visible.length} keys · ${counts.categories} categories` };
    case "mod":
      return {
        title: "Changed by me",
        meta: visible.length === 0 ? "nothing differs from default" : `${visible.length} differ from default`,
      };
    case "env":
      return { title: "Env-locked", meta: `${visible.length} read-only keys` };
    case "cat": {
      const label = entries.find((e) => e.category === scope.id)?.categoryLabel ?? scope.id;
      const changed = visible.filter((e) => e.modified).length;
      const keys = `${visible.length} ${visible.length === 1 ? "key" : "keys"}`;
      return { title: label, meta: changed > 0 ? `${keys} · ${changed} changed` : keys };
    }
  }
}

export interface EmptyCopy {
  title: string;
  hint: string;
}

export function emptyCopy(scope: AdvancedScope, query: string): EmptyCopy {
  const q = query.trim();
  if (q.length > 0) {
    return { title: "No match", hint: `No setting name, description or category matches “${q}”.` };
  }
  if (scope.type === "mod") {
    return { title: "Nothing changed", hint: "Every setting on this server is still at its default value." };
  }
  return { title: "Nothing here", hint: "This view has no keys to show." };
}

/** The Source fact row (UD-20b: the DEFAULT row renders the wire `default`
 *  for every key — the prototype's "chosen from your OS" copy for the two
 *  platformDerivedDefault keys is DROPPED because that flag never reaches
 *  the browser at all). `source` itself IS on the wire; this only turns it
 *  into words. */
export type SourceTone = "environment" | "changed" | "default";

export function sourceCopy(entry: AdvancedEntry): { text: string; tone: SourceTone } {
  if (!entry.editable) return { text: "environment", tone: "environment" };
  if (entry.modified) return { text: "changed from default", tone: "changed" };
  return { text: "default", tone: "default" };
}
