// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/library-provider-chain.test.ts

import { describe, expect, it } from "vitest";
import {
  addBuiltinEntry,
  addPluginEntry,
  chainIsDirty,
  draftFromEntries,
  moveEntry,
  moveEntryDown,
  moveEntryUp,
  removeEntryAt,
  toWireEntries,
  type ChainDraftEntry,
} from "./library-provider-chain.js";

describe("draftFromEntries", () => {
  it("sorts by position and resolves labels (builtinName, or the resolved plugin's name)", () => {
    const draft = draftFromEntries([
      { position: 1, providerKind: "plugin", builtinName: null, pluginId: "p1", plugin: { name: "Notion Sync" } },
      { position: 0, providerKind: "builtin", builtinName: "tmdb", pluginId: null, plugin: null },
    ]);
    expect(draft.map((e) => e.label)).toEqual(["tmdb", "Notion Sync"]);
    expect(draft.map((e) => e.providerKind)).toEqual(["builtin", "plugin"]);
  });

  it("falls back to a placeholder label for a plugin entry whose plugin failed to resolve", () => {
    const draft = draftFromEntries([{ position: 0, providerKind: "plugin", builtinName: null, pluginId: "gone", plugin: null }]);
    expect(draft[0]?.label).toBe("(removed plugin)");
  });

  it("gives every entry a distinct `key`, even for two entries with the identical builtinName (no uniqueness constraint on that column)", () => {
    const draft = draftFromEntries([
      { position: 0, providerKind: "builtin", builtinName: "tmdb", pluginId: null, plugin: null },
      { position: 1, providerKind: "builtin", builtinName: "tmdb", pluginId: null, plugin: null },
    ]);
    expect(draft[0]?.key).not.toBe(draft[1]?.key);
  });
});

describe("addBuiltinEntry / addPluginEntry / removeEntryAt", () => {
  it("appends a builtin entry", () => {
    const next = addBuiltinEntry([], "tvdb");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ providerKind: "builtin", builtinName: "tvdb", pluginId: null, label: "tvdb" });
  });

  it("appends a plugin entry", () => {
    const next = addPluginEntry([], { id: "plugin-1", name: "Discord Notifier" });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ providerKind: "plugin", builtinName: null, pluginId: "plugin-1", label: "Discord Notifier" });
  });

  it("removeEntryAt removes exactly the entry at the given index, leaving the rest in order", () => {
    const chained = addBuiltinEntry(addBuiltinEntry([], "tmdb"), "tvdb");
    expect(chained).toHaveLength(2);
    const removed = removeEntryAt(chained, 0);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.builtinName).toBe("tvdb");
  });

  it("removeEntryAt is a no-op (new array, same contents) for an out-of-range index", () => {
    const entries = addBuiltinEntry([], "tmdb");
    const result = removeEntryAt(entries, 5);
    expect(result).toEqual(entries);
    expect(result).not.toBe(entries);
  });
});

describe("moveEntry / moveEntryUp / moveEntryDown", () => {
  function fixture(): ChainDraftEntry[] {
    return addBuiltinEntry(addBuiltinEntry(addBuiltinEntry([], "tmdb"), "tvdb"), "musicbrainz");
  }

  it("moveEntry swaps to the target index, preserving the other entries' relative order", () => {
    const entries = fixture();
    const moved = moveEntry(entries, 0, 2);
    expect(moved.map((e) => e.builtinName)).toEqual(["tvdb", "musicbrainz", "tmdb"]);
  });

  it("moveEntry(from, from) is a no-op", () => {
    const entries = fixture();
    const moved = moveEntry(entries, 1, 1);
    expect(moved.map((e) => e.builtinName)).toEqual(entries.map((e) => e.builtinName));
  });

  it("moveEntry with an out-of-range index returns the entries unchanged", () => {
    const entries = fixture();
    expect(moveEntry(entries, -1, 1).map((e) => e.builtinName)).toEqual(entries.map((e) => e.builtinName));
    expect(moveEntry(entries, 0, 99).map((e) => e.builtinName)).toEqual(entries.map((e) => e.builtinName));
  });

  it("moveEntryUp moves one slot earlier; clamped at index 0 (no-op for the first entry)", () => {
    const entries = fixture();
    expect(moveEntryUp(entries, 1).map((e) => e.builtinName)).toEqual(["tvdb", "tmdb", "musicbrainz"]);
    expect(moveEntryUp(entries, 0).map((e) => e.builtinName)).toEqual(entries.map((e) => e.builtinName));
  });

  it("moveEntryDown moves one slot later; clamped at the last index (no-op for the last entry)", () => {
    const entries = fixture();
    expect(moveEntryDown(entries, 1).map((e) => e.builtinName)).toEqual(["tmdb", "musicbrainz", "tvdb"]);
    expect(moveEntryDown(entries, 2).map((e) => e.builtinName)).toEqual(entries.map((e) => e.builtinName));
  });
});

describe("toWireEntries", () => {
  it("strips draft-local fields (key/label) and omits the field that doesn't apply to each providerKind", () => {
    const entries = addPluginEntry(addBuiltinEntry([], "tmdb"), { id: "plugin-1", name: "X" });
    expect(toWireEntries(entries)).toEqual([
      { providerKind: "builtin", builtinName: "tmdb" },
      { providerKind: "plugin", pluginId: "plugin-1" },
    ]);
  });

  it("[] for an empty chain (clears it — the wholesale-clear PUT payload)", () => {
    expect(toWireEntries([])).toEqual([]);
  });
});

describe("chainIsDirty", () => {
  it("false when nothing changed", () => {
    const entries = addBuiltinEntry([], "tmdb");
    expect(chainIsDirty(entries, entries)).toBe(false);
    // Also false for a structurally-identical but referentially-different draft.
    expect(chainIsDirty(entries, addBuiltinEntry([], "tmdb"))).toBe(false);
  });

  it("true after a reorder", () => {
    const entries = addBuiltinEntry(addBuiltinEntry([], "tmdb"), "tvdb");
    const reordered = moveEntry(entries, 0, 1);
    expect(chainIsDirty(entries, reordered)).toBe(true);
  });

  it("true after an add or a remove", () => {
    const entries = addBuiltinEntry([], "tmdb");
    expect(chainIsDirty(entries, addBuiltinEntry(entries, "tvdb"))).toBe(true);
    expect(chainIsDirty(entries, removeEntryAt(entries, 0))).toBe(true);
  });

  it("false again after adding then removing the same entry (back to the original shape)", () => {
    const entries = addBuiltinEntry([], "tmdb");
    const roundTripped = removeEntryAt(addBuiltinEntry(entries, "tvdb"), 1);
    expect(chainIsDirty(entries, roundTripped)).toBe(false);
  });
});
