// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/read-model.ts
//
// Typed reads over an already-open, already-guard-passed Stash connection
// (apps/worker/src/stash/adapter.ts's StashConnection.db). Schema
// knowledge lives ONLY here (and in the checked-in fixtures under
// test/stash/fixtures/, whose README.md records the upstream DDL this was
// derived from) — adapter.ts and guard.ts know nothing about Stash's
// table shapes.
//
// Path reconstruction (getSceneFiles/listScenesForInventory): Stash's
// `folders.path` column stores the folder's FULL absolute path already
// (confirmed against upstream, README.md's provenance section) — a file's
// path is simply `folders.path` (for `files.parent_folder_id`) joined with
// `files.basename`. This holds across the whole pinned range regardless
// of whether `folders.basename` exists as a column (added at schema 84) —
// this read-model never reads `folders.basename` at all, so it needs no
// version branch for that column's presence/absence (proven identically
// against both boundary fixtures in read-model.spec.ts).
//
// Milliseconds everywhere (CLAUDE.md invariant 5): every *_at/*_time
// column Stash stores as `DATETIME` text (`YYYY-MM-DD HH:MM:SS`, UTC — Go's
// database/sql driver default for SQLite) is converted to epoch ms at the
// read-model boundary; nothing above this file ever sees a Stash date
// string.
//
// Cover/avatar images: Stash's `blobs` table can hold `blob IS NULL` for a
// checksum row when Stash is configured for filesystem-backed blob
// storage instead of in-database storage (pkg/sqlite/blob.go, see
// test/stash/fixtures/README.md's Fidelity section) — getBlob returns
// `bytes: null` in that case rather than throwing; Lane B's image-ingest
// consumer must treat that as "no bytes available from the SQLite side"
// (a real, documented gap — see this lane's freeze report).

