// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/ui/DatePicker.test.tsx
//
// Typed entry (owner report, Linux reference box: "the birth date only
// works via the calendar icon"): the field accepts the shapes a person
// actually types and says why when it cannot, instead of a silent revert.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "./test-render.js";
import { DatePicker, TYPED_DATE_FORMAT_HINT, parseTypedDate } from "./DatePicker.js";

describe("parseTypedDate", () => {
  it("accepts ISO, YYYY/MM/DD, US MM/DD/YYYY (single digits too) and DD.MM.YYYY, normalising to ISO", () => {
    expect(parseTypedDate("1999-01-01")).toBe("1999-01-01");
    expect(parseTypedDate("1999/01/01")).toBe("1999-01-01");
    expect(parseTypedDate("01/01/1999")).toBe("1999-01-01");
    expect(parseTypedDate("1/1/1999")).toBe("1999-01-01");
    expect(parseTypedDate("01.01.1999")).toBe("1999-01-01");
    expect(parseTypedDate("  01/01/1999 ")).toBe("1999-01-01");
  });

  it("rejects non-dates and impossible calendar dates", () => {
    expect(parseTypedDate("")).toBeNull();
    expect(parseTypedDate("yesterday")).toBeNull();
    expect(parseTypedDate("1999-13-01")).toBeNull();
    expect(parseTypedDate("13/01/1999")).toBeNull(); // slashes are month-first; 21 is not a month
    expect(parseTypedDate("1999-02-30")).toBeNull();
  });
});

function setNativeValue(input: HTMLInputElement, next: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("DatePicker typed entry", () => {
  let view: TestRender | null = null;
  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("commits a US-shaped date on blur, normalised to ISO", () => {
    const onChange = vi.fn();
    view = renderIntoBody(<DatePicker id="bd" value="" onChange={onChange} maxDate="2026-09-07" />);
    const input = view.container.querySelector("input")!;
    act(() => setNativeValue(input, "01/01/1999"));
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("1999-01-01");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps an unparsable value and shows the format hint instead of silently reverting", () => {
    const onChange = vi.fn();
    view = renderIntoBody(<DatePicker id="bd" value="1990-01-01" onChange={onChange} maxDate="2026-09-07" />);
    const input = view.container.querySelector("input")!;
    act(() => setNativeValue(input, "Jan 1 1999"));
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("Jan 1 1999");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(TYPED_DATE_FORMAT_HINT);
  });

  it("a real date past maxDate reverts to the committed value AND says why", () => {
    const onChange = vi.fn();
    view = renderIntoBody(<DatePicker id="bd" value="1990-01-01" onChange={onChange} maxDate="2026-09-07" />);
    const input = view.container.querySelector("input")!;
    act(() => setNativeValue(input, "12/31/2030"));
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("1990-01-01");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("That date is in the future.");
  });
});
