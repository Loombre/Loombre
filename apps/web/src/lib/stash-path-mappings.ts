// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/stash-path-mappings.ts
//
// STATE.md Stash run, FX1 (admin web UI): pure, framework-free state logic
// behind the Stash path-mapping editor (GET/PUT /admin/libraries/{id}/
// stash-path-mappings — wholesale replace, AdminStashPathMapping
// {stashPrefix, loombrePrefix}[]). Mirrors lib/library-provider-chain.ts's
// own split exactly: the component holds ONLY `rows: MappingDraftRow[]` in
// React state and calls the pure functions below for every mutation (add,
// remove, reorder via the same up/down-button convention
// ProviderChainEditor.tsx already established for a per-library admin
// list, keyboard-accessible without a drag library), so the array logic is
// implemented exactly once and is directly unit-testable without a
// component-rendering harness.
//
// `key` is a LOCAL-ONLY synthetic id (same rationale as ChainDraftEntry's
// own `key`) — two rows can legally carry identical prefixes while being
// edited (the admin retyping one before deleting the other), so `key`
// alone gives React a stable per-ROW identity independent of the row's
// (possibly duplicate, possibly empty-in-progress) field values.
//
// Display order is admin-only bookkeeping: AdminStashPathMappings's own
// schema comment is explicit that matching is longest-prefix-wins,
// independent of this order (K10) — reordering exists so an admin can
// group/organize their own mapping table, never to influence which
// mapping a given Stash path resolves through.

export interface MappingDraftRow {
  key: string;
  stashPrefix: string;
  loombrePrefix: string;
}

export interface MappingWireInput {
  stashPrefix: string;
  loombrePrefix: string;
}

let fallbackKeyCounter = 0;

function makeKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackKeyCounter += 1;
  return `mapping-row-${fallbackKeyCounter}`;
}

/** Builds the editor's initial draft state from a GET (or PUT response)
 *  payload's `mappings` array, preserving server order. */
export function draftFromMappings(mappings: readonly MappingWireInput[]): MappingDraftRow[] {
  return mappings.map((m) => ({ key: makeKey(), stashPrefix: m.stashPrefix, loombrePrefix: m.loombrePrefix }));
}

export function addMappingRow(rows: readonly MappingDraftRow[]): MappingDraftRow[] {
  return [...rows, { key: makeKey(), stashPrefix: "", loombrePrefix: "" }];
}

export function removeMappingRowAt(rows: readonly MappingDraftRow[], index: number): MappingDraftRow[] {
  if (index < 0 || index >= rows.length) return [...rows];
  return rows.filter((_, i) => i !== index);
}

/** Pure array move — see library-provider-chain.ts's moveEntry for the
 *  identical rationale (this is the one reorder primitive both the
 *  up/down buttons call). Out-of-range or no-op moves return a new,
 *  unchanged-content array. */
export function moveMappingRow(rows: readonly MappingDraftRow[], fromIndex: number, toIndex: number): MappingDraftRow[] {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= rows.length || toIndex < 0 || toIndex >= rows.length) {
    return [...rows];
  }
  const next = [...rows];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

export function moveMappingRowUp(rows: readonly MappingDraftRow[], index: number): MappingDraftRow[] {
  return moveMappingRow(rows, index, Math.max(0, index - 1));
}

export function moveMappingRowDown(rows: readonly MappingDraftRow[], index: number): MappingDraftRow[] {
  return moveMappingRow(rows, index, Math.min(rows.length - 1, index + 1));
}

export function updateMappingRowField(
  rows: readonly MappingDraftRow[],
  index: number,
  field: "stashPrefix" | "loombrePrefix",
  value: string,
): MappingDraftRow[] {
  return rows.map((row, i) => (i === index ? { ...row, [field]: value } : row));
}

function isCompleteRow(row: MappingDraftRow): boolean {
  return row.stashPrefix.trim().length > 0 && row.loombrePrefix.trim().length > 0;
}

/** Every row has both prefixes filled in — the Save button's gate (the
 *  real PUT 422s on an empty prefix; this catches it client-side first,
 *  same "inline validation" posture SettingField's registry editor
 *  takes). An empty table (rows.length === 0) is valid — it wholesale-
 *  clears the mapping table, a legitimate admin action. */
export function mappingsAreValid(rows: readonly MappingDraftRow[]): boolean {
  return rows.every(isCompleteRow);
}

/** Only the fully-filled-in rows, wire-shaped — what the live preview
 *  debounce sends. A row the admin just added (or is mid-edit on) is
 *  silently excluded rather than firing a request that would 422, so
 *  typing a new mapping doesn't flash an error on every keystroke before
 *  the second field is filled in. */
export function completeMappingsOnly(rows: readonly MappingDraftRow[]): MappingWireInput[] {
  return rows.filter(isCompleteRow).map((row) => ({ stashPrefix: row.stashPrefix, loombrePrefix: row.loombrePrefix }));
}

/** The PUT request body's `mappings` array — `key` is draft-local and
 *  never sent. */
export function toWireMappings(rows: readonly MappingDraftRow[]): MappingWireInput[] {
  return rows.map((row) => ({ stashPrefix: row.stashPrefix, loombrePrefix: row.loombrePrefix }));
}

/** Whether `current`'s wire-relevant shape differs from `original` — same
 *  dirty-gate rationale as library-provider-chain.ts's chainIsDirty. */
export function mappingsAreDirty(original: readonly MappingDraftRow[], current: readonly MappingDraftRow[]): boolean {
  const a = toWireMappings(original);
  const b = toWireMappings(current);
  if (a.length !== b.length) return true;
  return a.some((row, i) => row.stashPrefix !== b[i]!.stashPrefix || row.loombrePrefix !== b[i]!.loombrePrefix);
}
