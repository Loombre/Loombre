// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/admin.controller.ts
//
// GET /admin/jobs, GET /admin/jobs/{id} (job ledger — Job schema firmed up
// this wave, packages/contract/openapi.yaml), GET /system/info (admin).
//
// GET /admin/sessions (STATE.md P2.8/deliverable E, websocket-presence
// lane): admin-only session-list feed. Item display fields are resolved
// through THIS ADMIN'S OWN ViewerContext (resolveViewer) — never a
// synthetic "admin sees everything" context — because plan §6.4 gate 4/5
// default-denies even admins; see listActiveSessionsAdmin's doc comment
// (packages/db/src/query/admin.ts) for the exact redaction contract this
// mirrors verbatim into the wire response. `plan`/`engineVersion` on the
// mapped row are additive wire fields beyond the frozen (this wave)
// AdminSession contract schema — see listActiveSessionsAdmin's own doc
// comment on AdminSessionRow.plan for the full discovered-gap writeup;
// they follow the exact same redact-not-omit rule as itemTitle.
// d3-e3 additionally sends `suspendedByThrottle`/`heartbeatStale` (both now
// declared in the contract): `suspended` is one enum value with two opposite
// meanings, and an abandoned session stays listed here for ~13.5 minutes
// between the sweeper's 90s suspend and its 15-minute end. This controller
// supplies the staleness BOUNDARY (nowMs minus the live
// sessions.heartbeatSuspendCutoffMs setting) — the query layer has no clock
// and no settings access, and the client must not invent either.
//
// GET /system/update (STATE.md P4.3/P4.16, release lane): admin-only
// notify-only update check. Co-located with GET /system/info — both are
// the contract's only two admin-only /system/* endpoints (GET /system/
// capabilities is public and lives in session/system.controller.ts
// instead). Never triggers a download, never auto-applies anything — see
// apps/server/src/common/update-check/perform-check.ts's header.
//
// GET /admin/capabilities, GET /admin/crash-files(+/{name}), GET
// /admin/logs/tail (Phase 4 deliverable D, this wave): see
// admin-crash-files.ts and admin-logs-tail.ts for the filesystem-facing
// implementations this controller is a thin, admin-gated HTTP wrapper
// around.

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  getCurrentHwCapabilitySnapshot,
  getEnrichableCatalogItemForAdmin,
  getJobAdmin,
  getLatestJobOfTypeAdmin,
  getLibraryByIdAdmin,
  listActiveSessionsAdmin,
  listJobsAdmin,
  listLibraryPathsAdmin,
  listUnmatchedLibraryItemsForViewer,
  type AdminSessionRow,
  type HwPlatform,
  type JobRow,
} from "@loombre/db";
import { getSettingsRegistryEntry, LOOMBRE_VERSION_FULL, nowMs as clockNowMs } from "@loombre/shared";
import os from "node:os";
import { conflict, forbidden, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import { sanitizeInstancePath } from "../gateway/sanitize-instance.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { ServerPowerService, type PowerAction } from "../common/server-power.service.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { JobQueueProvider } from "../common/job-queue.provider.js";
import { UpdateCheckService } from "../common/update-check/update-check.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { resolveAppPaths } from "../cli/app-paths.js";
import { isValidCrashFileName, listCrashFileMetas, readCrashFileContent } from "./admin-crash-files.js";
import {
  DirectoryBrowseError,
  listDirectories,
  listRoots,
  permissionDeniedDetail,
  permissionRemediation,
} from "./admin-directories.js";
import { tailLogFile } from "./admin-logs-tail.js";
import { requireResolvableApplyMatchProvider } from "./apply-match-provider.js";
import { computeStoragePool } from "./admin-storage-pool.js";
import { parseListQuery, resolveViewerRestrictedSurface } from "./viewer.js";

function mapJob(row: JobRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    lastError: row.last_error,
    subjectItemId: row.subject_item_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
  };
}

