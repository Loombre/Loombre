// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEmptyState } from "./SearchEmptyState.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("SearchEmptyState", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("omits the RECENT row entirely on a first-ever visit (no recents yet)", () => {
    view = renderIntoBody(<SearchEmptyState recentQueries={[]} onSelectQuery={vi.fn()} />);
    expect(view.container.textContent).not.toContain("RECENT");
  });

  it("always shows the ghost SEARCH EVERYTHING treatment, with or without recents", () => {
    view = renderIntoBody(<SearchEmptyState recentQueries={[]} onSelectQuery={vi.fn()} />);
    expect(view.container.textContent).toContain("Search Everything");
  });

  it("never ships the unverifiable P95 latency claim from the prototype fixture", () => {
    view = renderIntoBody(<SearchEmptyState recentQueries={[]} onSelectQuery={vi.fn()} />);
    expect(view.container.textContent).not.toMatch(/P95/i);
    expect(view.container.textContent).not.toMatch(/100\s*MS/i);
  });

  it("renders a pill per recent query and calls onSelectQuery with it on click", () => {
    const onSelectQuery = vi.fn();
    view = renderIntoBody(<SearchEmptyState recentQueries={["sodium glow", "marrow"]} onSelectQuery={onSelectQuery} />);
    expect(view.container.textContent).toContain("RECENT");

    const pill = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "marrow") as HTMLButtonElement;
    act(() => {
      pill.click();
    });
    expect(onSelectQuery).toHaveBeenCalledWith("marrow");
  });
});
