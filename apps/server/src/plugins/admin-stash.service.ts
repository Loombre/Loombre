// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-stash.service.ts
//
// STATE.md Stash run (S1-S4/K10): GET/PUT /admin/libraries/{id}/
// stash-connection, GET/PUT .../stash-path-mappings, POST .../stash-
// path-mappings/preview, POST .../stash-sync — around Lane A's
// packages/db/src/query/stash-connections.ts (config read/write) and
// stash-inventory.ts (computePathMappingMatchPreview, K10). Mirrors
// admin-library-provider-chain.service.ts's shape exactly: requireLiveAdmin
// as the first step of every method, library existence checked before body
// validation (404 wins), package errors passed straight through as 422
// where they already carry a clear message.
//
// Enqueue precedent: JobQueueProvider.queue.enqueue(type, payload,
// {subjectItemId}) — the SAME call libraries.controller.ts's scanLibrary
// uses. `stash-inventory`/`stash-sync` are pre-registered job types (K13
// seam, packages/jobs/src/types.ts) this lane only ENQUEUES, never
// implements a consumer for (apps/worker stays out of this lane's scope).

import { Injectable } from "@nestjs/common";
import {
  computePathMappingMatchPreview,
  deleteLibraryStashConnectionAndEmit,
  getLibraryByIdAdmin,
  getLibraryPathMappings,
  getLibraryStashConnection,
  replaceLibraryPathMappings,
  upsertLibraryStashConnectionConfig,
  LibraryNotFoundForStashError,
  StashConnectionNotConfiguredError,
  type LibraryPathMappingRow,
  type LibraryStashConnectionRow,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { DbProvider } from "../common/db.provider.js";
import { JobQueueProvider } from "../common/job-queue.provider.js";

export interface AdminStashConnectionDto {
  libraryId: string;
  configured: boolean;
  sqlitePath: string | null;
  enabled: boolean;
  genreTagNames: string[] | null;
  blobsPath: string | null;
  status: string;
  statusDetail: string | null;
  lastSeenSchemaVersion: number | null;
  lastConnectedAtMs: number | null;
  lastCheckedAtMs: number | null;
}

function toConnectionDto(libraryId: string, row: LibraryStashConnectionRow | undefined): AdminStashConnectionDto {
  if (!row) {
    return {
      libraryId,
      configured: false,
      sqlitePath: null,
      enabled: false,
      genreTagNames: null,
      blobsPath: null,
      status: "never_connected",
      statusDetail: null,
      lastSeenSchemaVersion: null,
      lastConnectedAtMs: null,
      lastCheckedAtMs: null,
    };
  }
  return {
    libraryId,
    configured: true,
    sqlitePath: row.sqlite_path,
    enabled: row.enabled,
    genreTagNames: row.genre_tag_names,
    blobsPath: row.stash_blobs_path,
    status: row.status,
    statusDetail: row.status_detail,
    lastSeenSchemaVersion: row.last_seen_schema_version,
    lastConnectedAtMs: row.last_connected_at_ms,
    lastCheckedAtMs: row.last_checked_at_ms,
  };
}

export interface AdminStashPathMappingDto {
  stashPrefix: string;
  loombrePrefix: string;
}

function toMappingDto(row: LibraryPathMappingRow): AdminStashPathMappingDto {
  return { stashPrefix: row.stash_prefix, loombrePrefix: row.loombre_prefix };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

@Injectable()
export class AdminStashService {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly jobQueueProvider: JobQueueProvider,
  ) {}

  private instancePath(libraryId: string, suffix: string): string {
    return `/admin/libraries/${libraryId}/${suffix}`;
  }

  // ==========================================================================
  // stash-connection
  // ==========================================================================

  async getConnection(libraryId: string, actorUserId: string): Promise<AdminStashConnectionDto> {
    const instancePath = this.instancePath(libraryId, "stash-connection");
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const row = await getLibraryStashConnection(this.dbProvider.db, libraryId);
    return toConnectionDto(libraryId, row);
  }

  /** Writes sqlitePath/enabled, plus genreTagNames (K15) with a tri-state
   *  contract: the key ABSENT from the body leaves the saved value
   *  untouched, `null` explicitly resets it to the default heuristic, and
   *  a (possibly empty) array of strings replaces it wholesale. Enqueues a
   *  `stash-inventory` job on every successful save so the path-mapping
   *  preview has fresh data without a separate admin button. */
  async putConnection(libraryId: string, rawBody: unknown, actorUserId: string): Promise<AdminStashConnectionDto> {
    const instancePath = this.instancePath(libraryId, "stash-connection");
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const body = isPlainObject(rawBody) ? rawBody : {};
    const sqlitePath = body["sqlitePath"];
    if (typeof sqlitePath !== "string" || sqlitePath.length === 0) {
      throw unprocessableEntity("sqlitePath is required.", instancePath);
    }
    const enabledRaw = body["enabled"];
    const enabled = typeof enabledRaw === "boolean" ? enabledRaw : undefined;

    // Tri-state: only include the key in the writer's input at all when
    // the admin's body actually carried it — "in" distinguishes an absent
    // key (leave untouched) from a key present with value `null` (reset to
    // the heuristic), which `body["genreTagNames"] !== undefined` alone
    // cannot (both read as `undefined` off a plain object).
    let genreTagNames: string[] | null | undefined;
    if ("genreTagNames" in body) {
      const raw = body["genreTagNames"];
      if (raw === null) {
        genreTagNames = null;
      } else if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) {
        genreTagNames = raw;
      } else {
        throw unprocessableEntity("genreTagNames must be an array of strings or null.", instancePath);
      }
    }

    // Same tri-state as genreTagNames: absent = leave untouched, null =
    // clear (DB-only art), string = the filesystem blob-store path.
    let blobsPath: string | null | undefined;
    if ("blobsPath" in body) {
      const raw = body["blobsPath"];
      if (raw === null || typeof raw === "string") {
        blobsPath = raw;
      } else {
        throw unprocessableEntity("blobsPath must be a string or null.", instancePath);
      }
    }

    let row: LibraryStashConnectionRow;
    try {
      row = await upsertLibraryStashConnectionConfig(this.dbProvider.db, {
        libraryId,
        sqlitePath,
        ...(enabled !== undefined ? { enabled } : {}),
        ...(genreTagNames !== undefined ? { genreTagNames } : {}),
        ...(blobsPath !== undefined ? { blobsPath } : {}),
        nowMs: clockNowMs(),
      });
    } catch (err) {
      if (err instanceof LibraryNotFoundForStashError) {
        // Unreachable given the pre-check above — defense in depth, same
        // posture admin-library-provider-chain.service.ts's putChain takes.
        throw notFound("Library not found.", instancePath);
      }
      throw err;
    }

    await this.jobQueueProvider.queue.enqueue("stash-inventory", { libraryId }, { subjectItemId: null });

    return toConnectionDto(libraryId, row);
  }

  /** Stash OPEN ledger item 6: "forget this connection entirely" — DELETE,
   *  distinct from PUT enabled:false's mere pause. 404s both when the
   *  library itself does not exist (checked first, same ordering as
   *  every other method here) and when the library exists but has no
   *  Stash connection configured (StashConnectionNotConfiguredError —
   *  "nothing to forget" is a real not-found, not a silent no-op).
   *  deleteLibraryStashConnectionAndEmit does the actual work: deletes
   *  ONLY the library_stash_connections row and emits
   *  `stash.provider.disconnected` in the same transaction — path
   *  mappings, any already-synced catalog metadata, and sync-report
   *  history are all untouched by construction (see that function's own
   *  header for the full data-retention rationale, S8). No keyring
   *  secret to clear (S1: Stash has none). No zombie schedule/job to
   *  reach into either — apps/worker/src/stash/schedule-loop.ts and
   *  connectToStashLibrary both re-resolve the connection row fresh and
   *  treat its absence as an ordinary miss/failure, not a crash. */
  async deleteConnection(libraryId: string, actorUserId: string): Promise<void> {
    const instancePath = this.instancePath(libraryId, "stash-connection");
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    try {
      await deleteLibraryStashConnectionAndEmit(this.dbProvider.db, {
        libraryId,
        actorUserId,
        nowMs: clockNowMs(),
      });
    } catch (err) {
      if (err instanceof StashConnectionNotConfiguredError) {
        throw notFound("No Stash connection is configured for this library.", instancePath);
      }
      throw err;
    }
  }

  // ==========================================================================
  // stash-path-mappings
  // ==========================================================================

  async getPathMappings(libraryId: string, actorUserId: string): Promise<{ mappings: AdminStashPathMappingDto[] }> {
    const instancePath = this.instancePath(libraryId, "stash-path-mappings");
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const rows = await getLibraryPathMappings(this.dbProvider.db, libraryId);
    return { mappings: rows.map(toMappingDto) };
  }

  private parseMappings(rawBody: unknown, instancePath: string): AdminStashPathMappingDto[] {
    const body = isPlainObject(rawBody) ? rawBody : {};
    const rawMappings = body["mappings"];
    if (!Array.isArray(rawMappings)) {
      throw unprocessableEntity("mappings must be an array.", instancePath);
    }
    return rawMappings.map((entry, index) => {
      if (!isPlainObject(entry)) {
        throw unprocessableEntity(`mappings[${index}] must be an object.`, instancePath);
      }
      const stashPrefix = entry["stashPrefix"];
      const loombrePrefix = entry["loombrePrefix"];
      if (typeof stashPrefix !== "string" || stashPrefix.length === 0) {
        throw unprocessableEntity(`mappings[${index}].stashPrefix is required.`, instancePath);
      }
      if (typeof loombrePrefix !== "string" || loombrePrefix.length === 0) {
        throw unprocessableEntity(`mappings[${index}].loombrePrefix is required.`, instancePath);
      }
      return { stashPrefix, loombrePrefix };
    });
  }

  async putPathMappings(
    libraryId: string,
    rawBody: unknown,
    actorUserId: string,
  ): Promise<{ mappings: AdminStashPathMappingDto[] }> {
    const instancePath = this.instancePath(libraryId, "stash-path-mappings");
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    // Library existence wins over body validation (matches
    // admin-library-provider-chain.service.ts's putChain/LibrariesController's
    // putLibraryPermissions precedent).
    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const mappings = this.parseMappings(rawBody, instancePath);

    const rows = await replaceLibraryPathMappings(
      this.dbProvider.db,
      libraryId,
      mappings.map((m) => ({ stashPrefix: m.stashPrefix, loombrePrefix: m.loombrePrefix })),
    );
    return { mappings: rows.map(toMappingDto) };
  }

  async previewPathMappings(
    libraryId: string,
    rawBody: unknown,
    actorUserId: string,
  ): Promise<{
    totalStashScenes: number;
    candidateMatchCount: number;
    unmatchedCount: number;
    unmatchedScenes: { stashSceneId: string; stashPath: string; rewrittenPath: string | null }[];
  }> {
    const instancePath = this.instancePath(libraryId, "stash-path-mappings/preview");
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const mappings = this.parseMappings(rawBody, instancePath);

    return computePathMappingMatchPreview(
      this.dbProvider.db,
      libraryId,
      mappings.map((m) => ({ stashPrefix: m.stashPrefix, loombrePrefix: m.loombrePrefix })),
    );
  }

  // ==========================================================================
  // stash-sync
  // ==========================================================================

  async postSync(libraryId: string, rawBody: unknown, actorUserId: string): Promise<{ jobId: string }> {
    const instancePath = this.instancePath(libraryId, "stash-sync");
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const library = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const body = isPlainObject(rawBody) ? rawBody : {};
    const mode = body["mode"];
    if (mode !== "full" && mode !== "incremental") {
      throw unprocessableEntity('mode must be "full" or "incremental".', instancePath);
    }

    const jobId = await this.jobQueueProvider.queue.enqueue("stash-sync", { libraryId, mode }, { subjectItemId: null });
    return { jobId };
  }
}
