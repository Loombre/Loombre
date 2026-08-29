// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/advanced/advanced-model.test.ts
//
// UIFIX-2026-08-29 Lane K: the pure half of the Advanced workbench — the
// two-response merge, scope filtering, the three search legs, rail counts,
// the dotted-prefix rule, toolbar/empty copy, and the inline-vs-drawer
// arithmetic. Everything here is framework-free, so it needs no DOM.

import { describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import {
  DETAIL_WIDTH,
  INLINE_MIN,
  PANE_GAP,
  RAIL_WIDTH,
  TABLE_MIN_INLINE,
  contextCopy,
  emptyCopy,
  innerWidthOf,
  isWideLayout,
  matchesAdvancedQuery,
  mergeEntries,
  railCategories,
  rowEditorKind,
  scopeCounts,
  showsKeyPrefix,
  sourceCopy,
  visibleEntries,
} from "./advanced-model.js";

type AdminSettingSchemaEntry = components["schemas"]["AdminSettingSchemaEntry"];
type AdminSettingValue = components["schemas"]["AdminSettingValue"];

const LABELS: Record<string, string> = {
  transcode: "Transcode",
  scanner: "Scanner",
  updateCheck: "Update check",
  network: "Network",
  database: "Database",
  stash: "Stash",
};

function labelFor(category: string): string {
  return LABELS[category] ?? category;
}

function schema(
  key: string,
  category: string,
  valueSchema: Record<string, unknown>,
  defaultValue: unknown,
  extra: Partial<AdminSettingSchemaEntry> = {},
): AdminSettingSchemaEntry {
  return {
    key,
    category,
    description: `What ${key} does.`,
    scope: "ui",
    requiresRestart: false,
    default: defaultValue,
    valueSchema,
    locked: false,
    ...extra,
  } as unknown as AdminSettingSchemaEntry;
}

function value(key: string, v: unknown, source: AdminSettingValue["source"], locked = false): AdminSettingValue {
  return { key, value: v, source, requiresRestart: false, locked } as unknown as AdminSettingValue;
}

const SCHEMA_ENTRIES: AdminSettingSchemaEntry[] = [
  schema("database.url", "database", { type: "string" }, "postgres://loombre:***@localhost:5442/loombre", {
    scope: "env-only",
    locked: true,
    lockedBy: "DATABASE_URL",
    envVar: "DATABASE_URL",
    requiresRestart: true,
  } as Partial<AdminSettingSchemaEntry>),
  schema("network.publicUrl", "network", { type: "string" }, ""),
  schema("network.trustProxy", "network", { type: "boolean" }, false, {
    requiresRestart: true,
  } as Partial<AdminSettingSchemaEntry>),
  schema("transcode.maxSimultaneousTranscodes", "transcode", { type: "integer", minimum: 1, maximum: 64 }, 2),
  schema("transcode.ladderRungs", "transcode", { type: "array", items: { type: "object" } }, []),
  schema("scanner.concurrency", "scanner", { type: "integer", minimum: 1, maximum: 64 }, 4),
  schema("updateCheck.mode", "updateCheck", { type: "string", enum: ["off", "manual", "daily"] }, "manual"),
  schema("stash.sync.scheduleIntervalMs", "stash", { type: "integer", minimum: 1000 }, 3_600_000),
];

const VALUES: AdminSettingValue[] = [
  value("database.url", "postgres://loombre:***@localhost:5442/loombre", "environment", true),
  value("network.publicUrl", "", "default"),
  value("network.trustProxy", true, "database"),
  value("transcode.maxSimultaneousTranscodes", 8, "database"),
  value("transcode.ladderRungs", [], "default"),
  value("scanner.concurrency", 4, "default"),
  value("updateCheck.mode", "manual", "default"),
  value("stash.sync.scheduleIntervalMs", 3_600_000, "default"),
];

const ENTRIES = mergeEntries(SCHEMA_ENTRIES, VALUES, labelFor);

describe("mergeEntries — the two responses reconciled client-side", () => {
  it("keeps wire order and pairs every schema entry with its live value + source", () => {
    expect(ENTRIES.map((e) => e.key)).toEqual(SCHEMA_ENTRIES.map((e) => e.key));
    const trust = ENTRIES.find((e) => e.key === "network.trustProxy")!;
    expect(trust.value).toBe(true);
    expect(trust.source).toBe("database");
    expect(trust.defaultValue).toBe(false);
  });

  it("drops a schema entry with no matching value row rather than rendering an empty one", () => {
    const merged = mergeEntries(SCHEMA_ENTRIES, VALUES.slice(1), labelFor);
    expect(merged).toHaveLength(SCHEMA_ENTRIES.length - 1);
    expect(merged.some((e) => e.key === "database.url")).toBe(false);
  });

  it("derives editability from scope + the live env pin, never from scope alone", () => {
    expect(ENTRIES.find((e) => e.key === "database.url")!.editable).toBe(false);
    expect(ENTRIES.find((e) => e.key === "network.publicUrl")!.editable).toBe(true);
  });

  it("marks only editable off-default keys as modified — a read-only key is never 'changed by me'", () => {
    expect(ENTRIES.find((e) => e.key === "transcode.maxSimultaneousTranscodes")!.modified).toBe(true);
    expect(ENTRIES.find((e) => e.key === "scanner.concurrency")!.modified).toBe(false);
    // database.url's env value differs from its registry default, but it is
    // not the operator's change and cannot be undone here.
    expect(ENTRIES.find((e) => e.key === "database.url")!.modified).toBe(false);
  });

  it("splits the dotted key on the LAST dot, so the one three-segment key dims both leading segments", () => {
    const stash = ENTRIES.find((e) => e.key === "stash.sync.scheduleIntervalMs")!;
    expect(stash.prefix).toBe("stash.sync.");
    expect(stash.leaf).toBe("scheduleIntervalMs");
  });

  it("renders a server-masked secret exactly as served — no client-side masking anywhere", () => {
    const db = ENTRIES.find((e) => e.key === "database.url")!;
    expect(db.value).toBe("postgres://loombre:***@localhost:5442/loombre");
    expect(db.defaultValue).toBe("postgres://loombre:***@localhost:5442/loombre");
  });
});

describe("rowEditorKind — derived from the schema, never the committed value", () => {
  it("gives every editable string an inline text field regardless of how long its value is", () => {
    const url = ENTRIES.find((e) => e.key === "network.publicUrl")!;
    expect(rowEditorKind(url)).toBe("text");
    const long = { ...url, value: "https://a-very-long-hostname.example.test/with/a/path" };
    expect(rowEditorKind(long)).toBe("text");
  });

  it("routes booleans to the switch, numbers to the number field, enums/structured/read-only to the summary", () => {
    expect(rowEditorKind(ENTRIES.find((e) => e.key === "network.trustProxy")!)).toBe("switch");
    expect(rowEditorKind(ENTRIES.find((e) => e.key === "scanner.concurrency")!)).toBe("number");
    expect(rowEditorKind(ENTRIES.find((e) => e.key === "updateCheck.mode")!)).toBe("summary");
    expect(rowEditorKind(ENTRIES.find((e) => e.key === "transcode.ladderRungs")!)).toBe("summary");
    expect(rowEditorKind(ENTRIES.find((e) => e.key === "database.url")!)).toBe("summary");
  });
});

describe("scope filtering and counts", () => {
  it("'all' shows only editable keys; 'env' shows only the read-only ones; the two partition the set", () => {
    const all = visibleEntries(ENTRIES, { type: "all" }, "");
    const env = visibleEntries(ENTRIES, { type: "env" }, "");
    expect(all).toHaveLength(7);
    expect(env.map((e) => e.key)).toEqual(["database.url"]);
    expect(all.length + env.length).toBe(ENTRIES.length);
  });

  it("'mod' shows exactly the editable off-default keys", () => {
    expect(visibleEntries(ENTRIES, { type: "mod" }, "").map((e) => e.key)).toEqual([
      "network.trustProxy",
      "transcode.maxSimultaneousTranscodes",
    ]);
  });

  it("a category scope shows that category's editable keys only", () => {
    expect(visibleEntries(ENTRIES, { type: "cat", id: "network" }, "").map((e) => e.key)).toEqual([
      "network.publicUrl",
      "network.trustProxy",
    ]);
  });

  it("scopeCounts is derived live — never a stored or hardcoded total", () => {
    expect(scopeCounts(ENTRIES)).toEqual({ all: 7, modified: 2, envLocked: 1, categories: 6 });
  });

  it("railCategories keeps registry runtime (first-seen) order and marks a no-editable-key category as env", () => {
    const rail = railCategories(ENTRIES);
    expect(rail.map((c) => c.category)).toEqual(["database", "network", "transcode", "scanner", "updateCheck", "stash"]);
    const database = rail[0]!;
    expect(database.envOnly).toBe(true);
    expect(database.count).toBe(0);
    const network = rail[1]!;
    expect(network.count).toBe(2);
    expect(network.hasModified).toBe(true);
    expect(rail.find((c) => c.category === "scanner")!.hasModified).toBe(false);
  });
});

describe("search — key, description AND category label", () => {
  it("matches on the key", () => {
    expect(matchesAdvancedQuery(ENTRIES.find((e) => e.key === "network.publicUrl")!, "publicurl")).toBe(true);
  });

  it("matches on the description", () => {
    expect(matchesAdvancedQuery(ENTRIES.find((e) => e.key === "scanner.concurrency")!, "what scanner.conc")).toBe(true);
  });

  it("matches on the human CATEGORY LABEL — the leg the shared registry util does not cover", () => {
    const mode = ENTRIES.find((e) => e.key === "updateCheck.mode")!;
    expect(mode.key.toLowerCase().includes("update check")).toBe(false);
    expect(matchesAdvancedQuery(mode, "update check")).toBe(true);
    expect(visibleEntries(ENTRIES, { type: "cat", id: "network" }, "Update check").map((e) => e.key)).toEqual([
      "updateCheck.mode",
    ]);
  });

  it("a live query OVERRIDES the scope entirely and reaches read-only keys too", () => {
    const rows = visibleEntries(ENTRIES, { type: "cat", id: "scanner" }, "database");
    expect(rows.map((e) => e.key)).toEqual(["database.url"]);
  });
});

describe("the dotted-prefix wayfinding rule", () => {
  it("shows the prefix everywhere the list spans more than one category", () => {
    expect(showsKeyPrefix({ type: "all" }, "")).toBe(true);
    expect(showsKeyPrefix({ type: "mod" }, "")).toBe(true);
    expect(showsKeyPrefix({ type: "env" }, "")).toBe(true);
  });

  it("hides it inside a single category, where every row would repeat it", () => {
    expect(showsKeyPrefix({ type: "cat", id: "network" }, "")).toBe(false);
  });

  it("brings it back for search results, which span categories again", () => {
    expect(showsKeyPrefix({ type: "cat", id: "network" }, "url")).toBe(true);
  });
});

describe("toolbar and empty copy — every count derived", () => {
  it("counts categories from the data rather than the prototype's hardcoded 16", () => {
    const rows = visibleEntries(ENTRIES, { type: "all" }, "");
    expect(contextCopy(ENTRIES, rows, { type: "all" }, "")).toEqual({
      title: "All settings",
      meta: "7 keys · 6 categories",
    });
  });

  it("reports search results against the full key count", () => {
    const rows = visibleEntries(ENTRIES, { type: "all" }, "network");
    expect(contextCopy(ENTRIES, rows, { type: "all" }, "network")).toEqual({
      title: "Results for “network”",
      meta: "2 of 8 settings match",
    });
  });

  it("names the category and its changed count", () => {
    const rows = visibleEntries(ENTRIES, { type: "cat", id: "transcode" }, "");
    expect(contextCopy(ENTRIES, rows, { type: "cat", id: "transcode" }, "")).toEqual({
      title: "Transcode",
      meta: "2 keys · 1 changed",
    });
  });

  it("says nothing differs when 'Changed by me' is empty — the common case once seeded data is gone", () => {
    expect(contextCopy([], [], { type: "mod" }, "").meta).toBe("nothing differs from default");
    expect(emptyCopy({ type: "mod" }, "")).toEqual({
      title: "Nothing changed",
      hint: "Every setting on this server is still at its default value.",
    });
    expect(emptyCopy({ type: "all" }, "zzz").title).toBe("No match");
  });
});

describe("source copy", () => {
  it("distinguishes environment / changed / default", () => {
    expect(sourceCopy(ENTRIES.find((e) => e.key === "database.url")!)).toEqual({
      text: "environment",
      tone: "environment",
    });
    expect(sourceCopy(ENTRIES.find((e) => e.key === "transcode.maxSimultaneousTranscodes")!)).toEqual({
      text: "changed from default",
      tone: "changed",
    });
    expect(sourceCopy(ENTRIES.find((e) => e.key === "scanner.concurrency")!)).toEqual({
      text: "default",
      tone: "default",
    });
  });
});

describe("inline-vs-drawer arithmetic (UD-20d)", () => {
  it("is 1150 — the token-snapped pane gap, not the prototype's off-scale 20px/1142", () => {
    expect(PANE_GAP).toBe(24);
    expect(RAIL_WIDTH + PANE_GAP + DETAIL_WIDTH + PANE_GAP + TABLE_MIN_INLINE).toBe(1150);
    expect(INLINE_MIN).toBe(1150);
  });

  it("treats an unmeasured first paint as wide, so the three-pane shape never flashes a drawer", () => {
    expect(isWideLayout(0)).toBe(true);
  });

  it("switches exactly at the threshold", () => {
    expect(isWideLayout(1149)).toBe(false);
    expect(isWideLayout(1150)).toBe(true);
  });

  it("measures INNER width — clientWidth includes the work area's own padding", () => {
    expect(innerWidthOf(1214, 32, 32)).toBe(1150);
  });
});
