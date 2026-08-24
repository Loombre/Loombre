// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/progress-write-queue.test.ts
//
// gap-F7: the FIFO progress-write lane — see progress-write-queue.ts for
// the EOF pause/ended last-write race this exists to close. Pure promise
// mechanics, no mocks needed.

import { describe, expect, it } from "vitest";
import { createProgressWriteQueue } from "./progress-write-queue.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every currently-queued microtask run. */
async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createProgressWriteQueue", () => {
  it("does not start the second write until the first settles (the EOF pause/ended pair)", async () => {
    const queue = createProgressWriteQueue();
    const first = deferred<void>();
    const calls: string[] = [];

    void queue.enqueue(() => {
      calls.push("in-progress");
      return first.promise;
    });
    void queue.enqueue(() => {
      calls.push("played");
      return Promise.resolve();
    });
    await microtasks();
    expect(calls, "the second write must wait for the first to settle").toEqual(["in-progress"]);

    first.resolve();
    await microtasks();
    expect(calls).toEqual(["in-progress", "played"]);
  });

  it("preserves FIFO order across many writes", async () => {
    const queue = createProgressWriteQueue();
    const order: number[] = [];
    const done = [0, 1, 2, 3].map((n) =>
      queue.enqueue(async () => {
        order.push(n);
      }),
    );
    await Promise.all(done);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("a rejected write neither blocks nor reorders the writes behind it", async () => {
    const queue = createProgressWriteQueue();
    const first = deferred<void>();
    const calls: string[] = [];

    const firstDone = queue.enqueue(() => {
      calls.push("failing");
      return first.promise;
    });
    void queue.enqueue(() => {
      calls.push("after-failure");
      return Promise.resolve();
    });
    await microtasks();
    expect(calls).toEqual(["failing"]);

    first.reject(new Error("network drop"));
    await expect(firstDone).resolves.toBeUndefined(); // never rejects
    await microtasks();
    expect(calls).toEqual(["failing", "after-failure"]);
  });

  it("a synchronously-throwing write does not poison the lane", async () => {
    const queue = createProgressWriteQueue();
    const calls: string[] = [];

    const thrown = queue.enqueue(() => {
      throw new Error("sync explosion");
    });
    await expect(thrown).resolves.toBeUndefined();
    await queue.enqueue(async () => {
      calls.push("still-runs");
    });
    expect(calls).toEqual(["still-runs"]);
  });

  it("the returned promise resolves only after that specific write settles", async () => {
    const queue = createProgressWriteQueue();
    const first = deferred<void>();
    let firstSettled = false;

    const firstDone = queue.enqueue(() => first.promise).then(() => {
      firstSettled = true;
    });
    await microtasks();
    expect(firstSettled).toBe(false);

    first.resolve();
    await firstDone;
    expect(firstSettled).toBe(true);
  });
});
