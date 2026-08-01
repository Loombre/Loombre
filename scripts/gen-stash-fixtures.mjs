#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loombre :: scripts/gen-stash-fixtures.mjs
 *
 * Deterministic 33k-scene Stash SQLite fixture generator (STATE.md S10,
 * Stash SQLite metadata sync mission, deliverable 8) — follows
 * scripts/gen-media-fixtures.mjs's standalone-script precedent: zero
 * dependencies on any workspace package (only Node built-ins), output
 * written under test-fixtures/stash/ (gitignored, regenerated on demand,
 * never committed).
 *
 * Schema shape mirrors the same representative Stash DDL subset
 * apps/worker/test/stash/fixtures/schema-v85-supported-max.sql documents
 * (only the columns apps/worker/src/stash/read-model.ts actually reads) —
 * this is a second, independent instantiation of that same public,
 * documented subset (this lane's OWN test fixture builder,
 * apps/worker/test/stash/sync-fixtures/build-sync-fixture.ts, is a third;
 * all three describe the same real upstream shape at different scales).
 *
 * Distributions (STATE.md deliverable 8 — "realistic distributions"),
 * scaled proportionally to `--scenes` (default 33000, the owner's real
 * library size):
 *   - ~2,000 performers at 33k scale (1-4 credited per scene)
 *   - ~300 studios at 33k scale (~80% of scenes have one)
 *   - tags with hierarchy: ~40 root tags + ~110 child tags at 33k scale
 *     (1-5 tags per scene, drawn from the combined pool)
 *   - markers on ~30% of scenes (1-3 markers each)
 *   - oshash fingerprint present on ~90% of scene files (the other ~10%
 *     exercises S4's "oshash may be null" real-world gap)
 *
 * Deterministic: a mulberry32 PRNG seeded from `--seed` (default 42) means
 * the SAME arguments always produce byte-identical output — required for
 * the incremental-touch-count proof (scripts/stash-scale-proof.mjs mutates
 * a KNOWN subset of scene ids by re-opening the generated file, so the id
 * scheme itself must be stable run to run).
 *
 * CLI: node scripts/gen-stash-fixtures.mjs [--scenes N] [--seed N] [--out path]
 * Importable: exports generateStashFixture(options) for
 * scripts/stash-scale-proof.mjs to call in-process (no subprocess
 * overhead skewing the scale-proof's own timing/RSS measurements, which
 * start AFTER generation completes).
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "test-fixtures", "stash");

const SCHEMA_SQL = `
CREATE TABLE schema_migrations (version uint64, dirty bool);
CREATE UNIQUE INDEX version_unique ON schema_migrations (version);
INSERT INTO schema_migrations (version, dirty) VALUES (85, 0);

CREATE TABLE blobs (checksum TEXT NOT NULL PRIMARY KEY, blob BLOB);

CREATE TABLE studios (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  details TEXT,
  rating TINYINT,
  image_blob TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE tags (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  description TEXT,
  image_blob TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE tags_relations (parent_id INTEGER, child_id INTEGER, PRIMARY KEY (parent_id, child_id));

CREATE TABLE performers (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  disambiguation TEXT,
  gender TEXT,
  birthdate DATE,
  country TEXT,
  measurements TEXT,
  details TEXT,
  rating TINYINT,
  image_blob TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE performer_aliases (performer_id INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (performer_id, alias));

CREATE TABLE folders (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  basename TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_folder_id INTEGER,
  mod_time DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);
CREATE UNIQUE INDEX index_folders_on_path_unique ON folders (path);

CREATE TABLE files (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  basename TEXT NOT NULL,
  parent_folder_id INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mod_time DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE files_fingerprints (
  file_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  fingerprint BLOB NOT NULL,
  PRIMARY KEY (file_id, type, fingerprint)
);

CREATE TABLE scenes (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  details TEXT,
  date DATE,
  rating TINYINT,
  studio_id INTEGER,
  code TEXT,
  director TEXT,
  organized BOOLEAN NOT NULL DEFAULT 0,
  cover_blob TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE scenes_files (scene_id INTEGER NOT NULL, file_id INTEGER NOT NULL, "primary" BOOLEAN NOT NULL, PRIMARY KEY (scene_id, file_id));
CREATE TABLE performers_scenes (performer_id INTEGER, scene_id INTEGER, PRIMARY KEY (scene_id, performer_id));
CREATE TABLE scenes_tags (scene_id INTEGER, tag_id INTEGER, PRIMARY KEY (scene_id, tag_id));

CREATE TABLE scene_markers (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  seconds FLOAT NOT NULL,
  end_seconds FLOAT,
  primary_tag_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);
`;

