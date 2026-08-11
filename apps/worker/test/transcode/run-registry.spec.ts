// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/run-registry.spec.ts
//
// process-lifecycle hardening wave (2026-08-11, Lane A1) item C1: graceful shutdown
// must terminate in-flight transcode runs.
//
// The defect this pins: apps/worker/src/index.ts's shutdown() stopped the
// queue, the hash pool, the watchers, the plugin-delivery loop and the
// database handle — and never touched a live ffmpeg. Every ffmpeg run is
// spawned `detached: true` on POSIX (src/transcode/process.ts), i.e. into
// its OWN process group, so it does NOT die with the worker: an ordinary
// restart or deploy left a full-rate encoder burning CPU and disk with no
// supervisor left alive to throttle, seek, or reap it. On Tier-0 hardware
// (N100/4GB) two of those is the machine.
//
// This spec covers the registry itself (pure, no database, no ffmpeg) plus
// the one thing a unit test can honestly assert about the wiring: that
// index.ts's shutdown path actually calls it. The end-to-end proof — a
// REAL ffmpeg, terminated by a simulated worker shutdown, verified gone
// with `ps` — is lifecycle.integration.spec.ts scenario (a).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeTranscodeRunCount,
  registerTranscodeRun,
  terminateAllTranscodeRuns,
} from "../../src/transcode/run-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = join(__dirname, "..", "..", "src");

afterEach(async () => {
  // Never leak registrations across tests — the registry is module state.
  await terminateAllTranscodeRuns();
});

describe("transcode run registry (C1: shutdown must be able to find live runs)", () => {
  it("counts registered runs and forgets them when unregistered", () => {
    expect(activeTranscodeRunCount()).toBe(0);
    const unregisterA = registerTranscodeRun({ terminate: async () => undefined });
    const unregisterB = registerTranscodeRun({ terminate: async () => undefined });
    expect(activeTranscodeRunCount()).toBe(2);

    unregisterA();
    expect(activeTranscodeRunCount()).toBe(1);
    // Idempotent: a run whose process already exited unregisters itself,
    // and teardown unregisters it again.
    unregisterA();
    expect(activeTranscodeRunCount()).toBe(1);

    unregisterB();
    expect(activeTranscodeRunCount()).toBe(0);
  });

  it("terminateAllTranscodeRuns terminates every registered run and empties the registry", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    registerTranscodeRun({ terminate: first });
    registerTranscodeRun({ terminate: second });

    const terminated = await terminateAllTranscodeRuns();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(terminated).toBe(2);
    expect(activeTranscodeRunCount()).toBe(0);
  });

  it("one run's terminate() throwing never prevents the others from being terminated", async () => {
    const exploding = vi.fn(async () => {
      throw new Error("EPERM");
    });
    const healthy = vi.fn(async () => undefined);
    registerTranscodeRun({ terminate: exploding });
    registerTranscodeRun({ terminate: healthy });

    await expect(terminateAllTranscodeRuns()).resolves.toBe(2);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(activeTranscodeRunCount()).toBe(0);
  });

  it("is a no-op when nothing is running (the ordinary shutdown case)", async () => {
    await expect(terminateAllTranscodeRuns()).resolves.toBe(0);
  });
});

describe("runner + shutdown wiring (C1)", () => {
  it("runner.ts registers every spawned run with the registry", () => {
    const runner = readFileSync(join(WORKER_SRC, "transcode", "runner.ts"), "utf8");
    expect(runner).toMatch(/registerTranscodeRun\(/);
  });

  it("index.ts's shutdown() AWAITS terminateAllTranscodeRuns(), before the concurrent stop group (D-2)", () => {
    const source = readFileSync(join(WORKER_SRC, "index.ts"), "utf8");
    const shutdownStart = source.indexOf("async function shutdown(");
    expect(shutdownStart, "shutdown() must exist in apps/worker/src/index.ts").toBeGreaterThan(-1);
    // The whole remaining tail is fine to search: shutdown() is the last
    // thing before main()'s helpers, and anchoring on its start is what
    // makes this an assertion about the SHUTDOWN path specifically.
    const shutdownBody = source.slice(shutdownStart, source.indexOf("\n}\n", shutdownStart));

    // D-2: the previous pin matched /terminateAllTranscodeRuns\(/, which a
    // `void terminateAllTranscodeRuns()` mutation still satisfies — and that
    // mutation is exactly the C1 regression, because shutdown would then race
    // ahead to queue.stop()/db.destroy()/process exit while the detached
    // ffmpeg children are still being killed, re-orphaning them. So the call
    // must be AWAITED, not merely present. (This is the strict-subset check a
    // source regex can honestly make; the end-to-end "children are actually
    // gone after a simulated shutdown" proof is
    // lifecycle.integration.spec.ts scenario (a).)
    expect(shutdownBody).toMatch(/await\s+terminateAllTranscodeRuns\(/);

    expect(source).toMatch(/import\s*\{[^}]*terminateAllTranscodeRuns[^}]*\}\s*from\s*"\.\/transcode\/index\.js"/s);
  });
});
