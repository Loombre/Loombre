// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/replace-file-sync.ts
//
// The integration specs fabricate a run's playlist the way ffmpeg's hls
// muxer lands one — write a temp file, rename it over media.m3u8 — while
// the runner under test is reading that very file on its poll loop. On
// Windows that rename is refused (EPERM) whenever a handle without
// FILE_SHARE_DELETE holds the destination (src/transcode/atomic-replace.ts
// has the whole story); a spec that dies on that is testing the runner's
// bug from the wrong side. Same bounded retry, synchronous because every
// fabricate helper is.
import { renameSync } from "node:fs";

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const ATTEMPTS = 100;
const BACKOFF_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** renameSync(tmp, target) with the win32 sharing-violation retry. */
export function replaceFileSync(tmpPath: string, targetPath: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(tmpPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (process.platform !== "win32" || attempt >= ATTEMPTS || code === undefined || !RETRY_CODES.has(code)) throw error;
      sleepSync(BACKOFF_MS);
    }
  }
}
