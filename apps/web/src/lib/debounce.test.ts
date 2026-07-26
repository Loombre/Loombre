// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/debounce.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce.js";

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses rapid calls into exactly one trailing invocation", () => {
    const spy = vi.fn();
    const debounced = debounce(spy, 250);

    debounced("a");
    vi.advanceTimersByTime(100);
    debounced("b");
    vi.advanceTimersByTime(100);
    debounced("c");
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("c");
  });

  it("fires again after the wait elapses following a settled call", () => {
    const spy = vi.fn();
    const debounced = debounce(spy, 250);

    debounced("first");
    vi.advanceTimersByTime(250);
    expect(spy).toHaveBeenCalledTimes(1);

    debounced("second");
    vi.advanceTimersByTime(250);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith("second");
  });

  it("cancel() suppresses a pending trailing call", () => {
    const spy = vi.fn();
    const debounced = debounce(spy, 250);

    debounced("x");
    debounced.cancel();
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
  });
});
