// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-status.test.ts

import { describe, expect, it } from "vitest";
import {
  describeJobStatus,
  describeSessionStatus,
  describeStashConnectionStatus,
  describeStashSyncReportStatus,
} from "./admin-status.js";

describe("describeJobStatus", () => {
  it.each([
    ["queued", "neutral"],
    ["active", "info"],
    ["completed", "success"],
    ["failed", "danger"],
    ["cancelled", "neutral"],
  ] as const)("%s -> tone %s", (status, tone) => {
    expect(describeJobStatus(status).tone).toBe(tone);
  });

  it("falls back to a neutral pill with the raw value for an unrecognized status", () => {
    expect(describeJobStatus("some-future-status")).toEqual({ label: "some-future-status", tone: "neutral" });
  });
});

describe("describeSessionStatus", () => {
  it.each([
    ["created", "neutral"],
    ["starting", "info"],
    ["active", "success"],
    ["suspended", "warning"],
    ["seeking", "info"],
    ["ended", "neutral"],
    ["failed", "danger"],
  ] as const)("%s -> tone %s", (status, tone) => {
    expect(describeSessionStatus(status).tone).toBe(tone);
  });

  it("falls back to a neutral pill with the raw value for an unrecognized status", () => {
    expect(describeSessionStatus("some-future-status")).toEqual({ label: "some-future-status", tone: "neutral" });
  });
});

describe("describeStashConnectionStatus", () => {
  it.each([
    ["never_connected", "neutral"],
    ["ok", "success"],
    ["unreachable", "danger"],
    ["unsupported_schema", "warning"],
  ] as const)("%s -> tone %s", (status, tone) => {
    expect(describeStashConnectionStatus(status).tone).toBe(tone);
  });

  it("falls back to a neutral pill with the raw value for an unrecognized status", () => {
    expect(describeStashConnectionStatus("some-future-status")).toEqual({ label: "some-future-status", tone: "neutral" });
  });
});

describe("describeStashSyncReportStatus", () => {
  it.each([
    ["running", "info"],
    ["succeeded", "success"],
    ["partial", "warning"],
    ["failed", "danger"],
  ] as const)("%s -> tone %s", (status, tone) => {
    expect(describeStashSyncReportStatus(status).tone).toBe(tone);
  });

  it("falls back to a neutral pill with the raw value for an unrecognized status", () => {
    expect(describeStashSyncReportStatus("some-future-status")).toEqual({ label: "some-future-status", tone: "neutral" });
  });
});
