// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/plugin-delivery-status.test.ts

import { describe, expect, it } from "vitest";
import { describeDeliveryStatus, NEVER_DELIVERED_HEADLINE, type PluginDeliveryStatusLike } from "./plugin-delivery-status.js";

const NOW = 1_700_000_000_000;

function fixture(overrides: Partial<PluginDeliveryStatusLike> = {}): PluginDeliveryStatusLike {
  return {
    lastAttemptMs: null,
    lastSuccessMs: null,
    consecutiveFailures: 0,
    deliveredBatches: 0,
    deliveredEvents: 0,
    gapReportedThroughMs: null,
    ...overrides,
  };
}

describe("describeDeliveryStatus", () => {
  it("headline is the never-delivered sentinel when lastSuccessMs is null, even with a row present (e.g. only failures so far)", () => {
    const summary = describeDeliveryStatus(fixture({ consecutiveFailures: 2, lastAttemptMs: NOW - 1000 }), NOW);
    expect(summary.headline).toBe(NEVER_DELIVERED_HEADLINE);
  });

  it("headline names the counts and relative last-success time once something has been delivered", () => {
    const summary = describeDeliveryStatus(
      fixture({ lastSuccessMs: NOW - 5 * 60_000, deliveredBatches: 3, deliveredEvents: 7 }),
      NOW,
    );
    expect(summary.headline).toBe("Delivered 7 events in 3 batches — last delivered 5 minutes ago.");
  });

  it("singularizes 1 event / 1 batch", () => {
    const summary = describeDeliveryStatus(fixture({ lastSuccessMs: NOW - 60_000, deliveredBatches: 1, deliveredEvents: 1 }), NOW);
    expect(summary.headline).toBe("Delivered 1 event in 1 batch — last delivered 1 minute ago.");
  });

  it("failureWarning is null when consecutiveFailures is 0", () => {
    const summary = describeDeliveryStatus(fixture({ lastSuccessMs: NOW - 60_000 }), NOW);
    expect(summary.failureWarning).toBeNull();
  });

  it("failureWarning names the streak length and last-attempt time, without the words breaker/circuit", () => {
    const summary = describeDeliveryStatus(fixture({ consecutiveFailures: 4, lastAttemptMs: NOW - 2 * 60_000 }), NOW);
    expect(summary.failureWarning).toBe("Hasn't been reachable for the last 4 attempts — last tried 2 minutes ago.");
    expect(summary.failureWarning).not.toMatch(/breaker|circuit/i);
  });

  it("singularizes 1 attempt", () => {
    const summary = describeDeliveryStatus(fixture({ consecutiveFailures: 1, lastAttemptMs: NOW - 30_000 }), NOW);
    expect(summary.failureWarning).toBe("Hasn't been reachable for the last 1 attempt — last tried just now.");
  });

  it("gapNotice is null when gapReportedThroughMs is null", () => {
    const summary = describeDeliveryStatus(fixture({ lastSuccessMs: NOW - 60_000 }), NOW);
    expect(summary.gapNotice).toBeNull();
  });

  it("gapNotice explains the skipped-backlog situation without the words gap/retention window", () => {
    const summary = describeDeliveryStatus(fixture({ lastSuccessMs: NOW - 60_000, gapReportedThroughMs: NOW - 86_400_000 }), NOW);
    expect(summary.gapNotice).toMatch(/couldn't be delivered and was skipped/);
    expect(summary.gapNotice).not.toMatch(/\bgap\b|retention window/i);
  });
});
