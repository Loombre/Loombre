// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/adapter.spec.ts
//
// STATE.md S2 proof: "Loombre never writes the Stash DB... WAL-locked by a
// running Stash -> bounded retry with backoff -> snapshot-copy to a temp
// path and read the copy" plus the fs-level proof requirement ("Stash DB
// file bytes/mtime unchanged across a full adapter session (including a
// WAL-mode fixture)"). K6: empirically verified node:sqlite readOnly +
// WAL + busy-lock behavior (spiked by hand before writing this file —
// `DatabaseSync(path, {readOnly:true})` opens successfully even when
// another connection holds an exclusive lock; only a QUERY against it
// throws `ERR_SQLITE_ERROR`/errcode 5 "database is locked"; node:sqlite's
// `backup()` throws an unreliable `errcode 0 "not an error"` shape when
// its source is locked rather than a clean SQLITE_BUSY — this suite's
// snapshot-fallback test is written against that REAL observed behavior,
// not the documented-but-unobserved ideal).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StashConnectionUnavailableError } from "../../src/stash/errors.js";
import { openStashConnection, type StashConnection } from "../../src/stash/adapter.js";
import { busyThrowingOpen } from "./support/busy-direct-open.js";

let workDir: string;
const openConnections: StashConnection[] = [];

afterEach(() => {
  for (const conn of openConnections.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed by the test itself — fine.
    }
  }
});

/**
 * The direct-open tier's contention is injected, not produced by a real OS
 * file lock. SQLite's cross-connection locking is only GUARANTEED to
 * conflict across separate processes, via OS file locks — and some CI
 * filesystems (the GitHub macOS AND Windows runners, observed empirically)
 * do not honor those locks for SQLite at all, so NO real lock (same-process
 * or cross-process) blocks a reader there. Relying on real contention made
 * the snapshot-fallback tests pass on Linux and fail on macOS/Windows CI.
 * Instead we force the direct tier into a deterministic SQLITE_BUSY via the
 * adapter's `openDirectOnce` test seam (adapter.ts) — the snapshot tier then
 * runs its REAL backup() against the (genuinely unlocked) source, so the
 * fallback path and its real file copy are exercised identically on every
 * platform. See support/busy-direct-open.ts (busyThrowingOpen) for the seam.
 */

/** A plain committed WAL-mode source (one table + one row), unlocked — the
 *  real file the snapshot tier copies once the injected direct tier reports
 *  busy. Returns the path and a baseline captured after the committed write
 *  and after close() settles the sidecars away. */
function makeSource(name: string, marker = "committed-before-lock"): {
  dbFilePath: string;
  baselineHash: string;
  baselineMtimeMs: number;
} {
  const p = dbPath(name);
  const writer = new DatabaseSync(p);
  writer.exec("PRAGMA journal_mode=WAL;");
  writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
  writer.exec(`INSERT INTO t (v) VALUES ('${marker}');`);
  writer.close();
  return { dbFilePath: p, baselineHash: fileHash(p), baselineMtimeMs: statSync(p).mtimeMs };
}

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function dbPath(name: string): string {
  if (!workDir) workDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-adapter-"));
  return path.join(workDir, name);
}