export interface SqliteReadable {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

function toEpochMs(value: unknown): number {
  if (value == null) return 0;
  const str = String(value);
  const iso = str.includes('T') ? str : `${str.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function toStr(value: unknown): string {
  return String(value);
}

function toNullableStr(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toNullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function toBool(value: unknown): boolean {
  return Boolean(value);
}

/** Joins a Stash folder's (already-absolute) path with a file's basename,
 *  preserving whichever separator convention the folder path already uses
 *  (Stash may have scanned a POSIX or a Windows filesystem). */
function joinFolderAndBasename(folderPath: string, basename: string): string {
  const usesBackslash = folderPath.includes('\\') && !folderPath.includes('/');
  const sep = usesBackslash ? '\\' : '/';
  const trimmed = folderPath.length > 1 ? folderPath.replace(/[\\/]+$/, '') : folderPath;
  return `${trimmed}${sep}${basename}`;
}

// ============================================================================
// scenes
// ============================================================================

export interface StashScene {
  id: string;
  title: string | null;
  details: string | null;
  /** Stash's `date` column verbatim (`YYYY-MM-DD`) — a partial calendar
   *  date, not converted to epoch ms (there is no time-of-day component to
   *  anchor a timezone-correct instant to). Lane B maps this onto
   *  movie_details.premiere_at_ms (K1) at whatever UTC-midnight convention
   *  it chooses to adopt — noted as a mapping decision for Lane B, not
   *  made here. */
  date: string | null;
  rating100: number | null;
  studioId: string | null;
  code: string | null;
  director: string | null;
  organized: boolean;
  coverBlobChecksum: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export function getScene(db: SqliteReadable, sceneId: string): StashScene | null {
  const row = db
    .prepare(
      'SELECT id, title, details, date, rating, studio_id, code, director, organized, cover_blob, created_at, updated_at FROM scenes WHERE id = ?'
    )
    .get(sceneId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: toStr(row.id),
    title: toNullableStr(row.title),
    details: toNullableStr(row.details),
    date: toNullableStr(row.date),
    rating100: toNullableNumber(row.rating),
    studioId: row.studio_id == null ? null : toStr(row.studio_id),
    code: toNullableStr(row.code),
    director: toNullableStr(row.director),
    organized: toBool(row.organized),
    coverBlobChecksum: toNullableStr(row.cover_blob),
    createdAtMs: toEpochMs(row.created_at),
    updatedAtMs: toEpochMs(row.updated_at),
  };
}

export function listSceneIds(db: SqliteReadable): string[] {
  const rows = db.prepare('SELECT id FROM scenes ORDER BY id ASC').all() as { id: unknown }[];
  return rows.map((r) => toStr(r.id));
}

// ============================================================================
// files (per scene)
// ============================================================================

export interface StashSceneFile {
  fileId: string;
  path: string;
  basename: string;
  sizeBytes: number;
  modTimeMs: number;
  isPrimary: boolean;
  oshash: string | null;
  md5: string | null;
}

function readFingerprints(db: SqliteReadable, fileId: string): { oshash: string | null; md5: string | null } {
  const rows = db.prepare('SELECT type, fingerprint FROM files_fingerprints WHERE file_id = ?').all(fileId) as {
    type: unknown;
    fingerprint: unknown;
  }[];
  const byType = new Map(rows.map((r) => [String(r.type), r.fingerprint]));
  return {
    oshash: byType.has('oshash') ? String(byType.get('oshash')) : null,
    md5: byType.has('md5') ? String(byType.get('md5')) : null,
  };
}

/** Every file linked to `sceneId` via scenes_files, primary-flagged file
 *  first (Stash allows >1 file per scene — dupes/merges — with at most
 *  one flagged `primary`). */
export function getSceneFiles(db: SqliteReadable, sceneId: string): StashSceneFile[] {
  const rows = db
    .prepare(
      `SELECT f.id AS file_id, f.basename, f.size, f.mod_time, sf."primary" AS is_primary, fo.path AS folder_path
       FROM scenes_files sf
       JOIN files f ON f.id = sf.file_id
       JOIN folders fo ON fo.id = f.parent_folder_id
       WHERE sf.scene_id = ?
       ORDER BY sf."primary" DESC, f.id ASC`
    )
    .all(sceneId) as { file_id: unknown; basename: unknown; size: unknown; mod_time: unknown; is_primary: unknown; folder_path: unknown }[];

  return rows.map((row) => {
    const fileId = toStr(row.file_id);
    const { oshash, md5 } = readFingerprints(db, fileId);
    return {
      fileId,
      path: joinFolderAndBasename(String(row.folder_path), String(row.basename)),
      basename: String(row.basename),
      sizeBytes: Number(row.size),
      modTimeMs: toEpochMs(row.mod_time),
      isPrimary: toBool(row.is_primary),
      oshash,
      md5,
    };
  });
}

// ============================================================================
// performers
// ============================================================================

export interface StashPerformer {
  id: string;
  name: string;
  disambiguation: string | null;
  aliases: string[];
  gender: string | null;
  birthdate: string | null;
  country: string | null;
  measurements: string | null;
  details: string | null;
  rating100: number | null;
  imageBlobChecksum: string | null;
}

function readPerformerAliases(db: SqliteReadable, performerId: string): string[] {
  const rows = db.prepare('SELECT alias FROM performer_aliases WHERE performer_id = ? ORDER BY alias ASC').all(performerId) as {
    alias: unknown;
  }[];
  return rows.map((r) => String(r.alias));
}

export function getScenePerformers(db: SqliteReadable, sceneId: string): StashPerformer[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.disambiguation, p.gender, p.birthdate, p.country, p.measurements, p.details, p.rating, p.image_blob
       FROM performers_scenes ps
       JOIN performers p ON p.id = ps.performer_id
       WHERE ps.scene_id = ?
       ORDER BY p.id ASC`
    )
    .all(sceneId) as Record<string, unknown>[];

  return rows.map((row) => {
    const id = toStr(row.id);
    return {
      id,
      name: toStr(row.name),
      disambiguation: toNullableStr(row.disambiguation),
      aliases: readPerformerAliases(db, id),
      gender: toNullableStr(row.gender),
      birthdate: toNullableStr(row.birthdate),
      country: toNullableStr(row.country),
      measurements: toNullableStr(row.measurements),
      details: toNullableStr(row.details),
      rating100: toNullableNumber(row.rating),
      imageBlobChecksum: toNullableStr(row.image_blob),
    };
  });
}

// ============================================================================
// studios
// ============================================================================

export interface StashStudio {
  id: string;
  name: string;
  parentId: string | null;
  details: string | null;
  rating100: number | null;
  imageBlobChecksum: string | null;
}

export function getStudio(db: SqliteReadable, studioId: string): StashStudio | null {
  const row = db.prepare('SELECT id, name, parent_id, details, rating, image_blob FROM studios WHERE id = ?').get(studioId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    parentId: row.parent_id == null ? null : toStr(row.parent_id),
    details: toNullableStr(row.details),
    rating100: toNullableNumber(row.rating),
    imageBlobChecksum: toNullableStr(row.image_blob),
  };
}

// ============================================================================
// tags (hierarchy via tags_relations)
// ============================================================================

export interface StashTag {
  id: string;
  name: string;
  description: string | null;
  imageBlobChecksum: string | null;
  parentIds: string[];
  childIds: string[];
}