/** mulberry32 — tiny, dependency-free, deterministic PRNG (public-domain
 *  algorithm; independent implementation from the well-known formula, same
 *  posture as oshash.ts's own "clean-room implementation of a public
 *  algorithm" note). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function pickN(rng, arr, n) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

const FIRST_NAMES = ["Ava", "Mia", "Zoe", "Nora", "Luna", "Ivy", "Ruby", "Elle", "Sadie", "Vera", "Wren", "Iris", "Nova", "June", "Rose"];
const LAST_NAMES = ["Storm", "Vale", "Reed", "Fox", "Sage", "Wilde", "Cross", "Blaze", "Grey", "Frost", "Cole", "Stone", "Hart", "Lane", "Vaughn"];
const STUDIO_WORDS = ["Northlight", "Amber", "Cobalt", "Ember", "Marble", "Solace", "Halcyon", "Onyx", "Meridian", "Velvet", "Crescent", "Lumen"];
const STUDIO_SUFFIXES = ["Studios", "Media", "Films", "Productions", "Collective"];
const TAG_ROOTS = ["Genre", "Setting", "Mood", "Era", "Style", "Theme"];
const TAG_LEAVES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];

export function generateStashFixture(options = {}) {
  const sceneCount = options.sceneCount ?? 33000;
  const seed = options.seed ?? 42;
  const outputPath = options.outputPath ?? path.join(DEFAULT_OUTPUT_DIR, `stash-${sceneCount}.sqlite`);

  const rng = mulberry32(seed);

  const performerCount = Math.max(5, Math.round((sceneCount * 2000) / 33000));
  const studioCount = Math.max(2, Math.round((sceneCount * 300) / 33000));
  const tagRootCount = Math.max(3, Math.round((sceneCount * 40) / 33000));
  const tagLeafCount = Math.max(5, Math.round((sceneCount * 110) / 33000));

  mkdirSync(path.dirname(outputPath), { recursive: true });
  if (existsSync(outputPath)) rmSync(outputPath, { force: true });

  const db = new DatabaseSync(outputPath);
  db.exec(SCHEMA_SQL);
  db.exec("BEGIN");

  const now = "2026-07-01 00:00:00";

  // Studios.
  const studioIds = [];
  const insertStudio = db.prepare("INSERT INTO studios (id, name, parent_id, details, rating, image_blob, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)");
  for (let i = 1; i <= studioCount; i++) {
    insertStudio.run(i, `${pick(rng, STUDIO_WORDS)} ${pick(rng, STUDIO_SUFFIXES)} ${i}`, now, now);
    studioIds.push(i);
  }

  // Tags: roots then leaves (each leaf gets a random root parent —
  // hierarchy, S6/K2's tag.kind mapping consumes this on the apply side).
  const insertTag = db.prepare("INSERT INTO tags (id, name, description, image_blob, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)");
  const insertTagRelation = db.prepare("INSERT INTO tags_relations (parent_id, child_id) VALUES (?, ?)");
  const rootTagIds = [];
  let tagId = 1;
  for (let i = 0; i < tagRootCount; i++) {
    insertTag.run(tagId, `${pick(rng, TAG_ROOTS)} ${i}`, now, now);
    rootTagIds.push(tagId);
    tagId++;
  }
  const leafTagIds = [];
  for (let i = 0; i < tagLeafCount; i++) {
    insertTag.run(tagId, `${pick(rng, TAG_LEAVES)} ${i}`, now, now);
    insertTagRelation.run(pick(rng, rootTagIds), tagId);
    leafTagIds.push(tagId);
    tagId++;
  }
  const allTagIds = [...rootTagIds, ...leafTagIds];

  // Performers.
  const insertPerformer = db.prepare(
    "INSERT INTO performers (id, name, disambiguation, gender, birthdate, country, measurements, details, rating, image_blob, created_at, updated_at) VALUES (?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)"
  );
  const performerIds = [];
  for (let i = 1; i <= performerCount; i++) {
    insertPerformer.run(i, `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)} ${i}`, rng() < 0.5 ? "FEMALE" : "MALE", now, now);
    performerIds.push(i);
  }

  // Scenes + files + folders + fingerprints + performer/tag credits + markers.
  const folderPath = "/stash-media";
  db.prepare("INSERT INTO folders (id, basename, path, parent_folder_id, mod_time, created_at, updated_at) VALUES (1, 'stash-media', ?, NULL, ?, ?, ?)").run(folderPath, now, now, now);

  const insertFile = db.prepare("INSERT INTO files (id, basename, parent_folder_id, size, mod_time, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)");
  const insertFingerprint = db.prepare("INSERT INTO files_fingerprints (file_id, type, fingerprint) VALUES (?, 'oshash', ?)");
  const insertScene = db.prepare(
    "INSERT INTO scenes (id, title, details, date, rating, studio_id, code, director, organized, cover_blob, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 0, NULL, ?, ?)"
  );
  const insertSceneFile = db.prepare('INSERT INTO scenes_files (scene_id, file_id, "primary") VALUES (?, ?, 1)');
  const insertPerformerScene = db.prepare("INSERT INTO performers_scenes (performer_id, scene_id) VALUES (?, ?)");
  const insertSceneTag = db.prepare("INSERT INTO scenes_tags (scene_id, tag_id) VALUES (?, ?)");
  const insertMarker = db.prepare("INSERT INTO scene_markers (title, seconds, end_seconds, primary_tag_id, scene_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");

  const manifest = { unmatched: [], matched: [] };
  // ~2% of scenes deliberately have no matching Loombre file (S4 "unmatched
  // Stash scenes land visibly" proof at scale).
  const unmatchedFraction = options.unmatchedFraction ?? 0.02;

  for (let id = 1; id <= sceneCount; id++) {
    const basename = `scene-${String(id).padStart(6, "0")}.mp4`;
    const sizeBytes = 1000 + (id % 5000);
    insertFile.run(id, basename, sizeBytes, now, now, now);
    if (rng() < 0.9) {
      // Deterministic per-id fake oshash — doesn't need to be a REAL
      // oshash (S4's oshash tier is exercised at small scale by this
      // lane's other tests; at 33k scale the point is realistic
      // PRESENCE/absence distribution, not byte-exact hash correctness).
      insertFingerprint.run(id, `fake-oshash-${id.toString(16).padStart(16, "0")}`);
    }

    insertScene.run(id, `Scene ${id}`, rng() < 0.7 ? `Details for scene ${id}.` : null, rng() < 0.8 ? pick(rng, studioIds) : null, now, now);
    insertSceneFile.run(id, id);

    for (const performerId of pickN(rng, performerIds, 1 + Math.floor(rng() * 4))) {
      insertPerformerScene.run(performerId, id);
    }
    for (const t of pickN(rng, allTagIds, 1 + Math.floor(rng() * 5))) {
      insertSceneTag.run(id, t);
    }
    if (rng() < 0.3) {
      const markerCount = 1 + Math.floor(rng() * 3);
      for (let m = 0; m < markerCount; m++) {
        const startSeconds = Math.floor(rng() * 3600);
        insertMarker.run(`Marker ${m + 1}`, startSeconds, null, pick(rng, allTagIds), id, now, now);
      }
    }

    if (rng() < unmatchedFraction) {
      manifest.unmatched.push({ id, basename, sizeBytes });
    } else {
      manifest.matched.push({ id, basename, sizeBytes });
    }
  }

  db.exec("COMMIT");
  db.close();

  return { outputPath, manifest, counts: { sceneCount, performerCount, studioCount, tagCount: allTagIds.length } };
}

// CLI entry point (only when invoked directly, not when imported by
// scripts/stash-scale-proof.mjs).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  function argValue(flag, fallback) {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] !== undefined ? args[idx + 1] : fallback;
  }
  const sceneCount = Number.parseInt(argValue("--scenes", "33000"), 10);
  const seed = Number.parseInt(argValue("--seed", "42"), 10);
  const outArg = argValue("--out", null);
  const outputPath = outArg ? path.resolve(outArg) : undefined;

  const started = Date.now();
  const result = generateStashFixture({ sceneCount, seed, ...(outputPath ? { outputPath } : {}) });
  const elapsedMs = Date.now() - started;
  console.log(
    `[gen-stash-fixtures] wrote ${result.counts.sceneCount} scenes (${result.counts.performerCount} performers, ${result.counts.studioCount} studios, ${result.counts.tagCount} tags) to ${result.outputPath} in ${elapsedMs}ms — ${result.manifest.matched.length} matchable, ${result.manifest.unmatched.length} deliberately unmatched`
  );
}
