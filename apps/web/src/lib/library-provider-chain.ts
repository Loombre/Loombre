// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/library-provider-chain.ts
//
// Lane W5b: pure, framework-free state logic behind the admin Libraries
// page's provider-chain editor (GET/PUT /admin/libraries/{id}/provider-chain).
// Kept React-free (mirrors lib/plugin-manifest.ts's/lib/plugin-wizard-state.ts's
// own header rationale — directly unit-testable without a component-
// rendering harness) — the component layer (ProviderChainEditor.tsx) holds
// ONLY `entries: ChainDraftEntry[]` in React state and calls the pure
// functions below for every mutation (reorder via HTML5 drag OR the
// keyboard-accessible up/down buttons, add, remove), so both interaction
// paths go through the exact same, exactly-once-implemented array logic.
//
// `key` on ChainDraftEntry is a LOCAL-ONLY synthetic id (crypto.randomUUID
// where available, else a counter fallback) — the same real builtin name or
// plugin id can legally appear more than once in a chain (packages/db's
// library_provider_entries has no uniqueness constraint on builtin_name/
// plugin_id, only on `position`), so `key` exists purely to give React (and
// the drag/reorder handlers) a stable per-ROW identity that survives a
// duplicate-value chain without collapsing two rows into one.

export type ChainProviderKind = "builtin" | "plugin";

export interface ChainDraftEntry {
  key: string;
  providerKind: ChainProviderKind;
  /** Non-null iff providerKind === 'builtin'. */
  builtinName: string | null;
  /** Non-null iff providerKind === 'plugin'. */
  pluginId: string | null;
  /** Display label only (the builtin name, or the plugin's CURRENT name at
   *  the time this draft was built/added) — never sent to the server. */
  label: string;
}

export interface ChainEntryWireInput {
  providerKind: ChainProviderKind;
  builtinName?: string;
  pluginId?: string;
}

/** Shape this module reads FROM the GET/PUT response — a structural subset
 *  of AdminLibraryProviderChainEntryDto (apps/server/src/plugins/
 *  admin-library-provider-chain-dto.ts), matched loosely so this file never
 *  needs to import the generated SDK types (same "hand-shaped input,
 *  structurally compatible" posture lib/plugin-manifest.ts's own header
 *  documents). */
export interface ChainEntrySource {
  providerKind: ChainProviderKind;
  builtinName: string | null;
  pluginId: string | null;
  plugin: { name: string } | null;
}

let fallbackKeyCounter = 0;

function makeKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackKeyCounter += 1;
  return `chain-entry-${fallbackKeyCounter}`;
}

function labelFor(entry: ChainEntrySource): string {
  if (entry.providerKind === "builtin") return entry.builtinName ?? "(unknown built-in)";
  return entry.plugin?.name ?? "(removed plugin)";
}

/** Builds the editor's initial draft state from a GET (or PUT response)
 *  payload's `entries` array, sorted by `position` — used identically
 *  whether isDefault is true (the synthesized legacy-default entries, shown
 *  read-only until the admin makes their first edit) or false (the real
 *  stored chain). */
export function draftFromEntries(entries: readonly (ChainEntrySource & { position: number })[]): ChainDraftEntry[] {
  return [...entries]
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({
      key: makeKey(),
      providerKind: entry.providerKind,
      builtinName: entry.builtinName,
      pluginId: entry.pluginId,
      label: labelFor(entry),
    }));
}

export function addBuiltinEntry(entries: readonly ChainDraftEntry[], builtinName: string): ChainDraftEntry[] {
  return [...entries, { key: makeKey(), providerKind: "builtin", builtinName, pluginId: null, label: builtinName }];
}

export function addPluginEntry(entries: readonly ChainDraftEntry[], plugin: { id: string; name: string }): ChainDraftEntry[] {
  return [...entries, { key: makeKey(), providerKind: "plugin", builtinName: null, pluginId: plugin.id, label: plugin.name }];
}

export function removeEntryAt(entries: readonly ChainDraftEntry[], index: number): ChainDraftEntry[] {
  if (index < 0 || index >= entries.length) return [...entries];
  return entries.filter((_, i) => i !== index);
}

/** Pure array move — the SINGLE reorder primitive both the HTML5
 *  drag-and-drop handlers and the keyboard up/down buttons call, so a
 *  pointer-drag reorder and a button-press reorder are provably the exact
 *  same operation from the state's point of view (zero new deps: no drag
 *  library, just `draggable` + dragstart/dragover/drop DOM events in the
 *  component layer feeding index pairs into this function). Out-of-range
 *  indices or a no-op move (`from === to`) return the input unchanged
 *  (a NEW array, still — callers may rely on referential identity to
 *  detect "did anything move"). */
export function moveEntry(entries: readonly ChainDraftEntry[], fromIndex: number, toIndex: number): ChainDraftEntry[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= entries.length ||
    toIndex < 0 ||
    toIndex >= entries.length
  ) {
    return [...entries];
  }
  const next = [...entries];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

/** Keyboard-accessible fallback for a drag reorder — moves the entry at
 *  `index` one slot earlier/later, clamped at the array bounds (moving the
 *  first entry up, or the last entry down, is a no-op rather than an
 *  error). */
export function moveEntryUp(entries: readonly ChainDraftEntry[], index: number): ChainDraftEntry[] {
  return moveEntry(entries, index, Math.max(0, index - 1));
}

export function moveEntryDown(entries: readonly ChainDraftEntry[], index: number): ChainDraftEntry[] {
  return moveEntry(entries, index, Math.min(entries.length - 1, index + 1));
}

/** The PUT request body's `entries` array — `position` is never included
 *  (the array index at request time IS the position, packages/contract's
 *  LibraryProviderChainEntryInput/putAdminLibraryProviderChain's own
 *  description), and only the wire-relevant fields survive (no `key`/
 *  `label`, both draft-local). */
export function toWireEntries(entries: readonly ChainDraftEntry[]): ChainEntryWireInput[] {
  return entries.map((entry) =>
    entry.providerKind === "builtin"
      ? { providerKind: "builtin", builtinName: entry.builtinName! }
      : { providerKind: "plugin", pluginId: entry.pluginId! },
  );
}

/** Whether `current`'s wire-relevant shape differs from `original` — the
 *  editor's explicit-save Button is disabled until this is true, and an
 *  admin who reorders back to the original order (or adds then removes the
 *  same entry) sees Save go inert again rather than staying permanently
 *  "dirty" the instant any handler ever fired once. */
export function chainIsDirty(original: readonly ChainDraftEntry[], current: readonly ChainDraftEntry[]): boolean {
  const a = toWireEntries(original);
  const b = toWireEntries(current);
  if (a.length !== b.length) return true;
  return a.some((entry, i) => entry.providerKind !== b[i]!.providerKind || entry.builtinName !== b[i]!.builtinName || entry.pluginId !== b[i]!.pluginId);
}
