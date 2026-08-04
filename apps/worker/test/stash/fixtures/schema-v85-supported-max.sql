-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: apps/worker/test/stash/fixtures/schema-v85-supported-max.sql
--
-- Upper bound of the pinned supported range (STASH_SUPPORTED_SCHEMA_MAX =
-- 85, guard.ts). Schema shape as of Stash v0.31.1 (2026-04-13, the newest
-- stable release as of this recon — also the schema version at develop
-- HEAD, i.e. nothing newer exists upstream yet) — see this directory's
-- README.md for the full derivation. Notably: `folders` GAINS a
-- `basename` column at this version (schema 84, additive) — this fixture
-- exercises the read-model's "column present" path, paired with
-- schema-v67-supported-min.sql's "column absent" path.
--
-- This is a REPRESENTATIVE SUBSET of the real upstream DDL (only the
-- columns apps/worker/src/stash/read-model.ts actually reads), not an
-- exhaustive byte-for-byte replica — see README.md's "Fidelity" section.

CREATE TABLE schema_migrations (version uint64, dirty bool);
CREATE UNIQUE INDEX version_unique ON schema_migrations (version);
INSERT INTO schema_migrations (version, dirty) VALUES (85, 0);

CREATE TABLE blobs (
  checksum TEXT NOT NULL PRIMARY KEY,
  blob BLOB
);

