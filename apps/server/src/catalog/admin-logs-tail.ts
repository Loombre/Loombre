// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/admin-logs-tail.ts
//
// GET /admin/logs/tail backing implementation (Phase 4 deliverable D).
// Reads LOOMBRE_LOG_FILE (installers point this at the service log) and
// returns its last N lines — WITHOUT reading the whole file into memory
// first (the task brief's explicit requirement: "do NOT read whole
// multi-GB files"). Algorithm: open the file, seek backward from the end
// in fixed-size chunks, counting newlines as they're read, stopping as
// soon as at least `maxLines + 1` newlines have been seen (or the start of
// the file is reached) — the number of chunks read is bounded by
// `(bytes needed for maxLines lines) / chunkSizeBytes`, never by the
// file's total size. A 5 GB log file with short lines and `lines=200`
// still only reads a handful of 64 KiB chunks from the tail.
//
// `open` is injectable (default: node:fs/promises' real `open`) purely so
// tests can wrap the returned FileHandle and COUNT how many `.read()`
// calls happen against a large fixture — proving the boundedness claim
// above empirically, not just by code inspection.

import { open as realOpen, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";

export interface OpenLike {
  (path: string, flags: string): Promise<FileHandle>;
}

const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * Returns the last `maxLines` lines of the file at `path`, oldest first —
 * never reading more of the file than necessary from its tail. Throws only
 * on a real I/O error (ENOENT etc.) — callers decide what an unreadable
 * configured path means (see tailLogFile below, which treats it as an
 * honest empty tail rather than a 5xx).
 */
export async function tailFileLines(
  path: string,
  maxLines: number,
  opts: { chunkSizeBytes?: number; open?: OpenLike } = {},
): Promise<string[]> {
  const chunkSizeBytes = opts.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  const doOpen = opts.open ?? realOpen;

  const handle = await doOpen(path, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0 || maxLines <= 0) return [];

    // Read chunks from the end until we've seen enough newlines to cover
    // `maxLines` full lines, or we've reached byte 0. `+1` because the
    // Nth-from-last NEWLINE marks the start of the (N-1)th-from-last line
    // — needing `maxLines` complete lines means needing `maxLines`
    // newlines strictly BEFORE the tail's own trailing newline (if any).
    let position = size;
    let newlinesSeen = 0;
    const chunks: Buffer[] = [];

    while (position > 0 && newlinesSeen <= maxLines) {
      const readSize = Math.min(chunkSizeBytes, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, position);
      chunks.unshift(buffer);
      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] === NEWLINE) newlinesSeen += 1;
      }
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split("\n");
    // A trailing "\n" produces one trailing empty split element that isn't
    // a real line — drop it. A file with NO trailing newline keeps its
    // last (incomplete) line, matching every standard `tail` command.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    return lines.slice(-maxLines);
  } finally {
    await handle.close();
  }
}

export interface LogTail {
  source: string | null;
  lines: string[];
}

/**
 * Full GET /admin/logs/tail resolution: LOOMBRE_LOG_FILE unset/empty ->
 * `{source: null, lines: []}` — the "null source honest state" the
 * contract's LogTail schema documents (stdout-only dev setups have
 * nothing to tail, and the surface says so rather than pretending). A
 * CONFIGURED path that can't currently be read (not created yet, deleted,
 * permission error) is likewise `{source: <basename>, lines: []}` — the
 * source IS configured, there is simply nothing to show right now; this
 * never throws a 5xx for a transient/pre-first-write log file.
 */
export async function tailLogFile(
  logFilePath: string | undefined,
  maxLines: number,
  opts: { chunkSizeBytes?: number; open?: OpenLike } = {},
): Promise<LogTail> {
  const trimmed = logFilePath?.trim();
  if (!trimmed) return { source: null, lines: [] };

  try {
    const lines = await tailFileLines(trimmed, maxLines, opts);
    return { source: basename(trimmed), lines };
  } catch {
    return { source: basename(trimmed), lines: [] };
  }
}
