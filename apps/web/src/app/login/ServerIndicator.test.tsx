// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ServerIndicator, type ServerIndicatorProps } from "./ServerIndicator.js";
import { renderIntoBody, type TestRender } from "../../components/ui/test-render.js";

function noop(): void {
  /* no-op */
}

describe("ServerIndicator", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function renderIndicator(props: Partial<ServerIndicatorProps> = {}): TestRender {
    view = renderIntoBody(
      <ServerIndicator
        serverUrl="https://loombre.local:3001"
        showField={false}
        onShowField={noop}
        onHideField={noop}
        onChangeServerUrl={noop}
        {...props}
      />,
    );
    return view;
  }

  it("default view shows the read-only pill with host + TLS derived from the URL, no raw address input", () => {
    const { container } = renderIndicator();
    expect(container.textContent).toContain("loombre.local:3001");
    expect(container.textContent).toContain("TLS");
    expect(container.querySelector("input")).toBeNull();
  });

  it("shows NO TLS for a plain http server URL", () => {
    const { container } = renderIndicator({ serverUrl: "http://192.168.1.40:3001" });
    expect(container.textContent).toContain("NO TLS");
  });

  it("never fabricates a server name or latency the app cannot measure", () => {
    const { container } = renderIndicator();
    // The prototype fixture is "LOOMBRE-01 · 192.168.1.40:3001 · TLS · 2 MS"
    // — neither the made-up device name nor a latency figure exists here.
    expect(container.textContent).not.toMatch(/\d+\s*MS/);
    expect(container.textContent).not.toContain("LOOMBRE-01");
  });

  it("falls back to an honest empty-state label instead of guessing when there's nothing to summarize", () => {
    const { container } = renderIndicator({ serverUrl: "" });
    expect(container.textContent).toContain("No server set");
  });

  it("SWITCH reveals the real editable server-url input", () => {
    let showField = false;
    const rendered = renderIntoBody(
      <ServerIndicator
        serverUrl="https://loombre.local:3001"
        showField={showField}
        onShowField={() => {
          showField = true;
          rendered.rerender(
            <ServerIndicator
              serverUrl="https://loombre.local:3001"
              showField={showField}
              onShowField={noop}
              onHideField={noop}
              onChangeServerUrl={noop}
            />,
          );
        }}
        onHideField={noop}
        onChangeServerUrl={noop}
      />,
    );
    view = rendered;

    expect(rendered.container.querySelector("input")).toBeNull();
    const switchButton = Array.from(rendered.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Switch"),
    ) as HTMLButtonElement;

    act(() => {
      switchButton.click();
    });

    const input = rendered.container.querySelector("input#serverUrl") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("https://loombre.local:3001");
  });
});
