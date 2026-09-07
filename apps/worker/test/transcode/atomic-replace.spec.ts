// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/atomic-replace.spec.ts
//
// The served-playlist rewrite is write-temp-then-rename so a polling reader
// never sees a torn file. On Windows the rename itself has a failure mode
// POSIX does not: MoveFileEx(REPLACE_EXISTING) is refused with
// ERROR_ACCESS_DENIED (Node: EPERM) while ANY handle without
// FILE_SHARE_DELETE holds the destination — an antivirus scan of the file
// just written, the search indexer, a reader opened by a non-libuv
// program. The first Windows gate leg hit it live: the runner's poll loop
// died on one EPERM and the session never served its restart run
// (retention-viewer-floor 'START OVER', run 34156680703). This pins the
// bounded retry that replaces the bare rename.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomically, RENAME_RETRY_CODES } from "../../src/transcode/atomic-replace.js";

function fsError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("replaceFileAtomically — Windows rename-over-open-file retry", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("really replaces the destination on this host (happy path, no injected seams)", async () => {
    dir = mkdtempSync(join(tmpdir(), "loombre-atomic-replace-"));
    const dest = join(dir, "media.m3u8");
    const tmp = `${dest}.tmp`;
    writeFileSync(dest, "old", "utf8");
    writeFileSync(tmp, "new", "utf8");
    const outcome = await replaceFileAtomically(tmp, dest);
    expect(outcome.attempts).toBe(1);
    expect(readFileSync(dest, "utf8")).toBe("new");
  });

  it("win32: retries EPERM/EACCES/EBUSY with the backoff and succeeds once the handle is gone", async () => {
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(fsError("EPERM"))
      .mockRejectedValueOnce(fsError("EBUSY"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const outcome = await replaceFileAtomically("a.tmp", "a", { rename, sleep, platform: "win32", backoffMs: 7 });
    expect(outcome.attempts).toBe(3);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 7);
  });

  it("win32: gives up after the attempt budget and rethrows the LAST error", async () => {
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(fsError("EPERM"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(replaceFileAtomically("a.tmp", "a", { rename, sleep, platform: "win32", attempts: 5, backoffMs: 1 })).rejects.toMatchObject({ code: "EPERM" });
    expect(rename).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("win32: a non-sharing error (ENOENT — the temp file is gone) is thrown at once, no retry", async () => {
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(fsError("ENOENT"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(replaceFileAtomically("a.tmp", "a", { rename, sleep, platform: "win32" })).rejects.toMatchObject({ code: "ENOENT" });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("POSIX: EPERM means a real permission problem — thrown at once, never retried", async () => {
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(fsError("EPERM"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(replaceFileAtomically("a.tmp", "a", { rename, sleep, platform: "linux" })).rejects.toMatchObject({ code: "EPERM" });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("the retry set is exactly the Windows sharing-violation spellings", () => {
    expect([...RENAME_RETRY_CODES].sort()).toEqual(["EACCES", "EBUSY", "EPERM"]);
  });
});
