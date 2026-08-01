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
  getLibraryByIdAdmin,
  getLibraryPathMappings,
  getLibraryStashConnection,
  replaceLibraryPathMappings,
  upsertLibraryStashConnectionConfig,
  LibraryNotFoundForStashError,
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

  /** Writes sqlitePath/enabled ONLY (never genreTagNames — Lane E's own
   *  field on this resource, K15) and enqueues a `stash-inventory` job on
   *  every successful save so the path-mapping preview has fresh data
   *  without a separate admin button. */
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

    let row: LibraryStashConnectionRow;
    try {
      row = await upsertLibraryStashConnectionConfig(this.dbProvider.db, {
        libraryId,
        sqlitePath,
        ...(enabled !== undefined ? { enabled } : {}),
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
