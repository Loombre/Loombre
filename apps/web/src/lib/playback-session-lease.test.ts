// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-session-lease.test.ts
//
// Scenario matrix for the gap-F1 lease pool — pure DI (idOf/end injected,
// creates are hand-resolved deferreds), no vi.mock (this suite's standing
// pattern, see device-profile.test.ts / playback-session.test.ts headers).
// The StrictMode choreography itself (setup #1 → cleanup #1 → setup #2
// against a real render) is covered component-side in
// components/player/VideoPlayer.test.tsx's gap-F1 describe; here the same
// call sequences run against the pool directly.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSessionLeasePool, playbackSessionLeaseKey } from "./playback-session-lease.js";

interface FakeResult {
  ok: boolean;
  id: string | null;
}

function makePool(): {
  pool: ReturnType<typeof createSessionLeasePool<FakeResult>>;
  ended: string[];
} {
  const ended: string[] = [];
  const pool = createSessionLeasePool<FakeResult>({
    idOf: (r) => (r.ok ? r.id : null),
    end: (id) => {
      ended.push(id);
    },
  });
  return { pool, ended };
}

function deferred(): { promise: Promise<FakeResult>; resolve: (r: FakeResult) => void; reject: (e: unknown) => void } {
  let resolve: (r: FakeResult) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<FakeResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const KEY = playbackSessionLeaseKey("item-1");

describe("createSessionLeasePool", () => {
  it("StrictMode twins share ONE create; the released twin never ends the survivor's session", async () => {
    const { pool, ended } = makePool();
    const d = deferred();
    let creates = 0;
    const create = (): Promise<FakeResult> => {
      creates += 1;
      return d.promise;
    };
    // setup #1 → cleanup #1 → setup #2, all before the create settles —
    // the exact StrictMode order.
    const lease1 = pool.acquire(KEY, create);
    lease1.release();
    const lease2 = pool.acquire(KEY, create);
    expect(creates).toBe(1);

    d.resolve({ ok: true, id: "s-1" });
    const result = await lease2.promise;
    expect(result.id).toBe("s-1");
    // Twin #1 released pre-settle, twin #2 still holds: nothing ends.
    expect(ended).toEqual([]);

    // Twin #2 adopts; its own eventual cleanup must not end it either
    // (the component's unmount path owns an adopted session).
    lease2.adopt();
    lease2.release();
    expect(ended).toEqual([]);
  });

  it("ends an orphaned create exactly once when it settles after every holder released (AUD-A4v4-003)", async () => {
    const { pool, ended } = makePool();
    const d = deferred();
    const lease = pool.acquire(KEY, () => d.promise);
    lease.release();
    lease.release(); // idempotent per lease
    expect(ended).toEqual([]);
    d.resolve({ ok: true, id: "s-1" });
    await d.promise;
    await Promise.resolve(); // let the pool's settle handler run
    expect(ended).toEqual(["s-1"]);
  });

  it("ends the session on a release that lands AFTER settle when nobody adopted (unmount racing the resolve)", async () => {
    const { pool, ended } = makePool();
    const d = deferred();
    const lease = pool.acquire(KEY, () => d.promise);
    d.resolve({ ok: true, id: "s-1" });
    await lease.promise;
    // Settled while held → not orphaned yet…
    expect(ended).toEqual([]);
    // …but the holder unmounts without adopting (its `cancelled` check
    // fires before it can consume the result): the release cleans up.
    lease.release();
    expect(ended).toEqual(["s-1"]);
    lease.release();
    expect(ended).toEqual(["s-1"]); // still exactly once
  });

  it("never ends anything for a not-ok result (a refusal has no server row)", async () => {
    const { pool, ended } = makePool();
    const d = deferred();
    const lease = pool.acquire(KEY, () => d.promise);
    lease.release();
    d.resolve({ ok: false, id: null });
    await lease.promise;
    expect(ended).toEqual([]);
  });

  it("rejects through to every holder, ends nothing, and frees the key for a fresh create", async () => {
    const { pool, ended } = makePool();
    const d = deferred();
    const lease1 = pool.acquire(KEY, () => d.promise);
    const lease2 = pool.acquire(KEY, () => d.promise);
    d.reject(new Error("boom"));
    await expect(lease1.promise).rejects.toThrow("boom");
    await expect(lease2.promise).rejects.toThrow("boom");
    lease1.release();
    lease2.release();
    expect(ended).toEqual([]);

    const d2 = deferred();
    let creates = 0;
    pool.acquire(KEY, () => {
      creates += 1;
      return d2.promise;
    });
    expect(creates).toBe(1);
  });

  it("keys are independent: a superseding create under a NEW key leaves the old one to orphan-end", async () => {
    const { pool, ended } = makePool();
    const dOld = deferred();
    const dNew = deferred();
    const oldLease = pool.acquire(playbackSessionLeaseKey("item-1"), () => dOld.promise);
    // mediaFileId change: cleanup releases the old key, the re-run
    // acquires a DIFFERENT key → a second, independent create.
    oldLease.release();
    let creates = 0;
    const newLease = pool.acquire(playbackSessionLeaseKey("item-1", "file-alt"), () => {
      creates += 1;
      return dNew.promise;
    });
    expect(creates).toBe(1);
    dNew.resolve({ ok: true, id: "s-2" });
    await newLease.promise;
    newLease.adopt();
    // The superseded create resolves late: its session must be ended…
    dOld.resolve({ ok: true, id: "s-1" });
    await dOld.promise;
    await Promise.resolve();
    expect(ended).toEqual(["s-1"]);
  });

  it("a delivered entry leaves the map: the next mount for the same key gets a FRESH create, never a dead session", async () => {
    const { pool, ended } = makePool();
    const d1 = deferred();
    const lease1 = pool.acquire(KEY, () => d1.promise);
    d1.resolve({ ok: true, id: "s-1" });
    await lease1.promise;
    lease1.adopt();
    lease1.release();

    const d2 = deferred();
    let creates = 0;
    const lease2 = pool.acquire(KEY, () => {
      creates += 1;
      return d2.promise;
    });
    expect(creates).toBe(1);
    d2.resolve({ ok: true, id: "s-2" });
    const result = await lease2.promise;
    expect(result.id).toBe("s-2");
    expect(ended).toEqual([]); // s-1 was adopted; s-2 is held
  });

  it("reset() disowns in-flight creates: a stale settle after reset ends nothing and the key is free", async () => {
    const { pool, ended } = makePool();
    const d = deferred();
    const lease = pool.acquire(KEY, () => d.promise);
    lease.release();
    pool.reset();
    d.resolve({ ok: true, id: "stale" });
    await d.promise;
    await Promise.resolve();
    expect(ended).toEqual([]);

    let creates = 0;
    pool.acquire(KEY, () => {
      creates += 1;
      return deferred().promise;
    });
    expect(creates).toBe(1);
  });
});

describe("playbackSessionLeaseKey", () => {
  it("distinguishes the pinned-file variants of one item, and defaults to the primary-file key", () => {
    expect(playbackSessionLeaseKey("item-1")).toBe(playbackSessionLeaseKey("item-1", undefined));
    expect(playbackSessionLeaseKey("item-1")).not.toBe(playbackSessionLeaseKey("item-1", "file-a"));
    expect(playbackSessionLeaseKey("item-1", "file-a")).not.toBe(playbackSessionLeaseKey("item-1", "file-b"));
    expect(playbackSessionLeaseKey("item-1")).not.toBe(playbackSessionLeaseKey("item-2"));
  });

  // d3-aq3 (verify/gap-F1): the separator was written as a RAW NUL byte, so
  // `.gitattributes`' `* text=auto` detected this module as BINARY — it
  // landed with zero reviewable diff and is invisible to blame, `git grep`
  // and every grep gate. The separator character is unchanged (a UUID can
  // never contain it, so no two distinct pairs collide); only its spelling
  // is, from a literal byte to an escape. scripts/grep-gates.mjs pass (d)
  // enforces that repo-wide; this asserts it for the module that had it.
  it("keeps a separator no UUID can contain, spelled as an escape so the file stays TEXT to git", () => {
    const key = playbackSessionLeaseKey("01a01f7a-36d5-7e7c-9e30-c85c082a5de9", "01a01f7a-330e-7ac9-b2e5-5cd7bb6d4c47");
    expect(key.split("\u0000")).toHaveLength(2);
    // The classic collision this separator exists to prevent.
    expect(playbackSessionLeaseKey("a", "b:c")).not.toBe(playbackSessionLeaseKey("a:b", "c"));

    // Read from disk, not from the transformed module: the point is the
    // literal BYTES git stores. (jsdom's import.meta.url is an http: URL,
    // hence the cwd-relative lookup — vitest runs with the package as cwd,
    // whether invoked directly or through turbo.)
    const candidates = ["src/lib/playback-session-lease.ts", "apps/web/src/lib/playback-session-lease.ts"];
    const found = candidates.find((candidate) => existsSync(candidate));
    expect(found, `none of ${candidates.join(", ")} resolved from ${process.cwd()}`).toBeDefined();
    const source = readFileSync(found!, "utf8");
    expect(source.includes("\u0000"), "a raw NUL byte in tracked source makes the whole file binary to git").toBe(false);
  });
});