CREATE TABLE studios (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER DEFAULT NULL REFERENCES studios(id) ON DELETE SET NULL,
  details TEXT,
  rating TINYINT,
  image_blob TEXT REFERENCES blobs(checksum),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE tags (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  description TEXT,
  image_blob TEXT REFERENCES blobs(checksum),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE tags_relations (
  parent_id INTEGER,
  child_id INTEGER,
  PRIMARY KEY (parent_id, child_id),
  FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE CASCADE,
  FOREIGN KEY (child_id) REFERENCES tags(id) ON DELETE CASCADE
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
  image_blob TEXT REFERENCES blobs(checksum),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE performer_aliases (
  performer_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (performer_id, alias),
  FOREIGN KEY (performer_id) REFERENCES performers(id) ON DELETE CASCADE
);

CREATE TABLE folders (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  basename TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_folder_id INTEGER,
  mod_time DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (parent_folder_id) REFERENCES folders(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX index_folders_on_path_unique ON folders (path);

CREATE TABLE files (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  basename TEXT NOT NULL,
  parent_folder_id INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mod_time DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (parent_folder_id) REFERENCES folders(id),
  CHECK (basename != '')
);

CREATE TABLE files_fingerprints (
  file_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  fingerprint BLOB NOT NULL,
  PRIMARY KEY (file_id, type, fingerprint),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE scenes (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  details TEXT,
  date DATE,
  date_precision TINYINT,
  rating TINYINT,
  studio_id INTEGER,
  code TEXT,
  director TEXT,
  organized BOOLEAN NOT NULL DEFAULT 0,
  cover_blob TEXT REFERENCES blobs(checksum),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE SET NULL
);

CREATE TABLE scenes_files (
  scene_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  "primary" BOOLEAN NOT NULL,
  PRIMARY KEY (scene_id, file_id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE performers_scenes (
  performer_id INTEGER,
  scene_id INTEGER,
  PRIMARY KEY (scene_id, performer_id),
  FOREIGN KEY (performer_id) REFERENCES performers(id) ON DELETE CASCADE,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

CREATE TABLE scenes_tags (
  scene_id INTEGER,
  tag_id INTEGER,
  PRIMARY KEY (scene_id, tag_id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE scene_markers (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  seconds FLOAT NOT NULL,
  end_seconds FLOAT,
  primary_tag_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (primary_tag_id) REFERENCES tags(id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id)
);

-- ============================================================================
-- seed data
-- ============================================================================

INSERT INTO blobs (checksum, blob) VALUES ('studio1img', X'0A0B0C0D0E0F1011');
INSERT INTO blobs (checksum, blob) VALUES ('scene1cover', X'0102030405060708');

INSERT INTO studios (id, name, parent_id, details, rating, image_blob, created_at, updated_at)
  VALUES (1, 'Acme Studios', NULL, 'A test studio.', 80, 'studio1img', '2023-01-01 00:00:00', '2023-01-02 00:00:00');

INSERT INTO tags (id, name, description, image_blob, created_at, updated_at)
  VALUES (1, 'Action', 'Root tag', NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
INSERT INTO tags (id, name, description, image_blob, created_at, updated_at)
  VALUES (2, 'Fight Scene', 'Child of Action', NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
INSERT INTO tags_relations (parent_id, child_id) VALUES (1, 2);

INSERT INTO performers (id, name, disambiguation, gender, birthdate, country, measurements, details, rating, image_blob, created_at, updated_at)
  VALUES (1, 'Jane Doe', NULL, 'FEMALE', '1990-05-01', 'USA', '34-24-35', 'Bio text for Jane.', 90, NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
INSERT INTO performer_aliases (performer_id, alias) VALUES (1, 'Jane D.');
INSERT INTO performer_aliases (performer_id, alias) VALUES (1, 'JD');

INSERT INTO performers (id, name, disambiguation, gender, birthdate, country, measurements, details, rating, image_blob, created_at, updated_at)
  VALUES (2, 'John Smith', NULL, 'MALE', NULL, NULL, NULL, NULL, NULL, NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');

INSERT INTO folders (id, basename, path, parent_folder_id, mod_time, created_at, updated_at)
  VALUES (1, 'videos', '/data/videos', NULL, '2023-06-01 00:00:00', '2023-06-01 00:00:00', '2023-06-01 00:00:00');
INSERT INTO folders (id, basename, path, parent_folder_id, mod_time, created_at, updated_at)
  VALUES (2, 'sub', '/data/videos/sub', 1, '2023-06-01 00:00:00', '2023-06-01 00:00:00', '2023-06-01 00:00:00');

INSERT INTO files (id, basename, parent_folder_id, size, mod_time, created_at, updated_at)
  VALUES (1, 'scene-one.mp4', 1, 104857600, '2023-06-15 10:00:00', '2023-06-15 10:00:00', '2023-06-15 10:00:00');
INSERT INTO files (id, basename, parent_folder_id, size, mod_time, created_at, updated_at)
  VALUES (2, 'scene-two.mkv', 2, 52428800, '2023-06-16 10:00:00', '2023-06-16 10:00:00', '2023-06-16 10:00:00');

INSERT INTO files_fingerprints (file_id, type, fingerprint) VALUES (1, 'oshash', 'a1b2c3d4e5f6a7b8');
INSERT INTO files_fingerprints (file_id, type, fingerprint) VALUES (1, 'md5', 'deadbeefdeadbeefdeadbeefdeadbeef');
-- Real Stash stores a per-file `phash` (perceptual hash) as a raw signed
-- int64 in this same blob-affinity column — a value that routinely exceeds
-- JS's safe-integer range. Present here so the read model is exercised
-- against the real column shape (a bare SELECT of the fingerprint value
-- would make node:sqlite throw ERR_OUT_OF_RANGE before type-filtering).
-- The owner's real 43k-scene DB exposed this; the fixture now carries it.
INSERT INTO files_fingerprints (file_id, type, fingerprint) VALUES (1, 'phash', -9223314888072965413);
INSERT INTO files_fingerprints (file_id, type, fingerprint) VALUES (2, 'oshash', 'ffeeddccbbaa9988');
INSERT INTO files_fingerprints (file_id, type, fingerprint) VALUES (2, 'phash', 8858502847294208013);

INSERT INTO scenes (id, title, details, date, date_precision, rating, studio_id, code, director, organized, cover_blob, created_at, updated_at)
  VALUES (1, 'Scene One', 'Details for scene one.', '2023-06-15', 1, 85, 1, 'ABC-123', 'Some Director', 1, 'scene1cover', '2023-06-01 00:00:00', '2023-06-16 12:00:00');
INSERT INTO scenes (id, title, details, date, date_precision, rating, studio_id, code, director, organized, cover_blob, created_at, updated_at)
  VALUES (2, 'Scene Two', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, '2023-06-02 00:00:00', '2023-06-02 00:00:00');

INSERT INTO scenes_files (scene_id, file_id, "primary") VALUES (1, 1, 1);
INSERT INTO scenes_files (scene_id, file_id, "primary") VALUES (2, 2, 1);

INSERT INTO performers_scenes (performer_id, scene_id) VALUES (1, 1);
INSERT INTO performers_scenes (performer_id, scene_id) VALUES (2, 1);

INSERT INTO scenes_tags (scene_id, tag_id) VALUES (1, 1);
INSERT INTO scenes_tags (scene_id, tag_id) VALUES (1, 2);

INSERT INTO scene_markers (id, title, seconds, end_seconds, primary_tag_id, scene_id, created_at, updated_at)
  VALUES (1, 'Marker One', 30.5, 45.0, 2, 1, '2023-06-15 10:00:00', '2023-06-15 10:00:00');
