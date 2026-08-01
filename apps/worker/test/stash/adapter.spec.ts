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
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StashConnectionUnavailableError } from "../../src/stash/errors.js";
import { openStashConnection, type StashConnection } from "../../src/stash/adapter.js";

let workDir: string;
const openConnections: StashConnection[] = [];
const writerHandles: DatabaseSync[] = [];

afterEach(() => {
  for (const conn of openConnections.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed by the test itself — fine.
    }
  }
  for (const writer of writerHandles.splice(0)) {
    try {
      writer.close();
    } catch {
      // already closed.
    }
  }
});

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

/**
 * A fixture whose writer holds an EXCLUSIVE lock (via `PRAGMA
 * locking_mode=EXCLUSIVE` + an open `BEGIN IMMEDIATE` transaction, never
 * committed until the caller releases it) — the standard, reliable way to
 * force a concurrent reader into SQLITE_BUSY, standing in for "a running
 * Stash instance holds the database locked" (true WAL contention that
 * reliably blocks a reader is otherwise vanishingly rare by WAL's own
 * design, which is exactly why this simulation is necessary).
 *
 * Returns `baselineHash`/`baselineMtimeMs` captured AFTER the initial
 * committed row but BEFORE the lock-taking (uncommitted) write — the
 * correct baseline for an fs-immutability assertion, since the
 * UNCOMMITTED insert lives only in the WAL sidecar until something
 * commits it (never, if the caller's session under test never calls
 * `release()`) and must not be conflated with a genuine write BY
 * LOOMBRE'S OWN adapter, which is what S2 actually constrains.
 */
function makeLockedFixture(name: string): {
  dbFilePath: string;
  baselineHash: string;
  baselineMtimeMs: number;
  release: () => void;
} {
  const p = dbPath(name);
  const writer = new DatabaseSync(p);
  writer.exec("PRAGMA journal_mode=WAL;");
  writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
  writer.exec("INSERT INTO t (v) VALUES ('committed-before-lock');");

  const baselineHash = fileHash(p);
  const baselineMtimeMs = statSync(p).mtimeMs;

  writer.exec("PRAGMA locking_mode=EXCLUSIVE;");
  writer.exec("BEGIN IMMEDIATE;");
  writer.exec("INSERT INTO t (v) VALUES ('mid-write-uncommitted');");
  writerHandles.push(writer);
  let released = false;
  return {
    dbFilePath: p,
    baselineHash,
    baselineMtimeMs,
    release: () => {
      if (released) return;
      released = true;
      writer.exec("COMMIT;");
      writer.close();
    },
  };
}

/**
 * A lock that blocks a concurrent reader WITHOUT ever changing a byte of
 * the source database (R2 audit). `PRAGMA locking_mode=EXCLUSIVE` plus a
 * `BEGIN IMMEDIATE` that writes NOTHING takes the write lock — a
 * concurrent read-only opener still gets SQLITE_BUSY (errcode 5, verified
 * empirically before this helper was written) — and `ROLLBACK` + `close()`
 * releases it leaving the `.db` file byte- and mtime-identical to before
 * the lock was taken, sidecars removed.
 *
 * That last property is the whole point, and it is what makeLockedFixture
 * above CANNOT offer: its release() COMMITs a real insert, so the source
 * legitimately changes at release time and no fs-immutability assertion
 * can span it. This helper therefore makes the SUCCESSFUL snapshot-
 * fallback path assertable at the fs level — previously only the FAILED
 * fallback path (both tiers exhausted) carried a bytes/mtime proof, which
 * left S2's actual production fallback unproven where it matters most.
 */
