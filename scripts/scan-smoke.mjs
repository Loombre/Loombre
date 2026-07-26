#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/scan-smoke.mjs
//
// Cross-OS scan CORRECTNESS smoke (Phase 1 wave 4: "scan a generated
// 500-file test library on each OS — case-sensitivity, path separators,
// long paths"). Unlike perf-t0.mjs's scanThroughput (which measures speed),
// this asserts the scanner produced exactly the expected catalog from a
// generated library that deliberately exercises the cross-platform horror
// cases:
//   - unicode titles (composed + CJK), mixed-case extensions (.MKV/.Mkv)
//   - dotted release-style names, {edition-...}, multi-part cd1/cd2
//   - deep nesting driving total paths to ~230 chars (Windows MAX_PATH
//     pressure without requiring the long-path registry opt-in)
//   - auxiliary junk that must be classified OUT (Featurettes/, sample
//     files, hidden dotfiles, .txt)
// It then rescans and asserts full idempotency (zero new rows), which is
// what actually catches case-folding and separator bugs: a path that
// round-trips differently on OS X/NTFS shows up as a duplicate or a
// re-hash on the second pass.
//
// Exit 0 = all assertions hold. Exit 1 = mismatch (printed). CI runs this
// on all three OS runners after `pnpm gate`.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { register } from "tsx/esm/api";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://loombre:loombre@localhost:5442/loombre";
const LIBRARY_NAME = "__scan_smoke__";
const LIBRARY_DIR = path.join(tmpdir(), "loombre-scan-smoke");

function importRepoModule(relPath) {
  return import(pathToFileURL(path.join(REPO_ROOT, relPath)).href);
}

/** Deterministic PRNG (mulberry32) — file sizes must not depend on run order. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates the library tree and returns the expectation manifest:
 * { expectedItems, expectedFiles, junkFiles }. Every generated media file
 * has a distinct pseudo-random size (1–4 MiB) so content hashes are unique.
 */
function generateLibrary(root) {
  const rand = prng(0x51ca9);
  const junk = [];
  let mediaFiles = 0;
  let items = 0;

  const write = (relPath, bytes) => {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    const size = 1_048_576 + Math.floor(rand() * 3_145_728) + bytes;
    const buf = Buffer.alloc(size);
    // Stamp the path into the head so no two files share a content hash.
    buf.write(relPath, 0, "utf8");
    writeFileSync(abs, buf);
  };

  // 470 plain parseable movies, a few unicode / dotted / mixed-case-ext.
  const unicodeTitles = ["Amélie", "千と千尋の神隠し", "Läther Øre", "Cafè Frånce"];
  for (let i = 0; i < 470; i++) {
    const year = 1960 + (i % 60);
    let dir;
    let file;
    if (i < 4) {
      dir = `${unicodeTitles[i]} (${year})`;
      file = `${unicodeTitles[i]} (${year}).mkv`;
    } else if (i % 97 === 0) {
      // dotted release-style name, parseable to (title, year)
      dir = `Smoke.Movie.${i}.${year}.1080p.BluRay.x264-GRP`;
      file = `Smoke.Movie.${i}.${year}.1080p.BluRay.x264-GRP.mkv`;
    } else if (i % 89 === 0) {
      // mixed-case extension — must still be treated as media
      dir = `Smoke Movie ${i} (${year})`;
      file = `Smoke Movie ${i} (${year}).MKV`;
    } else {
      dir = `Smoke Movie ${i} (${year})`;
      file = `Smoke Movie ${i} (${year}).mkv`;
    }
    write(path.join(dir, file), i);
    mediaFiles++;
    items++;
  }

  // 10 editions: 5 titles × 2 editions each → 5 items, 10 files.
  for (let i = 0; i < 5; i++) {
    const dir = `Edition Movie ${i} (2020)`;
    write(path.join(dir, `Edition Movie ${i} (2020) {edition-Theatrical}.mkv`), 9000 + i);
    write(path.join(dir, `Edition Movie ${i} (2020) {edition-Director's Cut}.mkv`), 9100 + i);
    mediaFiles += 2;
    items++;
  }

  // 10 multi-part: 5 titles × cd1/cd2 → 5 items, 10 files.
  for (let i = 0; i < 5; i++) {
    const dir = `Two Part Movie ${i} (1999)`;
    write(path.join(dir, `Two Part Movie ${i} (1999) cd1.mkv`), 9200 + i);
    write(path.join(dir, `Two Part Movie ${i} (1999) cd2.mkv`), 9300 + i);
    mediaFiles += 2;
    items++;
  }

  // 5 deep-nested long paths (~230 chars total).
  for (let i = 0; i < 5; i++) {
    const seg = `deep-segment-${i}-abcdefghijklmnopqrstuvwxyz`;
    const dir = path.join(seg, seg, seg, seg, `Long Path Movie ${i} (2011)`);
    write(path.join(dir, `Long Path Movie ${i} (2011).mkv`), 9400 + i);
    mediaFiles++;
    items++;
  }

  // Auxiliary junk: must be classified out, never becoming items/files.
  const junkPaths = [
    path.join("Smoke Movie 10 (1970)", "Featurettes", "making-of.mkv"),
    path.join("Smoke Movie 11 (1971)", "Smoke Movie 11 (1971).sample.mkv"),
    path.join("Smoke Movie 12 (1972)", "._hidden-resource-fork.mkv"),
    path.join("Smoke Movie 13 (1973)", "notes.txt"),
    path.join("Trailers", "teaser.mkv"),
  ];
  for (const p of junkPaths) {
    write(p, 999);
    junk.push(p);
  }

  return { expectedItems: items, expectedFiles: mediaFiles, junkFiles: junk };
}

