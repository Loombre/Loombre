// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { SearchPersonGrid } from "./SearchPersonGrid.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type Person = components["schemas"]["Person"];

function makePerson(overrides: Partial<Person> = {}): Person {
  return { id: "person-1", name: "Maya Reyes", contentClass: "general", creditCount: 3, ...overrides };
}

describe("SearchPersonGrid", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("shows the real credit count as an honest substitute for the fixture's fabricated role list", () => {
    view = renderIntoBody(<SearchPersonGrid people={[makePerson({ creditCount: 3 })]} />);
    expect(view.container.textContent).toContain("3 credits");
  });

  it("uses singular 'credit' for exactly one", () => {
    view = renderIntoBody(<SearchPersonGrid people={[makePerson({ creditCount: 1 })]} />);
    expect(view.container.textContent).toContain("1 credit");
    expect(view.container.textContent).not.toContain("1 credits");
  });

  it("links to the real person route and renders the shared Avatar", () => {
    view = renderIntoBody(<SearchPersonGrid people={[makePerson()]} />);
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/people/person-1");
    expect(link?.querySelector('[role="img"]')).not.toBeNull();
  });
});