function makeWriteFreeLockedFixture(name: string): {
  dbFilePath: string;
  baselineHash: string;
  baselineMtimeMs: number;
  release: () => void;
} {
  const p = dbPath(name);
  const writer = new DatabaseSync(p);
  writer.exec("PRAGMA journal_mode=WAL;");
  writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
  writer.exec("INSERT INTO t (v) VALUES ('committed-before-lock');");
  writer.close(); // checkpoints + removes sidecars, so the baseline is a settled file

  const baselineHash = fileHash(p);
  const baselineMtimeMs = statSync(p).mtimeMs;

  const locker = new DatabaseSync(p);
  locker.exec("PRAGMA locking_mode=EXCLUSIVE;");
  locker.exec("BEGIN IMMEDIATE;"); // takes the write lock; writes nothing
  writerHandles.push(locker);

  let released = false;
  return {
    dbFilePath: p,
    baselineHash,
    baselineMtimeMs,
    release: () => {
      if (released) return;
      released = true;
      try {
        locker.exec("ROLLBACK;");
      } catch {
        // already rolled back — the close below is what releases the lock.
      }
      locker.close();
    },
  };
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
    // The writer's lock is deliberately NEVER released during this test —
    // both the direct-open and snapshot-copy tiers exhaust their retry
    // budgets and the call rejects. Bytes/mtime are compared against the
    // baseline captured right after the last COMMITTED write (before the
    // lock-taking, never-committed insert) — the correct fs-immutability
    // assertion for what S2 actually constrains: Loombre's OWN adapter
    // must never write to the source, regardless of the writer's own
    // (unrelated, never-committed-in-this-test) activity.
    const { dbFilePath, baselineHash, baselineMtimeMs } = makeLockedFixture("fs-proof-locked.db");

    await expect(
      openStashConnection({
        path: dbFilePath,
        busyTimeoutMs: 10,
        maxDirectRetries: 1,
        directRetryBackoffMs: 10,
        maxSnapshotRetries: 2,
        snapshotRetryBackoffMs: 10,
      })
    ).rejects.toThrow(StashConnectionUnavailableError);

    expect(fileHash(dbFilePath)).toBe(baselineHash);
    expect(statSync(dbFilePath).mtimeMs).toBe(baselineMtimeMs);
  });

  it("source file bytes AND mtime are unchanged across a SUCCESSFUL snapshot-copy fallback", async () => {
    // The production fallback path (S2's whole point), asserted at the fs
    // level for the first time — the test above only covers the case where
    // the fallback FAILS. Uses the write-free lock (see its helper's doc
    // comment) so the lock-holder itself contributes no byte changes and
    // any difference in the source can only be Loombre's own doing.
    const { dbFilePath, baselineHash, baselineMtimeMs, release } = makeWriteFreeLockedFixture("fs-proof-snapshot-success.db");
    const releaseTimer = setTimeout(() => release(), 150);

    const conn = await openStashConnection({
      path: dbFilePath,
      busyTimeoutMs: 20,
      maxDirectRetries: 1,
      directRetryBackoffMs: 20,
      maxSnapshotRetries: 20,
      snapshotRetryBackoffMs: 40,
    });
    clearTimeout(releaseTimer);
    release();

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

describe("openStashConnection — WAL-locked retry -> snapshot fallback (S2)", () => {
  it("retries the direct open, then falls back to a snapshot copy once the lock outlasts the retry budget", async () => {
    const { dbFilePath, release } = makeLockedFixture("wal-lock-fallback.db");
    setTimeout(() => release(), 200);

    const conn = await openStashConnection({
      path: dbFilePath,
      busyTimeoutMs: 20,
      maxDirectRetries: 2,
      directRetryBackoffMs: 20,
      maxSnapshotRetries: 20,
      snapshotRetryBackoffMs: 40,
    });
    openConnections.push(conn);

    expect(conn.readingFrom).toBe("snapshot");
    expect(conn.snapshotPath).not.toBeNull();
    expect(existsSync(conn.snapshotPath!)).toBe(true);

    // The snapshot must reflect at least the COMMITTED state as of
    // whenever the backup actually completed — the pre-lock row is always
    // present regardless of timing.
    const rows = conn.db.prepare("SELECT v FROM t ORDER BY id").all() as { v: string }[];
    expect(rows.map((r) => r.v)).toContain("committed-before-lock");
  });

  it("close() removes the snapshot temp file", async () => {
    const { dbFilePath, release } = makeLockedFixture("wal-lock-cleanup.db");
    setTimeout(() => release(), 150);

    const conn = await openStashConnection({
      path: dbFilePath,
      busyTimeoutMs: 20,
      maxDirectRetries: 2,
      directRetryBackoffMs: 20,
      maxSnapshotRetries: 20,
      snapshotRetryBackoffMs: 40,
    });

    const snapshotPath = conn.snapshotPath;
    expect(snapshotPath).not.toBeNull();
    expect(existsSync(snapshotPath!)).toBe(true);

    conn.close();

    expect(existsSync(snapshotPath!)).toBe(false);
  });

  it("throws StashConnectionUnavailableError when the lock outlasts BOTH retry budgets", async () => {
    const { dbFilePath } = makeLockedFixture("wal-lock-never-released.db");
    // Deliberately never release() — both tiers must exhaust and fail.

    await expect(
      openStashConnection({
        path: dbFilePath,
        busyTimeoutMs: 10,
        maxDirectRetries: 1,
        directRetryBackoffMs: 10,
        maxSnapshotRetries: 2,
        snapshotRetryBackoffMs: 10,
      })
    ).rejects.toThrow(StashConnectionUnavailableError);
  });

  it("leaves no leaked snapshot temp directory behind when the snapshot tier itself exhausts its retries", async () => {
    // Regression test: snapshotCopy's retry loop used to `throw lastError`
    // straight out of its `mkdtemp()`-created directory with nothing ever
    // removing it on the FAILURE path (cleanup only ran inside the
    // success path's returned `close()`) — every fully-failed snapshot
    // attempt leaked an empty temp directory. A dedicated `tmpDir` here
    // (rather than the real os.tmpdir()) makes the leak directly
    // observable.
    const { dbFilePath } = makeLockedFixture("wal-lock-snapshot-leak.db");
    const snapshotTmpDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-adapter-snapshot-parent-"));

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
        { tmpDir: snapshotTmpDir }
      )
    ).rejects.toThrow(StashConnectionUnavailableError);

    expect(readdirSync(snapshotTmpDir)).toEqual([]);
    rmSync(snapshotTmpDir, { recursive: true, force: true });
  });
});
