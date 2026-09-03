// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/boot-order.spec.ts
//
// SPF-14: the worker registers and CONFIRMS its job consumers before any
// filesystem watcher starts, and never awaits the watchers on the boot path.
// Live 2026-09-03 (SPF-11 residual, reports/state/OPEN.md): a native
// fs.watch open blocked inside macOS on a path the access() probe had
// passed, and because main() awaited the watcher before queue.ready(), no
// job ever ran. These cases pin the ordering law that makes that impossible
// regardless of what a watcher does: consumers first, watchers observed but
// never waited for, watcher failures logged and swallowed, consumer
// failures still fatal (the rc.2 "silent no-op worker" posture).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { bootConsumersBeforeWatchers } from "../src/boot-order.js";

const WORKER_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("bootConsumersBeforeWatchers (SPF-14 ordering law)", () => {
  it("awaits consumer registration first, then starts the watchers, and resolves even though the watchers NEVER settle", async () => {
    const order: string[] = [];
    const ready = vi.fn(async () => {
      order.push("ready");
    });
    const startWatchers = vi.fn(() => {
      order.push("startWatchers");
      return new Promise<void>(() => undefined); // a blocked native watch: never settles
    });

    const startedAt = Date.now();
    const result = await bootConsumersBeforeWatchers({ ready, startWatchers, log: () => undefined });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(order).toEqual(["ready", "startWatchers"]);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(startWatchers).toHaveBeenCalledTimes(1);
    // The watchers promise is exposed, still pending, and the boot path did
    // not depend on it.
    let settled = false;
    void result.watchers.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
  });

  it("does not start the watchers until ready() has resolved (not merely been called)", async () => {
    let releaseReady!: () => void;
    const ready = vi.fn(() => new Promise<void>((resolve) => {
      releaseReady = resolve;
    }));
    const startWatchers = vi.fn(async () => undefined);

    const boot = bootConsumersBeforeWatchers({ ready, startWatchers, log: () => undefined });
    await new Promise((r) => setTimeout(r, 20));
    expect(startWatchers).not.toHaveBeenCalled();

    releaseReady();
    await boot;
    expect(startWatchers).toHaveBeenCalledTimes(1);
  });

  it("a watcher start that rejects is logged, never thrown", async () => {
    const log = vi.fn();
    const result = await bootConsumersBeforeWatchers({
      ready: async () => undefined,
      startWatchers: async () => {
        throw new Error("EPERM: consent denied");
      },
      log,
    });
    await expect(result.watchers).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("EPERM: consent denied"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("scans still run"));
  });

  it("a watcher start that throws synchronously is logged, never thrown", async () => {
    const log = vi.fn();
    const result = await bootConsumersBeforeWatchers({
      ready: async () => undefined,
      startWatchers: () => {
        throw new Error("sync boom");
      },
      log,
    });
    await expect(result.watchers).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("sync boom"));
  });

  it("a failed consumer registration still fails boot (ready() rejection propagates) and the watchers never start", async () => {
    const startWatchers = vi.fn(async () => undefined);
    await expect(
      bootConsumersBeforeWatchers({
        ready: async () => {
          throw new Error("ECONNREFUSED");
        },
        startWatchers,
        log: () => undefined,
      })
    ).rejects.toThrow("ECONNREFUSED");
    expect(startWatchers).not.toHaveBeenCalled();
  });
});

// index.ts cannot be imported by a unit test (thirteen queue.work() calls
// and main() run at module scope), so the one honest thing a unit test can
// assert about the WIRING — that main() really routes through the helper
// above with queue.ready as the consumer half and both watcher starters
// inside the never-awaited half — is pinned against the source, the same
// way test/transcode/run-registry.spec.ts pins shutdown()'s call. A
// reintroduced `await startLibraryWatcher()` ahead of the call (the exact
// pre-SPF-14 shape), a stray `await queue.ready()` after it, or an await on
// the returned watchers promise each fail here while every stubbed case
// above stays green.
describe("main() wiring (SPF-14)", () => {
  const source = readFileSync(join(WORKER_SRC, "index.ts"), "utf8");
  const mainStart = source.indexOf("async function main(");
  const mainBody = source.slice(mainStart, source.indexOf("\n}\n", mainStart));

  it("imports the helper and calls it with queue.ready() as the consumer half and both watcher starters inside startWatchers", () => {
    expect(source).toContain('import { bootConsumersBeforeWatchers } from "./boot-order.js";');
    expect(mainStart).toBeGreaterThan(0);
    expect(mainBody).toMatch(
      /await\s+bootConsumersBeforeWatchers\(\{\s*ready:\s*\(\)\s*=>\s*queue\.ready\(\),\s*startWatchers:\s*async\s*\(\)\s*=>\s*\{\s*await\s+startLibraryWatcher\(\);\s*await\s+startStashLibraryWatcher\(\);\s*\},?\s*\}\)/,
    );
  });

  it("main() starts each watcher exactly once, only inside that call, and never awaits the watchers promise", () => {
    const count = (needle: string) => mainBody.split(needle).length - 1;
    expect(count("startLibraryWatcher(")).toBe(1);
    expect(count("startStashLibraryWatcher(")).toBe(1);
    expect(count("queue.ready(")).toBe(1);
    expect(mainBody).not.toMatch(/await\s+[A-Za-z_.]*watchers\b/);
    expect(mainBody).not.toMatch(/await\s+watchersBoot\b/);
  });
});
