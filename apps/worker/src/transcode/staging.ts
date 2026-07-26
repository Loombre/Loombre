// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session staging directory management (docs/PLAYBACK.md §9, binding
 * constraint 3): `<root>/<sessionId>` is created on session start and
 * DELETED on end/fail/teardown. `deleteSessionDir` is guarded: it refuses
 * to remove anything that does not resolve to a path strictly under the
 * configured staging root, even though in practice `sessionId` always
 * comes from a server-generated UUIDv7 (packages/shared's `uuidv7`) and
 * never from unsanitized external input — defense in depth per this step's
 * binding constraint 3 ("never delete outside it, assert/refuse
 * otherwise"), not a response to a demonstrated injection path.
 *
 * Layout under a session's directory (see args.ts/playlist.ts headers for
 * the full rationale): one subdirectory PER FFMPEG RUN (`run0`, `run1`,
 * ... — a fresh one each seek-restart), each containing that run's own
 * `init.mp4`, `sNNNNNN.{m4s,ts}` segments, and ffmpeg's own per-run
 * `media.m3u8`. The session root additionally holds `media.m3u8` — the
 * WORKER-maintained served playlist wrapping every run (playlist.ts) —
 * which is not itself an ffmpeg output.
 */
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export function sessionDirFor(stagingRoot: string, sessionId: string): string {
  return join(resolve(stagingRoot), sessionId);
}

export function runDirFor(sessionDir: string, runIndex: number): string {
  return join(sessionDir, `run${runIndex}`);
}

/** Throws if `candidate` does not resolve to a path strictly under
 *  `root` (root itself is not "under" root — a caller must never be
 *  handed the root itself as a deletable session dir). */
function assertUnderRoot(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  const isUnder = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (!isUnder) {
    throw new Error(
      `transcode staging guard: refusing to touch "${resolvedCandidate}" — not strictly under staging root "${resolvedRoot}"`,
    );
  }
}

export async function createSessionDir(stagingRoot: string, sessionId: string): Promise<string> {
  const dir = sessionDirFor(stagingRoot, sessionId);
  assertUnderRoot(stagingRoot, dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function createRunDir(stagingRoot: string, sessionDir: string, runIndex: number): Promise<string> {
  assertUnderRoot(stagingRoot, sessionDir);
  const dir = runDirFor(sessionDir, runIndex);
  assertUnderRoot(stagingRoot, dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Removes a session's ENTIRE staging directory (all runs). Guarded:
 * refuses (throws, does NOT silently no-op) when `sessionDir` does not
 * resolve strictly under `stagingRoot`. Idempotent — deleting an
 * already-gone directory is not an error (`force: true`).
 */
export async function deleteSessionDir(stagingRoot: string, sessionDir: string): Promise<void> {
  assertUnderRoot(stagingRoot, sessionDir);
  await rm(sessionDir, { recursive: true, force: true });
}

/** Removes exactly one run's directory (retention pruning, binding
 *  constraint 5 — old segments beyond 120s behind live edge). Same guard
 *  as deleteSessionDir, scoped one level deeper (must be under the
 *  session dir, which is itself checked to be under the staging root). */
export async function deleteRunDir(stagingRoot: string, sessionDir: string, runDir: string): Promise<void> {
  assertUnderRoot(stagingRoot, sessionDir);
  assertUnderRoot(stagingRoot, runDir);
  await rm(runDir, { recursive: true, force: true });
}