// L2 (pre-public hardening): claim fast-fail, then a FRESH DB re-read via
// requireLiveAdmin — the JWT isAdmin claim alone can be stale for up to the
// access token's 15-minute lifetime after a demotion.
async function requireAdmin(db: LoombreDb, req: AuthenticatedRequest): Promise<void> {
  if (!req.user?.isAdmin) {
    throw forbidden("Admin privileges are required for this operation.", req.originalUrl);
  }
  await requireLiveAdmin(db, req.user.userId, req.originalUrl);
}

function mapOs(platform: NodeJS.Platform): "linux" | "macos" | "windows" {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

function mapAdminSession(row: AdminSessionRow) {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    itemId: row.itemId,
    itemTitle: row.itemTitle,
    contentHidden: row.contentHidden,
    status: row.status,
    startedAtMs: row.startedAtMs,
    updatedAtMs: row.updatedAtMs,
    lastHeartbeatMs: row.lastHeartbeatMs,
    // Additive wire fields beyond the frozen AdminSession contract schema
    // — see this file's header and AdminSessionRow.plan's doc comment
    // (packages/db/src/query/admin.ts).
    plan: row.plan,
    engineVersion: row.engineVersion,
    // d3-e3: the two fields that separate a stream someone is WATCHING
    // from one they walked away from — both are transport facts, so
    // neither is redacted with the item (see AdminSessionRow's own doc
    // comments). Declared in the contract's AdminSession schema.
    suspendedByThrottle: row.suspendedByThrottle,
    heartbeatStale: row.heartbeatStale,
  };
}

/** Node's os.platform() values the hardware-capability probe supports
 *  (mirrors apps/server/src/playback/resolve-caps.ts's identical, smaller-
 *  scoped SUPPORTED_HW_PLATFORMS constant — kept as a separate literal
 *  here rather than importing that module's private array, since exporting
 *  it there for exactly one other caller would widen that file's surface
 *  for no benefit). */
function isHwPlatform(platform: NodeJS.Platform): platform is HwPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

/** The settings key whose window decides whether an admin-listed session
 *  still has anyone on the other end (d3-e3) — the same one the playback
 *  session sweeper suspends on. */
const HEARTBEAT_SUSPEND_CUTOFF_KEY = "sessions.heartbeatSuspendCutoffMs";

