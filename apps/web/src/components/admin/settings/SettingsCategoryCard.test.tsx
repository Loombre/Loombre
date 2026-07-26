// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/SettingsCategoryCard.test.tsx

import { afterEach, describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { CATEGORY_LABELS, SettingsCategoryCard } from "./SettingsCategoryCard.js";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type AdminSettingSchemaEntry = components["schemas"]["AdminSettingSchemaEntry"];
type AdminSettingValue = components["schemas"]["AdminSettingValue"];

const HEVC_ENTRY: AdminSettingSchemaEntry = {
  key: "transcode.hevcEncodePreferred",
  category: "transcode",
  description: "Prefer HEVC over H.264 when hardware supports it.",
  scope: "ui",
  requiresRestart: false,
  default: true,
  valueSchema: { type: "boolean" } as unknown as AdminSettingSchemaEntry["valueSchema"],
  locked: false,
};

function valueOf(entry: AdminSettingSchemaEntry, value: unknown, source: AdminSettingValue["source"]): AdminSettingValue {
  return { key: entry.key, value, source, requiresRestart: entry.requiresRestart, locked: false };
}

describe("SettingsCategoryCard", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("uses CATEGORY_LABELS for the header title and shows a derived key count by default", () => {
    const valuesByKey = new Map([[HEVC_ENTRY.key, valueOf(HEVC_ENTRY, true, "default")]]);
    view = renderIntoBody(
      <SettingsCategoryCard category="transcode" entries={[HEVC_ENTRY]} valuesByKey={valuesByKey} onChanged={() => {}} />,
    );
    expect(view.container.textContent).toContain(CATEGORY_LABELS["transcode"]);
    expect(view.container.textContent).toContain("1 key");
  });

  it("titleOverride/metaOverride replace the category-derived header (the cross-category 'Filter results' view)", () => {
    const valuesByKey = new Map([[HEVC_ENTRY.key, valueOf(HEVC_ENTRY, true, "default")]]);
    view = renderIntoBody(
      <SettingsCategoryCard
        category="transcode"
        entries={[HEVC_ENTRY]}
        valuesByKey={valuesByKey}
        onChanged={() => {}}
        titleOverride="Filter results"
        metaOverride="1 of 34 advanced keys match"
      />,
    );
    expect(view.container.textContent).toContain("Filter results");
    expect(view.container.textContent).toContain("1 of 34 advanced keys match");
    expect(view.container.textContent).not.toContain(CATEGORY_LABELS["transcode"]);
  });

  it("shows the empty message (never a crash) when entries is empty, honoring a custom emptyMessage", () => {
    view = renderIntoBody(
      <SettingsCategoryCard
        category="transcode"
        entries={[]}
        valuesByKey={new Map()}
        onChanged={() => {}}
        titleOverride="Filter results"
        emptyMessage='No key matches “xyz”.'
      />,
    );
    expect(view.container.textContent).toContain("No key matches “xyz”.");
  });

  it("does not render a 'Reset category' button when every entry is already at its default", () => {
    const valuesByKey = new Map([[HEVC_ENTRY.key, valueOf(HEVC_ENTRY, true, "default")]]);
    view = renderIntoBody(
      <SettingsCategoryCard category="transcode" entries={[HEVC_ENTRY]} valuesByKey={valuesByKey} onChanged={() => {}} />,
    );
    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(buttons.some((b) => b.textContent?.includes("Reset category"))).toBe(false);
  });

  it("renders a 'Reset category' button once a database-sourced override differs from the default", () => {
    const valuesByKey = new Map([[HEVC_ENTRY.key, valueOf(HEVC_ENTRY, false, "database")]]);
    view = renderIntoBody(
      <SettingsCategoryCard category="transcode" entries={[HEVC_ENTRY]} valuesByKey={valuesByKey} onChanged={() => {}} />,
    );
    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(buttons.some((b) => b.textContent?.includes("Reset category"))).toBe(true);
  });
});
