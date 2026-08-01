// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/sync-fixtures/build-sync-fixture.ts
//
// Lane C's OWN test-fixture builder for sync-consumer.spec.ts and
// inventory-consumer.spec.ts — a SEPARATE directory from Lane A's
// checked-in apps/worker/test/stash/fixtures/ (never edited by this
// lane), because these tests need PROGRAMMATIC, per-test control over
// exactly which scenes exist and their `updated_at` values (the
// incremental-diff and checkpoint-resume tests each need a different
// scene set/timestamp from the same schema shape) — a single static .sql
// file per scenario would multiply indefinitely. Schema shape is the SAME
// representative subset apps/worker/test/stash/fixtures/schema-v85-supported-max.sql
// documents (only the columns read-model.ts actually reads) — this is a
// second, independent instantiation of that same public, documented DDL
// subset, not a copy of Lane A's file.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

CREATE TABLE tags_relations (
  parent_id INTEGER,
  child_id INTEGER,
  PRIMARY KEY (parent_id, child_id)
);

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

export interface FixtureScene {
  /** Stash's own integer scene id. */
  id: number;
  title: string;
  /** Folder path + basename — joined verbatim by read-model.ts. */
  folderPath: string;
  basename: string;
  sizeBytes: number;
  /** SQLite DATETIME text, e.g. '2023-06-15 10:00:00'. */
  updatedAt: string;
}

export interface BuildSyncFixtureResult {
  db: DatabaseSync;
  dbPath: string;
  dir: string;
}

/** Builds a fresh Stash-shaped SQLite database (schema 85, in the pinned
 *  supported range) with exactly the given scenes — no performers/tags/
 *  studio/markers (tests that need those insert them directly against the
 *  returned `db` handle before closing it). Returns an OPEN read-write
 *  handle; callers close it and reopen read-only via
 *  apps/worker/src/stash/adapter.ts's openStashConnection, exactly like
 *  apps/worker/test/stash/fixtures/build-fixture-db.ts's own convention. */
export function buildSyncFixtureDb(scenes: readonly FixtureScene[]): BuildSyncFixtureResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'loombre-stash-sync-fixture-'));
  const dbPath = path.join(dir, 'stash.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  const folderIds = new Map<string, number>();
  let nextFolderId = 1;
  function folderIdFor(folderPath: string): number {
    let id = folderIds.get(folderPath);
    if (id !== undefined) return id;
    id = nextFolderId++;
    folderIds.set(folderPath, id);
    db.prepare('INSERT INTO folders (id, basename, path, parent_folder_id, mod_time, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)').run(
      id,
      path.basename(folderPath),
      folderPath,
      '2023-01-01 00:00:00',
      '2023-01-01 00:00:00',
      '2023-01-01 00:00:00'
    );
    return id;
  }

  for (const scene of scenes) {
    const folderId = folderIdFor(scene.folderPath);
    db.prepare('INSERT INTO files (id, basename, parent_folder_id, size, mod_time, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      scene.id,
      scene.basename,
      folderId,
      scene.sizeBytes,
      scene.updatedAt,
      scene.updatedAt,
      scene.updatedAt
    );
    db.prepare(
      'INSERT INTO scenes (id, title, details, date, rating, studio_id, code, director, organized, cover_blob, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)'
    ).run(scene.id, scene.title, scene.updatedAt, scene.updatedAt);
    db.prepare('INSERT INTO scenes_files (scene_id, file_id, "primary") VALUES (?, ?, 1)').run(scene.id, scene.id);
  }

  return { db, dbPath, dir };
}
