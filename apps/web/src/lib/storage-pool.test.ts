// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/storage-pool.test.ts

import { describe, expect, it } from "vitest";
import { formatStoragePoolMeter } from "./storage-pool.js";

const TB = 1024 ** 4;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("formatStoragePoolMeter", () => {
  it("formats a TB-scale pool with a rounded percent", () => {
    const result = formatStoragePoolMeter({ usedBytes: 43.1 * TB, totalBytes: 60.8 * TB });
    expect(result.unit).toBe("TB");
    expect(result.usedLabel).toBe("43.1");
    expect(result.totalLabel).toBe("60.8");
    expect(result.percent).toBe(71); // 43.1/60.8 = 70.89...% -> rounds to 71
  });

  it("scales DOWN to GB for a small instance instead of rendering '0.0 TB'", () => {
    const result = formatStoragePoolMeter({ usedBytes: 12 * GB, totalBytes: 500 * GB });
    expect(result.unit).toBe("GB");
    expect(result.usedLabel).toBe("12.0");
    expect(result.totalLabel).toBe("500.0");
    expect(result.percent).toBe(2);
  });

  it("scales down to MB for a tiny pool", () => {
    const result = formatStoragePoolMeter({ usedBytes: 10 * MB, totalBytes: 200 * MB });
    expect(result.unit).toBe("MB");
    expect(result.percent).toBe(5);
  });

  it("clamps percent to [0, 100] and never divides by zero", () => {
    expect(formatStoragePoolMeter({ usedBytes: 0, totalBytes: 0 }).percent).toBe(0);
    expect(formatStoragePoolMeter({ usedBytes: 10 * TB, totalBytes: 10 * TB }).percent).toBe(100);
  });
});
