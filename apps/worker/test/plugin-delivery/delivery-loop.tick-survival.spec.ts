// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/delivery-loop.tick-survival.spec.ts
//
// AUD-A2e-001 (FW1-B). PluginDeliveryLoopHandle.runOnce's own doc comment
// (delivery-loop.ts) claims "never rejects ... even against a bug in this
// loop itself." Before this fix that held for every PER-PLUGIN failure
// (each wrapped in its own try/catch inside the Promise.allSettled map)
// but NOT for the one DB call outside that map — listEventSubscriberPlugins.
// startPluginDeliveryLoop's poll timer invokes runOnce() as a bare
// `void runOnce()`, so an uncaught rejection there becomes an
// unhandledRejection -> apps/worker/src/crash/handlers.ts's onFatal ->
// process.exit(1): the WHOLE worker dies (scan/probe/metadata/image/mail/
// transcode/import consumers included), not just this one tick.
//
// This is a plain unit test — no live Postgres — because the property
// under test is runOnce()'s OWN error-boundary shape, not real query
// semantics: a fake `db` whose first .execute() call throws (everything
// listEventSubscriberPlugins actually issues is
// selectFrom('plugins').select([...]).where(...).where(...).execute())
// isolates exactly that boundary. Drives the SAME exported runOnce() seam
// the sibling integration spec's shutdown test already uses — it is the
// literal function body startPluginDeliveryLoop's setInterval callback
// calls, so proving it never rejects proves the real interval callback
// never does either.

import { describe, expect, it, vi } from "vitest";
import { startPluginDeliveryLoop, type DeliveryDb } from "../../src/plugin-delivery/delivery-loop.js";

/** Minimal fake standing in for the one Kysely chain
 *  listEventSubscriberPlugins issues. Every non-execute link just returns
 *  itself so the real call shape (.select([...]).where(...).where(...))
 *  is free to chain without this fake caring about arguments. `execute()`
 *  is the single seam under test: it throws on the 1-indexed call numbers
 *  in `failOnCalls`, and resolves to an empty plugin list (this test needs
 *  no real plugin row) otherwise. */
function makeListPluginsProbeDb(failOnCalls: ReadonlySet<number>): { db: DeliveryDb; executeCallCount: () => number } {
  let executeCallCount = 0;
  const builder: Record<string, unknown> = {};
  builder["select"] = () => builder;
  builder["where"] = () => builder;
  builder["execute"] = async () => {
    executeCallCount += 1;
    if (failOnCalls.has(executeCallCount)) {
      throw new Error("simulated transient DB failure (connection reset)");
    }
    return [];
  };
  const db = { selectFrom: () => builder } as unknown as DeliveryDb;
  return { db, executeCallCount: () => executeCallCount };
}

describe("AUD-A2e-001: runOnce survives a listEventSubscriberPlugins failure", () => {
  it("tick 1's DB failure does not reject runOnce(), and tick 2 genuinely re-issues the same query", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, executeCallCount } = makeListPluginsProbeDb(new Set([1])); // only the FIRST execute() call fails
    const handle = startPluginDeliveryLoop({ db, pollIntervalMs: 3_600_000 }); // parked — never fires on its own during this test

    try {
      // (a) survival: runOnce() itself must resolve, not reject — this is
      // the exact promise the real poll timer discards via bare
      // `void runOnce()`; a rejection here is what becomes an
      // unhandledRejection in production.
      await expect(handle.runOnce()).resolves.toBeUndefined();
      expect(executeCallCount()).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled(); // logged, not silently swallowed

      // (b) the next tick still runs: a second direct call genuinely
      // re-issues listEventSubscriberPlugins's query (execute() count
      // advances to 2) and itself completes normally — proving the loop
      // is not left permanently wedged (e.g. an internal "ticking" guard
      // stuck true) by the first tick's failure, and that ordinary
      // delivery work resumes on the very next interval.
      await expect(handle.runOnce()).resolves.toBeUndefined();
      expect(executeCallCount()).toBe(2);
    } finally {
      await handle.stop();
      consoleErrorSpy.mockRestore();
    }
  });

  it("a tick with no DB failure is unaffected (no spurious error log, no behavior change)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, executeCallCount } = makeListPluginsProbeDb(new Set()); // never fails
    const handle = startPluginDeliveryLoop({ db, pollIntervalMs: 3_600_000 });

    try {
      await expect(handle.runOnce()).resolves.toBeUndefined();
      expect(executeCallCount()).toBe(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
      consoleErrorSpy.mockRestore();
    }
  });
});