function readTagRelations(db: SqliteReadable, tagId: string): { parentIds: string[]; childIds: string[] } {
  const parents = db.prepare('SELECT parent_id FROM tags_relations WHERE child_id = ? ORDER BY parent_id ASC').all(tagId) as {
    parent_id: unknown;
  }[];
  const children = db.prepare('SELECT child_id FROM tags_relations WHERE parent_id = ? ORDER BY child_id ASC').all(tagId) as {
    child_id: unknown;
  }[];
  return {
    parentIds: parents.map((r) => toStr(r.parent_id)),
    childIds: children.map((r) => toStr(r.child_id)),
  };
}

function rowToTag(db: SqliteReadable, row: Record<string, unknown>): StashTag {
  const id = toStr(row.id);
  const { parentIds, childIds } = readTagRelations(db, id);
  return {
    id,
    name: toStr(row.name),
    description: toNullableStr(row.description),
    imageBlobChecksum: toNullableStr(row.image_blob),
    parentIds,
    childIds,
  };
}

export function getTag(db: SqliteReadable, tagId: string): StashTag | null {
  const row = db.prepare('SELECT id, name, description, image_blob FROM tags WHERE id = ?').get(tagId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return rowToTag(db, row);
}

export function getSceneTags(db: SqliteReadable, sceneId: string): StashTag[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.description, t.image_blob
       FROM scenes_tags st
       JOIN tags t ON t.id = st.tag_id
       WHERE st.scene_id = ?
       ORDER BY t.id ASC`
    )
    .all(sceneId) as Record<string, unknown>[];
  return rows.map((row) => rowToTag(db, row));
}

// ============================================================================
// markers
// ============================================================================

export interface StashSceneMarker {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number | null;
  primaryTagId: string;
}

export function getSceneMarkers(db: SqliteReadable, sceneId: string): StashSceneMarker[] {
  const rows = db
    .prepare('SELECT id, title, seconds, end_seconds, primary_tag_id FROM scene_markers WHERE scene_id = ? ORDER BY seconds ASC')
    .all(sceneId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: toStr(row.id),
    title: toStr(row.title),
    startSeconds: Number(row.seconds),
    endSeconds: toNullableNumber(row.end_seconds),
    primaryTagId: toStr(row.primary_tag_id),
  }));
}

// ============================================================================
// blobs (cover / avatar / studio / tag images)
// ============================================================================

export interface StashBlob {
  checksum: string;
  /** null when Stash stores this blob's bytes on its OWN filesystem
   *  instead of in the database (see this file's header) — the SQLite
   *  side genuinely cannot produce the bytes in that configuration. */
  bytes: Buffer | null;
}

export function getBlob(db: SqliteReadable, checksum: string): StashBlob | null {
  const row = db.prepare('SELECT checksum, blob FROM blobs WHERE checksum = ?').get(checksum) as
    | { checksum: unknown; blob: unknown }
    | undefined;
  if (!row) return null;
  const blob = row.blob;
  const bytes = blob == null ? null : Buffer.isBuffer(blob) ? blob : Buffer.from(blob as ArrayBufferLike);
  return { checksum: toStr(row.checksum), bytes };
}

// ============================================================================
// inventory pass (K10)
// ============================================================================

export interface StashInventoryScene {
  stashSceneId: string;
  /** The scene's PRIMARY file's raw (unmapped) path, or null when the
   *  scene has no files linked at all (a real, if unusual, Stash state —
   *  the inventory pass still records the scene so it is visible, S4). */
  path: string | null;
  sizeBytes: number | null;
  oshash: string | null;
  updatedAtMs: number;
}

/** Every scene's primary-file identity facts, for the inventory pass that
 *  populates stash_scene_links (K10) — deliberately does NOT join
 *  performers/tags/markers (this is a cheap pass over scenes+files only,
 *  not a full metadata fetch). */
export function listScenesForInventory(db: SqliteReadable): StashInventoryScene[] {
  const rows = db
    .prepare(
      `SELECT
         s.id AS scene_id,
         s.updated_at AS scene_updated_at,
         f.size AS size,
         fo.path AS folder_path,
         f.basename AS basename,
         (SELECT ff.fingerprint FROM files_fingerprints ff WHERE ff.file_id = f.id AND ff.type = 'oshash') AS oshash
       FROM scenes s
       LEFT JOIN scenes_files sf ON sf.scene_id = s.id AND sf."primary" = 1
       LEFT JOIN files f ON f.id = sf.file_id
       LEFT JOIN folders fo ON fo.id = f.parent_folder_id
       ORDER BY s.id ASC`
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    stashSceneId: toStr(row.scene_id),
    path: row.folder_path == null || row.basename == null ? null : joinFolderAndBasename(String(row.folder_path), String(row.basename)),
    sizeBytes: toNullableNumber(row.size),
    oshash: toNullableStr(row.oshash),
    updatedAtMs: toEpochMs(row.scene_updated_at),
  }));
}
