// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/staging.spec.ts
//
// Tests for src/transcode/staging.ts — real filesystem I/O against a
// disposable tmp root (no ffmpeg needed), incl. the guarded-delete refusal
// (this step's binding constraint 3: "never delete outside it, assert/
// refuse otherwise").

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunDir, createSessionDir, deleteRunDir, deleteSessionDir, runDirFor, sessionDirFor } from "../../src/transcode/staging.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loombre-staging-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sessionDirFor / runDirFor", () => {
  it("computes deterministic paths", () => {
    expect(sessionDirFor(root, "sess-1")).toBe(join(root, "sess-1"));
    expect(runDirFor(join(root, "sess-1"), 2)).toBe(join(root, "sess-1", "run2"));
  });
});

describe("createSessionDir / createRunDir", () => {
  it("creates the session dir and a run subdirectory", async () => {
    const sessionDir = await createSessionDir(root, "sess-1");
    const runDir = await createRunDir(root, sessionDir, 0);
    const st = await stat(runDir);
    expect(st.isDirectory()).toBe(true);
  });

  it("is idempotent (recursive: true) — creating twice does not throw", async () => {
    await createSessionDir(root, "sess-1");
    await expect(createSessionDir(root, "sess-1")).resolves.toBeDefined();
  });
});

describe("deleteSessionDir — guarded", () => {
  it("deletes a real session directory and everything under it", async () => {
    const sessionDir = await createSessionDir(root, "sess-1");
    const runDir = await createRunDir(root, sessionDir, 0);
    await writeFile(join(runDir, "s000000.m4s"), "data");

    await deleteSessionDir(root, sessionDir);
    await expect(stat(sessionDir)).rejects.toThrow();
  });

  it("is idempotent — deleting an already-gone directory does not throw", async () => {
    const sessionDir = sessionDirFor(root, "never-created");
    await expect(deleteSessionDir(root, sessionDir)).resolves.toBeUndefined();
  });

  it("REFUSES to delete a path outside the staging root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "loombre-outside-"));
    try {
      await expect(deleteSessionDir(root, outside)).rejects.toThrow(/refusing to touch/);
      // Prove it really was refused, not silently no-op'd: the directory
      // must still exist.
      const st = await stat(outside);
      expect(st.isDirectory()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("REFUSES to delete the staging root itself (root is not 'under' root)", async () => {
    await expect(deleteSessionDir(root, root)).rejects.toThrow(/refusing to touch/);
  });

  it("REFUSES a path-traversal escape (../) even if textually prefixed by the root", async () => {
    const sessionDir = await createSessionDir(root, "sess-1");
    const escapeAttempt = join(sessionDir, "..", "..", "escaped");
    await expect(deleteSessionDir(root, escapeAttempt)).rejects.toThrow(/refusing to touch/);
  });
});

describe("deleteRunDir — guarded", () => {
  it("deletes exactly one run's directory, leaving the session dir and other runs intact", async () => {
    const sessionDir = await createSessionDir(root, "sess-1");
    const run0 = await createRunDir(root, sessionDir, 0);
    const run1 = await createRunDir(root, sessionDir, 1);

    await deleteRunDir(root, sessionDir, run0);
    await expect(stat(run0)).rejects.toThrow();
    const st1 = await stat(run1);
    expect(st1.isDirectory()).toBe(true);
    const stSession = await stat(sessionDir);
    expect(stSession.isDirectory()).toBe(true);
  });

  it("refuses a run dir outside the staging root", async () => {
    const sessionDir = await createSessionDir(root, "sess-1");
    const outside = await mkdtemp(join(tmpdir(), "loombre-outside-run-"));
    try {
      await expect(deleteRunDir(root, sessionDir, outside)).rejects.toThrow(/refusing to touch/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