function fileHash(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** A plain, uncontended WAL-mode fixture with one table + one row. */
function makePlainFixture(name: string): string {
  const p = dbPath(name);
  const writer = new DatabaseSync(p);
  writer.exec("PRAGMA journal_mode=WAL;");
  writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
  writer.exec("INSERT INTO t (v) VALUES ('hello');");
  writer.close();
  return p;
}


describe("openStashConnection — uncontended open", () => {
  it("opens a plain fixture read-only and can query it", async () => {
    const p = makePlainFixture("plain.db");
    const conn = await openStashConnection({ path: p });
    openConnections.push(conn);
    expect(conn.readingFrom).toBe("source");
    expect(conn.snapshotPath).toBeNull();
    const rows = conn.db.prepare("SELECT v FROM t").all() as { v: string }[];
    expect(rows).toEqual([{ v: "hello" }]);
  });

  it("the returned connection is genuinely read-only — a write attempt throws", async () => {
    const p = makePlainFixture("readonly-enforced.db");
    const conn = await openStashConnection({ path: p });
    openConnections.push(conn);
    expect(() => conn.db.exec("INSERT INTO t (v) VALUES ('nope')")).toThrow();
  });

  it("throws StashConnectionUnavailableError fast for a nonexistent path (no wasted retry budget)", async () => {
    const missing = path.join(dbPath("unused-dir-marker"), "..", "does-not-exist.db");
    const start = Date.now();
    await expect(openStashConnection({ path: missing, maxDirectRetries: 5, directRetryBackoffMs: 500 })).rejects.toThrow(
      StashConnectionUnavailableError
    );
    // A CANTOPEN failure is not retry-worthy — this must not have burned
    // through 5 retries at 500ms backoff (which would take >1.5s).
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("leaves the fixture's own .db file byte-identical when the source opens directly", async () => {
    // Note: SQLite itself may create/touch `-wal`/`-shm` SIDECAR files for
    // a WAL-mode database even on a pure read (the shared wal-index is a
    // normal reader-side artifact, unrelated to writing the database) —
    // S2's guarantee is about the .db file's own bytes, asserted directly
    // here rather than via a whole-directory diff (which would false-
    // positive on that harmless sidecar activity).
    const p = makePlainFixture("no-snapshot-residue.db");
    const hashBefore = fileHash(p);
    const conn = await openStashConnection({ path: p });
    openConnections.push(conn);
    conn.close();
    openConnections.length = 0; // already closed above
    expect(fileHash(p)).toBe(hashBefore);
    expect(conn.snapshotPath).toBeNull();
  });
});

describe("openStashConnection — S2 fs-level proof (bytes/mtime unchanged)", () => {
  it("source file bytes AND mtime are byte-identical after a full uncontended session", async () => {
    const p = makePlainFixture("fs-proof-plain.db");
    const hashBefore = fileHash(p);
    const mtimeBefore = statSync(p).mtimeMs;

    const conn = await openStashConnection({ path: p });
    conn.db.prepare("SELECT * FROM t").all();
    conn.db.prepare("SELECT * FROM t").all();
    conn.close();

    expect(fileHash(p)).toBe(hashBefore);
    expect(statSync(p).mtimeMs).toBe(mtimeBefore);
  });

  it("source file bytes AND mtime are unchanged even when both retry tiers are exhausted", async () => {
    // BOTH tiers fail: the direct tier is forced busy (injected), and the
    // snapshot tier is forced to fail by pointing its temp base at a
    // nonexistent directory so mkdtemp() cannot even start a copy. The call
    // rejects, and — the point of this test — Loombre's OWN adapter never
    // wrote to the source, so bytes/mtime match the baseline.
    const { dbFilePath, baselineHash, baselineMtimeMs } = makeSource("fs-proof-locked.db");

    await expect(
      openStashConnection(
        {
          path: dbFilePath,
          busyTimeoutMs: 10,
          maxDirectRetries: 1,
          directRetryBackoffMs: 10,
          maxSnapshotRetries: 2,
          snapshotRetryBackoffMs: 10,
        },
        { openDirectOnce: busyThrowingOpen(), tmpDir: path.join(workDir, "does-not-exist-snapshot-base") }
      )
    ).rejects.toThrow(StashConnectionUnavailableError);

    expect(fileHash(dbFilePath)).toBe(baselineHash);
    expect(statSync(dbFilePath).mtimeMs).toBe(baselineMtimeMs);
  });

  it("source file bytes AND mtime are unchanged across a SUCCESSFUL snapshot-copy fallback", async () => {
    // The production fallback path (S2's whole point), asserted at the fs
    // level: the direct tier is forced busy (injected), the snapshot tier
    // then runs its REAL backup() against the genuinely-unlocked source. Any
    // difference in the source afterward could only be Loombre's own doing —
    // and there is none (backup reads the source, never writes it).
    const { dbFilePath, baselineHash, baselineMtimeMs } = makeSource("fs-proof-snapshot-success.db");

    const conn = await openStashConnection(
      {
        path: dbFilePath,
        busyTimeoutMs: 20,
        maxDirectRetries: 1,
        directRetryBackoffMs: 20,
        maxSnapshotRetries: 20,
        snapshotRetryBackoffMs: 40,
      },
      { openDirectOnce: busyThrowingOpen() }
    );

    expect(conn.readingFrom).toBe("snapshot");
    // Read through the snapshot the way a real sync would, then close it
    // (which removes the temp copy) — the source must be untouched by all
    // of it.
    expect((conn.db.prepare("SELECT v FROM t").all() as { v: string }[]).map((r) => r.v)).toContain("committed-before-lock");
    conn.close();

    expect(fileHash(dbFilePath)).toBe(baselineHash);
    expect(statSync(dbFilePath).mtimeMs).toBe(baselineMtimeMs);
  }, 20_000);
});

describe("openStashConnection — WAL sidecar reality next to the user's file (S2 honest boundary)", () => {
  it("a read-only open of a WAL-mode database CREATES -wal/-shm siblings and leaves them behind — while the .db itself is untouched", async () => {
    // Empirically pinned rather than hand-waved, because it is the one
    // place where "Loombre never writes your Stash database" needs its
    // exact scope stated. SQLite's WAL reader protocol requires the shared
    // wal-index; `readOnly: true` does NOT opt out of creating it, and a
    // read-only connection cannot checkpoint-and-delete it on close the
    // way a read-write connection does. So after Loombre reads a
    // WAL-mode Stash database that had no sidecars, two zero-content
    // sibling files remain in the user's Stash directory.
    //
    // This is not a write to the database: the `.db` file's own bytes and
    // mtime are unchanged (asserted below), the leftover `-wal` carries no
    // frames, and Stash reopening the database treats an empty WAL as
    // empty. It IS, however, a real filesystem effect in the user's
    // directory, and the S11 "one-way guarantee" wording should be read
    // against this test, not against a stronger claim nobody proved.
    const p = makePlainFixture("wal-sidecars.db");
    const dir = path.dirname(p);
    const base = path.basename(p);
    const siblings = () => readdirSync(dir).filter((f) => f.startsWith(`${base}-`)).sort();

    expect(siblings()).toEqual([]); // makePlainFixture's writer close() checkpointed them away
    const hashBefore = fileHash(p);
    const mtimeBefore = statSync(p).mtimeMs;

    const conn = await openStashConnection({ path: p });
    conn.db.prepare("SELECT * FROM t").all();
    const duringSession = siblings();
    conn.close();
    const afterClose = siblings();

    expect(duringSession).toEqual([`${base}-shm`, `${base}-wal`]);
    expect(afterClose).toEqual([`${base}-shm`, `${base}-wal`]); // read-only readers cannot clean up
    expect(fileHash(p)).toBe(hashBefore);
    expect(statSync(p).mtimeMs).toBe(mtimeBefore);
  });

  it("a WAL-mode database in a NON-WRITABLE directory fails honestly and fast, without attempting the snapshot tier", async () => {
    // The direct consequence of the sidecar fact above, and a realistic
    // deployment shape (a Stash config directory owned by another user or
    // exported read-only). SQLite reports it as SQLITE_READONLY_DIRECTORY,
    // whose raw message — "attempt to write a readonly database" — reads
    // like Loombre tried to WRITE the user's Stash database, the exact
    // opposite of S2. adapter.ts therefore names the real cause in the
    // error it raises; this test pins that wording so it cannot silently
    // regress to the bare SQLite string.
    const roDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-adapter-rodir-"));
    const roDbPath = path.join(roDir, "stash.db");
    const writer = new DatabaseSync(roDbPath);
    writer.exec("PRAGMA journal_mode=WAL;");
    writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY);");
    writer.close();
    chmodSync(roDir, 0o500); // r-x: readable, not writable

    try {
      const started = Date.now();
      await expect(
        openStashConnection({ path: roDbPath, busyTimeoutMs: 10, maxDirectRetries: 5, directRetryBackoffMs: 500, maxSnapshotRetries: 5, snapshotRetryBackoffMs: 500 })
      ).rejects.toThrow(/cannot create its SQLite sidecar files/);
      // Not a lock — never retried, and never dragged through the snapshot
      // tier (which needs the very same sidecars and would fail identically).
      expect(Date.now() - started).toBeLessThan(1000);
      expect(readdirSync(roDir)).toEqual(["stash.db"]); // nothing was created in the user's directory
    } finally {
      chmodSync(roDir, 0o700);
      rmSync(roDir, { recursive: true, force: true });
    }
  });
});

describe("openStashConnection — busy direct open -> snapshot fallback (S2)", () => {
  it("retries the direct open, then falls back to a snapshot copy once the direct tier stays busy", async () => {
    const { dbFilePath } = makeSource("wal-lock-fallback.db");

    const conn = await openStashConnection(
      {
        path: dbFilePath,
        busyTimeoutMs: 20,
        maxDirectRetries: 2,
        directRetryBackoffMs: 20,
        maxSnapshotRetries: 20,
        snapshotRetryBackoffMs: 40,
      },
      { openDirectOnce: busyThrowingOpen() }
    );
    openConnections.push(conn);

    expect(conn.readingFrom).toBe("snapshot");
    expect(conn.snapshotPath).not.toBeNull();
    expect(existsSync(conn.snapshotPath!)).toBe(true);

    // The snapshot is a REAL backup() copy of the source — its committed row
    // is present.
    const rows = conn.db.prepare("SELECT v FROM t ORDER BY id").all() as { v: string }[];
    expect(rows.map((r) => r.v)).toContain("committed-before-lock");
  });

  it("close() removes the snapshot temp file", async () => {
    const { dbFilePath } = makeSource("wal-lock-cleanup.db");

    const conn = await openStashConnection(
      {
        path: dbFilePath,
        busyTimeoutMs: 20,
        maxDirectRetries: 2,
        directRetryBackoffMs: 20,
        maxSnapshotRetries: 20,
        snapshotRetryBackoffMs: 40,
      },
      { openDirectOnce: busyThrowingOpen() }
    );

    const snapshotPath = conn.snapshotPath;
    expect(snapshotPath).not.toBeNull();
    expect(existsSync(snapshotPath!)).toBe(true);

    conn.close();

    expect(existsSync(snapshotPath!)).toBe(false);
  });

  it("throws StashConnectionUnavailableError when BOTH tiers fail (direct busy, snapshot cannot even start)", async () => {
    const { dbFilePath } = makeSource("wal-lock-never-released.db");

    await expect(
      openStashConnection(
        {
          path: dbFilePath,
          busyTimeoutMs: 10,
          maxDirectRetries: 1,
          directRetryBackoffMs: 10,
          maxSnapshotRetries: 2,
          snapshotRetryBackoffMs: 10,
        },
        // Direct tier busy (injected) + a nonexistent snapshot base so
        // mkdtemp() cannot start the copy → both tiers fail.
        { openDirectOnce: busyThrowingOpen(), tmpDir: path.join(workDir, "no-such-snapshot-base") }
      )
    ).rejects.toThrow(StashConnectionUnavailableError);
  });

  it("leaves no leaked snapshot temp directory behind when the snapshot tier itself exhausts its retries", async () => {
    // Regression test: snapshotCopy's retry loop used to `throw lastError`
    // straight out of its `mkdtemp()`-created directory with nothing ever
    // removing it on the FAILURE path (cleanup only ran inside the success
    // path's returned `close()`) — every fully-failed snapshot attempt
    // leaked an empty temp directory. Here the snapshot tier's backup()
    // fails on EVERY retry because the source is a corrupt (non-SQLite)
    // file (errcode 26 SQLITE_NOTADB) — mkdtemp SUCCEEDS first, so this
    // exercises the post-mkdtemp cleanup, and a dedicated `tmpDir` (not the
    // real os.tmpdir()) makes any leak directly observable.
    const corruptPath = dbPath("wal-lock-snapshot-leak.db");
    writeFileSync(corruptPath, Buffer.from("not a sqlite database — a corrupt source that backup() rejects".repeat(4)));
    const snapshotTmpDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-adapter-snapshot-parent-"));

    await expect(
      openStashConnection(
        {
          path: corruptPath,
          busyTimeoutMs: 10,
          maxDirectRetries: 1,
          directRetryBackoffMs: 10,
          maxSnapshotRetries: 2,
          snapshotRetryBackoffMs: 10,
        },
        { openDirectOnce: busyThrowingOpen(), tmpDir: snapshotTmpDir }
      )
    ).rejects.toThrow(StashConnectionUnavailableError);

    expect(readdirSync(snapshotTmpDir)).toEqual([]);
    rmSync(snapshotTmpDir, { recursive: true, force: true });
  });
});
