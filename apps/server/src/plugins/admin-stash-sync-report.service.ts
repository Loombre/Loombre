// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-stash-sync-report.service.ts
//
// GET /admin/libraries/{id}/stash-sync-report's logic (STATE.md S8/K14,
// Stash SQLite metadata sync, Lane C sync engine). Imitates
// admin-library-provider-chain.service.ts's shape exactly: requireLiveAdmin
// re-verifies isAdmin fresh (never trusts the JWT claim), library
// existence is checked before anything else (404 wins), and every read
// goes through @loombre/db's PUBLIC barrel (packages/db/src/query/
// stash-sync-reports.ts — no ViewerContext, same admin-only-instance-
// bookkeeping posture that module's own header documents). Lives under
// apps/server/src/plugins/ (not apps/server/src/catalog/, where
// LibrariesController's other /libraries/{id}/* routes live) for the SAME
// reason admin-library-provider-chain.service.ts gives for itself: this
// surface needs requireLiveAdmin (Lane W5's hardening), not
// LibrariesController's own still-JWT-claim requireAdmin(), and is mounted
// in admin-plugins.module.ts alongside every other admin-plugins-area
// controller.
//
// Honest-empty-shape (K14): `report: null` when no stash-sync job has ever
// run for this library — mirrors GET /admin/capabilities's own `{report:
// null}` precedent (apps/server/src/catalog/admin.controller.ts) rather
// than fabricating a placeholder report. unmatchedScenes/staleScenes are
// ALWAYS live queries (never null, never gated on whether a report
// exists) — a library can have unmatched/stale scenes recorded by an
// inventory pass even before its first full sync completes (K10: the
// inventory pass runs independently of a sync).

import { Injectable } from "@nestjs/common";
import {
  getLibraryByIdAdmin,
  getLatestStashSyncReport,
  listStaleStashScenes,
  listUnmatchedStashScenes,
  type LibraryRow,
  type StashSyncReportRow,
  type StashSyncSceneListResult,
} from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { notFound } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";

export interface GetAdminStashSyncReportParams {
  unmatchedCursor?: string;
  staleCursor?: string;
  limit?: number;
}

interface StashSyncSceneRefDto {
  stashSceneId: string;
  stashPath: string;
  stashUpdatedAtMs: number | null;
}

interface StashSyncSceneRefPageDto {
  items: StashSyncSceneRefDto[];
  nextCursor: string | null;
}

interface StashSyncReportDto {
  jobId: string;
  mode: string;
  status: string;
  matchedCount: number;
  updatedCount: number;
  unmatchedCount: number;
  staleCount: number;
  skippedCount: number;
  startedAtMs: number;
  finishedAtMs: number | null;
}

export interface AdminStashSyncReportDto {
  report: StashSyncReportDto | null;
  unmatchedScenes: StashSyncSceneRefPageDto;
  staleScenes: StashSyncSceneRefPageDto;
}

function toReportDto(row: StashSyncReportRow): StashSyncReportDto {
  return {
    jobId: row.job_id,
    mode: row.mode,
    status: row.status,
    matchedCount: row.matched_count,
    updatedCount: row.updated_count,
    unmatchedCount: row.unmatched_count,
    staleCount: row.stale_count,
    skippedCount: row.skipped_count,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
  };
}

function toScenePageDto(result: StashSyncSceneListResult): StashSyncSceneRefPageDto {
  return { items: result.rows, nextCursor: result.nextCursor };
}

@Injectable()
export class AdminStashSyncReportService {
  constructor(private readonly dbProvider: DbProvider) {}

  private instancePath(libraryId: string): string {
    return `/admin/libraries/${libraryId}/stash-sync-report`;
  }

  async getReport(libraryId: string, actorUserId: string, params: GetAdminStashSyncReportParams): Promise<AdminStashSyncReportDto> {
    const instancePath = this.instancePath(libraryId);
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const library: LibraryRow | undefined = await getLibraryByIdAdmin(this.dbProvider.db, libraryId);
    if (!library) throw notFound("Library not found.", instancePath);

    const [report, unmatchedScenes, staleScenes] = await Promise.all([
      getLatestStashSyncReport(this.dbProvider.db, libraryId),
      listUnmatchedStashScenes(this.dbProvider.db, libraryId, {
        ...(params.unmatchedCursor !== undefined ? { cursor: params.unmatchedCursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      }),
      listStaleStashScenes(this.dbProvider.db, libraryId, {
        ...(params.staleCursor !== undefined ? { cursor: params.staleCursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      }),
    ]);

    return {
      report: report ? toReportDto(report) : null,
      unmatchedScenes: toScenePageDto(unmatchedScenes),
      staleScenes: toScenePageDto(staleScenes),
    };
  }
}
