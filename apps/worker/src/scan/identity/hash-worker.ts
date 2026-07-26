// SPDX-License-Identifier: AGPL-3.0-only
/**
 * worker_threads entry point for content-hashing (docs/PLAN.md §9.2's
 * "Node worker_threads for hashing/blurhash" mandate, CLAUDE.md invariant
 * 9). Spawned by ./pool.ts; imports the same `hashFile` pure/IO pipeline
 * ./hash.ts's main-thread callers (and its unit tests) use, so there is
 * exactly one implementation of the byte-range/hash rule — this file is
 * only a message-passing adapter around it, never a second copy of the
 * algorithm.
 *
 * Protocol: each inbound message is `{ id, filePath, sizeBytes }`; the
 * worker replies with `{ id, contentHash }` on success or
 * `{ id, error: string }` on failure (a bad path, a permission error, ...)
 * — errors never crash the worker thread itself, so one bad file cannot
 * take down the whole pool.
 */
import { parentPort } from "node:worker_threads";
import { hashFile } from "./hash.js";

interface HashRequest {
  id: number;
  filePath: string;
  sizeBytes: number;
}

type HashResponse = { id: number; contentHash: string } | { id: number; error: string };

if (!parentPort) {
  throw new Error("hash-worker.ts must be run as a worker_threads Worker");
}

parentPort.on("message", (msg: HashRequest) => {
  hashFile(msg.filePath, msg.sizeBytes)
    .then((contentHash) => {
      const response: HashResponse = { id: msg.id, contentHash };
      parentPort?.postMessage(response);
    })
    .catch((err: unknown) => {
      const response: HashResponse = {
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      };
      parentPort?.postMessage(response);
    });
});