function fail(msg) {
  console.error(`scan-smoke: FAIL — ${msg}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`scan-smoke: generating library under ${LIBRARY_DIR}`);
  rmSync(LIBRARY_DIR, { recursive: true, force: true });
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const manifest = generateLibrary(LIBRARY_DIR);
  const totalGenerated = manifest.expectedFiles + manifest.junkFiles.length;
  console.log(
    `scan-smoke: ${totalGenerated} files on disk — expecting ${manifest.expectedItems} items / ` +
      `${manifest.expectedFiles} media_files, ${manifest.junkFiles.length} junk excluded`,
  );

  const { createDb } = await import("@loombre/db");
  const { runScan } = await importRepoModule("apps/worker/src/scan/scanner.ts");
  const { createHashPool } = await importRepoModule("apps/worker/src/scan/identity/pool.ts");
  // Addendum A / lane S3: scan concurrency now resolves through the
  // settings system (env pin > DB row > CPU-derived default) — size the
  // pool exactly as apps/worker/src/index.ts does at scan-job start.
  const { loadWorkerEffectiveSettings, resolveScanConcurrencyFromEffective } = await importRepoModule(
    "apps/worker/src/settings/effective-settings.ts",
  );

  const db = createDb(DATABASE_URL);
  const hashPool = createHashPool(resolveScanConcurrencyFromEffective(await loadWorkerEffectiveSettings(db)));
  const noopQueue = { async enqueue() { return "noop"; } };
  let libraryId;

  try {
    await db.deleteFrom("libraries").where("name", "=", LIBRARY_NAME).execute();
    const now = Date.now();
    const library = await db
      .insertInto("libraries")
      .values({ name: LIBRARY_NAME, media_kind: "movie", paths: [LIBRARY_DIR], created_at_ms: now, updated_at_ms: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    libraryId = library.id;

    const countRows = async () => {
      const items = await db
        .selectFrom("catalog_items")
        .select(db.fn.countAll().as("n"))
        .where("library_id", "=", libraryId)
        .executeTakeFirstOrThrow();
      const files = await db
        .selectFrom("media_files")
        .innerJoin("catalog_items", "catalog_items.id", "media_files.item_id")
        .select(db.fn.countAll().as("n"))
        .where("catalog_items.library_id", "=", libraryId)
        .executeTakeFirstOrThrow();
      return { items: Number(items.n), files: Number(files.n) };
    };

    console.log("scan-smoke: pass 1 (cold scan)");
    await runScan({ db, queue: noopQueue, hashPool }, { libraryId, full: true }, { jobId: randomUUID() });
    const first = await countRows();
    if (first.items !== manifest.expectedItems) {
      fail(`pass 1 items: expected ${manifest.expectedItems}, got ${first.items}`);
    }
    if (first.files !== manifest.expectedFiles) {
      fail(`pass 1 media_files: expected ${manifest.expectedFiles}, got ${first.files}`);
    }

    console.log("scan-smoke: pass 2 (idempotent rescan)");
    await runScan({ db, queue: noopQueue, hashPool }, { libraryId, full: true }, { jobId: randomUUID() });
    const second = await countRows();
    if (second.items !== first.items || second.files !== first.files) {
      fail(
        `rescan not idempotent: pass1 ${first.items} items/${first.files} files → ` +
          `pass2 ${second.items} items/${second.files} files (case-folding/separator suspect)`,
      );
    }

    // No junk path may have produced a media_files row.
    for (const junkRel of manifest.junkFiles) {
      const junkAbs = path.join(LIBRARY_DIR, junkRel);
      const row = await db
        .selectFrom("media_files")
        .select("id")
        .where("path", "=", junkAbs)
        .executeTakeFirst();
      if (row) fail(`junk file became a media_files row: ${junkRel}`);
    }

    if (process.exitCode !== 1) {
      console.log(
        `scan-smoke: PASS — ${first.items} items, ${first.files} media files, ` +
          `junk excluded, rescan idempotent`,
      );
    }
  } finally {
    await hashPool.terminate().catch(() => {});
    if (libraryId) {
      await db.deleteFrom("libraries").where("id", "=", libraryId).execute().catch(() => {});
    }
    await db.destroy().catch(() => {});
    rmSync(LIBRARY_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("scan-smoke: crashed:", err);
  process.exit(1);
});