@Controller()
export class AdminController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
    private readonly updateCheckService: UpdateCheckService,
    private readonly jobQueueProvider: JobQueueProvider,
    private readonly serverPowerService: ServerPowerService,
    private readonly settingsService: SettingsService,
  ) {}

  @Get("admin/jobs")
  async listJobs(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await listJobsAdmin(this.dbProvider.db, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { items: page.rows.map(mapJob), nextCursor: page.nextCursor };
  }

  @Get("admin/jobs/:id")
  async getJob(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Job not found.", req.originalUrl);
    const job = await getJobAdmin(this.dbProvider.db, id);
    if (!job) {
      throw notFound("Job not found.", req.originalUrl);
    }
    return mapJob(job);
  }

  /** sessions.heartbeatSuspendCutoffMs, resolved exactly as
   *  playback/session-sweeper.service.ts resolves the same key: the live
   *  effective value, falling back to the REGISTRY's own default. The
   *  registry is read rather than importing the sweeper's exported
   *  constant because catalog/ may not import playback/ (D2, enforced by
   *  dependency-cruiser) — and the registry is that constant's source
   *  anyway. */
  private heartbeatSuspendCutoffMs(): number {
    const configured = this.settingsService.getEffective(HEARTBEAT_SUSPEND_CUTOFF_KEY)?.value;
    if (typeof configured === "number") return configured;
    const registryDefault = getSettingsRegistryEntry(HEARTBEAT_SUSPEND_CUTOFF_KEY)?.default;
    return typeof registryDefault === "number" ? registryDefault : 90_000;
  }

  @Get("admin/sessions")
  async listSessions(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const ctx = await resolveViewerRestrictedSurface(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await listActiveSessionsAdmin(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      // d3-e3: the SAME cutoff the sweeper suspends on, read live (it is a
      // requiresRestart:false setting), so "is anyone still on the other
      // end of this session" is answered here with the deployment's own
      // policy rather than a number invented by the client.
      heartbeatStaleBeforeMs: clockNowMs() - this.heartbeatSuspendCutoffMs(),
    });
    return { items: page.rows.map(mapAdminSession), nextCursor: page.nextCursor };
  }

  @Get("system/info")
  async getSystemInfo(@Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    // Wave 1c (Phosphor retheme, "contract enablers" lane): storagePool —
    // every library's root paths (admin-only, unfiltered by
    // ViewerContext — see listLibraryPathsAdmin's own doc comment for why
    // disk capacity isn't a restricted-content leak class), reduced to
    // deduped total/used bytes by computeStoragePool's two cheap syscalls
    // per distinct filesystem (Tier-0 rule). Null when there are no
    // libraries yet or every probe failed — rendered honestly, never
    // fabricated.
    const libraries = await listLibraryPathsAdmin(this.dbProvider.db);
    const allLibraryPaths = libraries.flatMap((library) => library.paths);
    const storagePool = await computeStoragePool(allLibraryPaths);

    return {
      // STATE.md P4.11: single-source version stamping. LOOMBRE_VERSION_FULL
      // is generated by scripts/release/stamp-version.mjs from root
      // package.json's `version` field — "<version>-dev+<shorthash>" for a
      // dev build, exactly "<version>" for a `--release` build. Same
      // constant `loombre --version` and the release manifest builder read.
      version: LOOMBRE_VERSION_FULL,
      os: mapOs(os.platform()),
      // Tier detection (docs/PLAN.md §9, Tier-0/1/2 hardware classes) is a
      // future wave; Tier-0 is the safe floor default until it lands.
      tier: 0,
      nodeVersion: process.version,
      uptimeMs: Math.round(process.uptime() * 1000),
      storagePool,
    };
  }

  @Get("system/update")
  async getSystemUpdate(@Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    return this.updateCheckService.getUpdateInfo();
  }

  // POST /system/restart + /system/shutdown (contract: restartServer /
  // shutdownServer). The 202 is flushed BEFORE any teardown begins
  // (ServerPowerService hooks res "finish" — the ipc/listener.ts
  // handleServerStop ordering contract), and the triggers themselves are
  // armed only by main.ts's direct-entrypoint bootstrap, so embedded/test
  // contexts walking these endpoints get a logged no-op, never a dead
  // test runner. @Res passthrough keeps Nest serializing the return value
  // while still exposing the raw response for the finish hook.

  @Post("system/restart")
  @HttpCode(HttpStatus.ACCEPTED)
  async restartServer(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    return this.handlePowerAction("restart", req, res);
  }

  @Post("system/shutdown")
  @HttpCode(HttpStatus.ACCEPTED)
  async shutdownServer(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    // W3-R (opus review): guard FIRST — the container-supervision branch
    // used to run before requireAdmin, so on the shipped Docker image a
    // non-admin got a 409 carrying deployment details ("runs under a
    // container supervisor… docker compose stop") instead of a 403.
    // handlePowerAction re-runs the same guard; requireAdmin is a cheap
    // idempotent read and correctness-order beats one saved query.
    await requireAdmin(this.dbProvider.db, req);
    // Under a restart-policy supervisor that ignores exit codes (the
    // shipped Docker compose's `unless-stopped`), an in-process exit
    // CANNOT keep the container down — refuse honestly instead of
    // exiting into an immediate supervisor restart (contract 409).
    if (this.serverPowerService.isContainerSupervised()) {
      throw conflict(
        "This deployment runs under a container supervisor that restarts the server on any exit. " +
          "Stop the container from outside instead (docker compose stop).",
        req.originalUrl,
        "shutdown-unsupported-under-container-supervision",
      );
    }
    return this.handlePowerAction("shutdown", req, res);
  }

  private async handlePowerAction(action: PowerAction, req: AuthenticatedRequest, res: Response) {
    await requireAdmin(this.dbProvider.db, req);
    // userId, not username — RequestUser carries only the JWT claims, and
    // resolving a display name would add a DB read to a teardown path.
    this.serverPowerService.scheduleAfterResponse(res, action, `admin user ${req.user?.userId ?? "unknown"}`);
    return { accepted: true, action };
  }

  @Get("admin/capabilities")
  async getAdminCapabilities(@Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const currentPlatform = os.platform();
    if (!isHwPlatform(currentPlatform)) {
      // Unsupported platform for hw-capability probing at all (matches
      // resolve-caps.ts's own fallback posture) — same envelope shape as
      // "never probed yet": there is no report to show and no self-test
      // will ever be enqueued for this platform.
      return { report: null, probe: { status: "never-ran", lastError: null, updatedAtMs: null } };
    }

    // W1/D-1 three-state derivation: the latest 'hwprobe' ledger row
    // distinguishes failed / pending from never-ran (the hwprobe consumer
    // persists only on success, so a failed self-test leaves the report
    // null forever — the ledger row is the only durable failure signal).
    // Consulted on BOTH branches: with a snapshot present, a NEWER
    // queued/active/failed row means a re-probe (ffmpeg/GPU fingerprint
    // change) is in flight or just failed — reporting bare 'completed'
    // there would hide exactly the state D-1 wants visible (opus review
    // W1-R8). Indexed lookup (migrations/0037) — the setup wizard polls
    // this endpoint every 4s.
    const latestProbeJob = await getLatestJobOfTypeAdmin(this.dbProvider.db, "hwprobe");
    const snapshot = await getCurrentHwCapabilitySnapshot(this.dbProvider.db, currentPlatform);
    if (!snapshot) {
      // A 'completed' ledger row with no snapshot shouldn't happen
      // (persist runs in the same handler); if it does, "never-ran" is
      // the honest fallback — no usable result and nothing in flight.
      if (latestProbeJob?.status === "failed") {
        return {
          report: null,
          probe: { status: "failed", lastError: latestProbeJob.last_error, updatedAtMs: latestProbeJob.updated_at_ms },
        };
      }
      if (latestProbeJob?.status === "queued" || latestProbeJob?.status === "active") {
        return {
          report: null,
          probe: { status: "pending", lastError: null, updatedAtMs: latestProbeJob.updated_at_ms },
        };
      }
      return { report: null, probe: { status: "never-ran", lastError: null, updatedAtMs: null } };
    }

    let probe: { status: string; lastError: string | null; updatedAtMs: number | null } = {
      status: "completed",
      lastError: null,
      updatedAtMs: snapshot.verifiedAtMs,
    };
    if (latestProbeJob && latestProbeJob.updated_at_ms > snapshot.verifiedAtMs) {
      if (latestProbeJob.status === "queued" || latestProbeJob.status === "active") {
        probe = { status: "pending", lastError: null, updatedAtMs: latestProbeJob.updated_at_ms };
      } else if (latestProbeJob.status === "failed") {
        probe = { status: "failed", lastError: latestProbeJob.last_error, updatedAtMs: latestProbeJob.updated_at_ms };
      }
    }

    return {
      probe,
      report: {
        platform: mapOs(currentPlatform),
        ffmpegBuildHash: snapshot.ffmpegBuildHash,
        // DB default is '' (best-effort probe command failure, migrations/
        // 0011's own column comment) — the contract's gpuFingerprint is
        // documented null for exactly that case.
        gpuFingerprint: snapshot.gpuFingerprint.length > 0 ? snapshot.gpuFingerprint : null,
        verifiedAtMs: snapshot.verifiedAtMs,
        backends: snapshot.backends.map((b) => ({
          name: b.backend,
          position: b.position,
          decode: b.decode,
          encode: b.encode,
          toneMap: b.toneMap,
        })),
      },
    };
  }

  @Get("admin/filesystem/directories")
  async browseDirectories(@Query("path") pathParam: string | undefined, @Req() req: AuthenticatedRequest) {
    // requireAdmin (the module's requireLiveAdmin wrapper), not a bare
    // token claim: enumerating a server's directory tree is reconnaissance,
    // so a demoted admin's still-valid access token must not keep working
    // here. Same guard every other admin route on this controller uses.
    await requireAdmin(this.dbProvider.db, req);

    const requested = pathParam?.trim();
    if (requested === undefined || requested === "") {
      return listRoots();
    }

    try {
      return listDirectories(requested);
    } catch (err) {
      if (!(err instanceof DirectoryBrowseError)) throw err;
      const instance = sanitizeInstancePath(req);
      switch (err.failure.kind) {
        case "not-absolute":
          throw unprocessableEntity("A library path must be absolute.", instance);
        case "not-a-directory":
          throw unprocessableEntity("That path is a file, not a directory.", instance);
        case "permission-denied": {
          // The server genuinely cannot read it, and saying so is useful:
          // the fix is an OS permission change (or, on the installers, the
          // service account's access), not a different path. The detail is
          // tailored to the account the server actually runs as (the macOS
          // field report: a bare "Forbidden" while the real story — the
          // _loombre daemon cannot read a home folder — was known here),
          // and the code lets clients pattern-match without string-parsing.
          //
          // On the one installer with a scripted grant recipe (macOS +
          // _loombre today), a `remediation` extension member rides along
          // so the client can render an actionable grant flow instead of
          // the bare detail paragraph — a second rc.6 field report: the
          // detail sentence was correct but still just a wall of text with
          // nothing to click. `requested` (not `instance`, which is this
          // REQUEST's own URL) is the real path templated into the
          // commands, matching what listDirectories() was actually asked
          // to browse.
          const remediation = permissionRemediation(requested);
          throw forbidden(
            permissionDeniedDetail(),
            instance,
            "filesystem-permission-denied",
            remediation !== null ? { remediation } : undefined,
          );
        }
        case "not-found":
          throw notFound("No such directory on the server.", instance);
      }
    }
  }

  @Get("admin/crash-files")
  async listCrashFiles(@Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const { dataDir } = resolveAppPaths(process.platform, process.env);
    return { items: listCrashFileMetas(dataDir) };
  }

  @Get("admin/crash-files/:name")
  async getCrashFile(@Param("name") name: string, @Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    await requireAdmin(this.dbProvider.db, req);
    // Reject BEFORE ever touching the filesystem with a caller-supplied
    // name — readCrashFileContent re-checks this same pattern internally
    // (defense in depth, admin-crash-files.ts's header), but the 404 here
    // is what makes a hostile name indistinguishable from "no such file"
    // at the HTTP layer, never a 400/500 that would hint at the rejection
    // reason.
    if (!isValidCrashFileName(name)) {
      throw notFound("Crash file not found.", sanitizeInstancePath(req));
    }
    const { dataDir } = resolveAppPaths(process.platform, process.env);
    const content = readCrashFileContent(dataDir, name);
    if (content === null) {
      throw notFound("Crash file not found.", sanitizeInstancePath(req));
    }
    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content);
  }

  @Get("admin/logs/tail")
  async getAdminLogsTail(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const lines = parseLinesQuery(query["lines"]);
    return tailLogFile(process.env["LOOMBRE_LOG_FILE"], lines);
  }

  // ────────── Fix Match (Phosphor retheme Wave 2, Lane L2) ──────────

  @Get("admin/libraries/:id/unmatched")
  async listUnmatchedLibraryItems(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    // Admin-bypass existence check (matches scanLibrary/putLibraryPermissions
    // precedent, libraries.controller.ts) — the LIST itself is still
    // ViewerContext-guarded below (listUnmatchedLibraryItemsForViewer), so
    // an admin without a library_permissions grant for this exact library
    // gets a 404-free empty page, not a leak.
    const library = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!library) {
      throw notFound("Library not found.", req.originalUrl);
    }
    const ctx = await resolveViewerRestrictedSurface(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await listUnmatchedLibraryItemsForViewer(this.dbProvider.db, ctx, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return {
      items: page.rows.map((row) => ({
        itemId: row.itemId,
        itemType: row.itemType,
        title: row.title,
        year: row.year,
        filePath: row.filePath,
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post("admin/items/:id/match-search")
  @HttpCode(HttpStatus.ACCEPTED)
  async searchItemMatchCandidates(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Item not found.", req.originalUrl);
    // THIS ADMIN'S OWN ViewerContext — plan §6.4 default-denies uncleared
    // admins too, so an unclearable item 404s byte-identically to a
    // nonexistent one (getEnrichableCatalogItemForAdmin's doc comment).
    const ctx = await resolveViewerRestrictedSurface(this.viewerContextProvider, req);
    const item = await getEnrichableCatalogItemForAdmin(this.dbProvider.db, ctx, id);
    if (!item) {
      throw notFound("Item not found (or not an enrichable type — movie/series/artist/album only).", req.originalUrl);
    }
    const jobId = await this.jobQueueProvider.queue.enqueue("metadata-search", { itemId: id }, { subjectItemId: id });
    return { jobId };
  }

  @Post("admin/items/:id/apply-match")
  @HttpCode(HttpStatus.ACCEPTED)
  async applyItemMatch(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Item not found.", req.originalUrl);
    const instance = req.originalUrl;
    // Same guarded lookup / same 404 posture as searchItemMatchCandidates
    // above — the admin's own ViewerContext, never a synthetic one.
    const ctx = await resolveViewerRestrictedSurface(this.viewerContextProvider, req);
    const item = await getEnrichableCatalogItemForAdmin(this.dbProvider.db, ctx, id);
    if (!item) {
      throw notFound("Item not found (or not an enrichable type — movie/series/artist/album only).", instance);
    }

    const body = rawBody ?? {};
    if (typeof body["provider"] !== "string" || body["provider"].length === 0) {
      throw unprocessableEntity("provider is required.", instance);
    }
    if (typeof body["externalId"] !== "string" || body["externalId"].length === 0) {
      throw unprocessableEntity("externalId is required.", instance);
    }
    // api-validation-F11: the name must be one the worker's
    // ProviderRegistry can actually resolve — a built-in, or `lpp:<pluginId>`
    // for a registered+enabled plugin. Without this an unknown provider
    // enqueued a 'metadata' job that the consumer's forced-match branch
    // logged-and-skipped, completing green having changed nothing (see
    // apply-match-provider.ts's header). Runs AFTER the item lookup (404
    // still wins over 422) and BEFORE the enqueue (a rejected request
    // leaves no jobs row).
    await requireResolvableApplyMatchProvider(this.dbProvider.db, body["provider"], instance);

    // Rides the EXISTING 'metadata' job/consumer (forceRef, additive) —
    // never a bespoke apply-match pipeline; re-fetches provider details +
    // artwork for EXACTLY this ref through the same precedence engine
    // every scan-triggered metadata job already uses. Never touches the
    // original media file.
    const jobId = await this.jobQueueProvider.queue.enqueue(
      "metadata",
      {
        itemId: id,
        mediaKind: item.mediaKind,
        contentClass: item.contentClass,
        forceRef: { provider: body["provider"], externalId: body["externalId"] },
      },
      { subjectItemId: id },
    );
    return { jobId };
  }
}

const DEFAULT_LOG_TAIL_LINES = 200;
const MIN_LOG_TAIL_LINES = 1;
const MAX_LOG_TAIL_LINES = 500;

/** Same lenient posture as viewer.ts's parseListQuery: a malformed/out-of-
 *  range `lines` falls back to the documented default rather than 422ing —
 *  this is a display-tuning query param, not a validated write. */
function parseLinesQuery(raw: unknown): number {
  if (typeof raw !== "string") return DEFAULT_LOG_TAIL_LINES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_LOG_TAIL_LINES;
  return Math.min(MAX_LOG_TAIL_LINES, Math.max(MIN_LOG_TAIL_LINES, n));
}
