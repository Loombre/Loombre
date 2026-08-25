// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/libraries.controller.ts
//
// GET/POST /libraries, GET/PATCH/DELETE /libraries/{id},
// POST /libraries/{id}/scan, GET/PUT /libraries/{id}/permissions.
//
// GET /libraries has TWO scopes (browser-admin-F7 follow-up, d3-d5). The
// default is viewer-scoped, and before this it was the only one — which
// meant a restricted library nobody held a grant on was absent from the
// one listing the product had, the permissions editor is fed by that same
// listing, and so no grant could ever be issued to it from the UI.
// `?scope=admin` is the administration-scoped listing (admin-gated below;
// packages/db's listLibrariesForScope + administrationScope()).
//
// Admin gate: every write here (POST/PATCH/DELETE/scan/permissions) checks
// `req.user.isAdmin` (attached by AuthGuard from the access-token claim,
// see gateway/auth.guard.ts) and throws 403 Forbidden otherwise — matches
// the contract's documented security description for these operations.
//
// Restricted-library-creation refusal (P1.19, mission spec): when the
// restricted.enabled setting (Addendum A registry; env-pinnable via
// LOOMBRE_RESTRICTED_ENABLED) resolves off, `contentClass: 'restricted'` on
// POST /libraries is refused. The mission text says "409/403 per contract"
// but POST /libraries only documents 401/403/422/default (no 409) — 403 is
// used, matching what's actually in packages/contract/openapi.yaml.
//
// api-validation-F5 (QA 2026-08-21 remediation, P1): this file used to run
// ZERO unknown-key checks, while CreateLibraryRequest, UpdateLibraryRequest
// and ScanLibraryRequest all declare `additionalProperties: false`. Three
// consequences, all silent: POST /libraries with a stray key answered 201
// and created the library; PATCH /libraries/{id} with one answered 200,
// wrote nothing, and still bumped updated_at; and scanLibrary read only
// `(rawBody ?? {})["full"] === true`, so `{"full":"yes"}` enqueued a real
// INCREMENTAL scan — a caller who asked for a full rescan silently got the
// other kind. All three run the *_BODY_KEYS allowlist loop this house
// already uses everywhere else now (users.controller.ts's
// UPDATE_ME_BODY_KEYS is the reference), and `full` must be an actual
// boolean. Nothing is enqueued or written on a rejected request.
// Regression net: apps/server/test/api-body-validation.e2e.spec.ts.
//
// d3-b5 (QA 2026-08-21 follow-up backlog, P3): F5's five endpoints all had
// FLAT bodies, so its allowlist loop had only ever been written one level
// deep. PUT /libraries/{id}/permissions is the one body in this controller
// with a NESTED shape — LibraryPermissionSet {libraryId, permissions[]},
// each entry a LibraryPermission {userId, granted}, both
// `additionalProperties: false` — and NEITHER level was enforced. An
// unknown key at the top or inside any entry answered 200 and performed the
// grant/revoke, so a client typo looked like it worked. Both levels run the
// allowlist now; entries are fully validated before any write, so a bad
// entry rejects the whole request. `libraryId` stays accepted-and-ignored
// (see PUT_PERMISSIONS_BODY_KEYS).
//
// d4-b1 (QA 2026-08-24 backlog #092, P2): d3-b5 taught this handler about
// unknown KEYS; the VALUE of a known key was still only `typeof === "string"`
// checked, so every `entry.userId` reached Postgres verbatim and produced two
// 500s — a non-UUID string blew up the implicit `uuid` cast (22P02) on BOTH
// the grant (INSERT) and revoke (DELETE … WHERE user_id IN) arms, and a
// well-formed uuid naming no user violated library_permissions' FK to users
// (23503). Same defect class as api-validation-F1, one level deeper: an ARRAY
// MEMBER, which requireUuidParam (a path-param helper) never reaches. Now
// 422 on shape and 404 on an unknown user, matching remote-wireguard.
// controller.ts + remote-wireguard.service.ts's enrollDevice, this server's
// existing precedent for a body-carried userId ("unknown keys -> field
// validation -> 404 unknown user"). See putLibraryPermissions' inline notes
// for the ordering and for why BOTH arms are validated identically.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import {
  administrationScope,
  createLibrary,
  deleteLibraryAdmin,
  getLibraryByIdAdmin,
  getLibraryForViewer,
  getLibraryItemCountsForViewer,
  getLibraryPermissionsAdmin,
  getUserById,
  listLibrariesForScope,
  putLibraryPermissionsAdmin,
  updateLibraryAdmin,
  type ItemType,
  type LibraryPermissionEntry,
  type LibraryRow,
  type ViewerContext,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { forbidden, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { isValidUuid, requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { JobQueueProvider } from "../common/job-queue.provider.js";
import { isRestrictedContentEnabled } from "../common/capabilities.js";
import { SettingsService } from "../settings/settings.service.js";
import { resolveViewer, parseListQuery } from "./viewer.js";

/**
 * Wave 1c (Phosphor retheme, "contract enablers" lane): the ONE item_type
 * a library's headline `itemCount` reads off of — "which row shape is
 * this library's own count" is a display decision made here, not guessed
 * by the data layer (see getLibraryItemCountsForViewer's own doc comment,
 * packages/db/src/query/libraries.ts). A "tv" library's catalog_items span
 * series + season + episode rows; the sidebar wants the SHOW count, not
 * every episode.
 */
function headlineItemTypeForMediaKind(mediaKind: string): ItemType {
  if (mediaKind === "tv") return "series";
  if (mediaKind === "music") return "album";
  return "movie";
}

function mapLibrary(
  row: {
    id: string;
    name: string;
    media_kind: string;
    paths: string[];
    content_class: string;
    created_at_ms: number;
    updated_at_ms: number;
  },
  itemCount: number,
) {
  return {
    id: row.id,
    name: row.name,
    mediaKind: row.media_kind,
    paths: row.paths,
    contentClass: row.content_class,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    itemCount,
  };
}

/** Merges getLibraryItemCountsForViewer's per-(library, item_type) rows
 *  down to one headline count per library row, defaulting to 0 for a
 *  library with no matching rows yet (freshly created, or genuinely
 *  empty) rather than omitting the field. */
async function mapLibrariesWithCounts(
  db: Parameters<typeof getLibraryItemCountsForViewer>[0],
  ctx: ViewerContext,
  rows: LibraryRow[],
) {
  const counts = await getLibraryItemCountsForViewer(
    db,
    ctx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const headline = headlineItemTypeForMediaKind(row.media_kind);
    const count = counts.find((c) => c.libraryId === row.id && c.itemType === headline)?.count ?? 0;
    return mapLibrary(row, count);
  });
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

const VALID_MEDIA_KINDS = new Set(["movie", "tv", "music"]);
const VALID_CONTENT_CLASSES = new Set(["general", "restricted"]);

/** CreateLibraryRequest's full property set (additionalProperties:false,
 *  api-validation-F5) — same allowlist pattern users.controller.ts's
 *  UPDATE_ME_BODY_KEYS established. */
const CREATE_LIBRARY_BODY_KEYS = new Set(["name", "mediaKind", "paths", "contentClass"]);

/** UpdateLibraryRequest's full property set (additionalProperties:false,
 *  api-validation-F5). Deliberately narrower than CREATE_LIBRARY_BODY_KEYS:
 *  `mediaKind` and `contentClass` are create-only in the contract, so an
 *  attempt to PATCH either is an unknown property here, not a silent no-op. */
const UPDATE_LIBRARY_BODY_KEYS = new Set(["name", "paths"]);

/** ScanLibraryRequest's full property set (additionalProperties:false,
 *  api-validation-F5). */
const SCAN_LIBRARY_BODY_KEYS = new Set(["full"]);

/** LibraryPermissionSet's full property set (additionalProperties:false,
 *  d3-b5). `libraryId` is ACCEPTED and then IGNORED: the contract lists it
 *  as required, every web caller sends it (LibrariesSection.tsx,
 *  AddLibrarySheet.tsx, UsersSection.tsx) — and the path parameter is what
 *  this handler actually acts on, as it always has. Rejecting a body that
 *  omits it, or 422ing on a body/path mismatch, would each be a NEW
 *  narrowing this finding does not ask for; both are logged as separate
 *  findings instead. */
const PUT_PERMISSIONS_BODY_KEYS = new Set(["libraryId", "permissions"]);

/** LibraryPermission's full property set (additionalProperties:false,
 *  d3-b5) — the NESTED half, which is the part api-validation-F5 never
 *  reached: its five endpoints all had flat bodies, so "reject unknown
 *  keys" had only ever been implemented one level deep. */
const LIBRARY_PERMISSION_ENTRY_KEYS = new Set(["userId", "granted"]);

@Controller()
export class LibrariesController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
    private readonly jobQueueProvider: JobQueueProvider,
    private readonly settingsService: SettingsService,
  ) {}

  @Get("libraries")
  async listLibraries(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    // browser-admin-F7 follow-up (d3-d5): `?scope=admin` answers the
    // administration-scoped listing. STRICT equality on purpose — the
    // contract documents an unrecognized value as `viewer` (the same
    // lenient posture `limit`/`sort`/`order` have), and here that leniency
    // fails CLOSED: no typo can ever widen the scope.
    const wantsAdminScope = query["scope"] === "admin";
    if (wantsAdminScope) {
      // The SAME gate every other admin operation on this controller uses:
      // the JWT claim, then a FRESH requireLiveAdmin DB re-read (L2). Runs
      // before any library is read, so a refusal is never an oracle.
      await requireAdmin(this.dbProvider.db, req);
    }
    // Counts always come from the CALLER'S OWN ViewerContext, in both
    // scopes — never a synthetic "admin sees everything" context (same
    // posture as updateLibrary below). A library the admin holds no grant
    // on therefore reports 0 items, not a leaked total.
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await listLibrariesForScope(
      this.dbProvider.db,
      wantsAdminScope ? administrationScope(req.user!.userId) : ctx,
      {
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    );
    const items = await mapLibrariesWithCounts(this.dbProvider.db, ctx, page.rows);
    return { items, nextCursor: page.nextCursor };
  }

  @Post("libraries")
  async createLibrary(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const body = rawBody ?? {};
    const instance = req.originalUrl;

    for (const key of Object.keys(body)) {
      if (!CREATE_LIBRARY_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    if (typeof body["name"] !== "string" || body["name"].length === 0) {
      throw unprocessableEntity("name is required.", instance);
    }
    if (typeof body["mediaKind"] !== "string" || !VALID_MEDIA_KINDS.has(body["mediaKind"])) {
      throw unprocessableEntity("mediaKind must be one of movie|tv|music.", instance);
    }
    if (!Array.isArray(body["paths"]) || body["paths"].length === 0 || !body["paths"].every((p) => typeof p === "string")) {
      throw unprocessableEntity("paths must be a non-empty array of strings.", instance);
    }
    let contentClass: "general" | "restricted" | undefined;
    if (body["contentClass"] !== undefined) {
      if (typeof body["contentClass"] !== "string" || !VALID_CONTENT_CLASSES.has(body["contentClass"])) {
        throw unprocessableEntity("contentClass must be general or restricted.", instance);
      }
      contentClass = body["contentClass"] as "general" | "restricted";
    }

    if (contentClass === "restricted" && !isRestrictedContentEnabled(this.settingsService)) {
      throw forbidden(
        "Restricted-content libraries cannot be created: restricted.enabled is off on this instance (docs/PLAN.md §6.4 gate 1).",
        instance,
      );
    }

    const lib = await createLibrary(this.dbProvider.db, {
      name: body["name"],
      mediaKind: body["mediaKind"] as "movie" | "tv" | "music",
      paths: body["paths"] as string[],
      ...(contentClass !== undefined ? { contentClass } : {}),
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
    });
    // A freshly created library has no items yet — 0 without a query.
    return mapLibrary(lib, 0);
  }

  @Get("libraries/:id")
  async getLibrary(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const lib = await getLibraryForViewer(this.dbProvider.db, ctx, id);
    if (!lib) {
      throw notFound("Library not found.", req.originalUrl);
    }
    const [mapped] = await mapLibrariesWithCounts(this.dbProvider.db, ctx, [lib]);
    return mapped;
  }

  @Patch("libraries/:id")
  async updateLibrary(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const body = rawBody ?? {};
    const instance = req.originalUrl;

    for (const key of Object.keys(body)) {
      if (!UPDATE_LIBRARY_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    if (body["name"] !== undefined && (typeof body["name"] !== "string" || body["name"].length === 0)) {
      throw unprocessableEntity("name must be a non-empty string.", instance);
    }
    if (
      body["paths"] !== undefined &&
      (!Array.isArray(body["paths"]) || body["paths"].length === 0 || !body["paths"].every((p) => typeof p === "string"))
    ) {
      throw unprocessableEntity("paths must be a non-empty array of strings.", instance);
    }

    const updated = await updateLibraryAdmin(this.dbProvider.db, id, {
      ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
      ...(Array.isArray(body["paths"]) ? { paths: body["paths"] as string[] } : {}),
      nowMs: clockNowMs(),
    });
    if (!updated) {
      throw notFound("Library not found.", instance);
    }
    // itemCount through THIS ADMIN'S OWN ViewerContext — same posture as
    // admin.controller.ts's listActiveSessionsAdmin (never a synthetic
    // "admin sees everything" context; an admin without this library's own
    // gate-5 unlock sees the same guarded count any other viewer would).
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const [mapped] = await mapLibrariesWithCounts(this.dbProvider.db, ctx, [updated]);
    return mapped;
  }

  @Delete("libraries/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLibrary(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const existing = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("Library not found.", req.originalUrl);
    }
    await deleteLibraryAdmin(this.dbProvider.db, id);
  }

  @Post("libraries/:id/scan")
  @HttpCode(HttpStatus.ACCEPTED)
  async scanLibrary(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);

    // api-validation-F5: body shape is checked BEFORE the existence lookup
    // — same ordering users.controller.ts's resetUserPassword uses (its
    // RESET_PASSWORD_BODY_KEYS loop runs ahead of getUserById), and it
    // leaks nothing about the id: a 422 here is a statement about the
    // caller's own body, not about the library.
    const body = rawBody ?? {};
    const instance = req.originalUrl;
    for (const key of Object.keys(body)) {
      if (!SCAN_LIBRARY_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    // `=== true` used to be the whole check, so every non-boolean — the
    // string "yes" included — quietly meant `full: false` and the caller
    // got an incremental scan they never asked for. ScanLibraryRequest
    // types `full` as a non-nullable boolean defaulting to false, so
    // absent means false and anything that is not a boolean is a 422.
    if (body["full"] !== undefined && typeof body["full"] !== "boolean") {
      throw unprocessableEntity("full must be a boolean.", instance);
    }
    const full = body["full"] === true;

    const existing = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("Library not found.", req.originalUrl);
    }
    const jobId = await this.jobQueueProvider.queue.enqueue("scan", { libraryId: id, full }, { subjectItemId: null });
    return { jobId };
  }

  @Get("libraries/:id/permissions")
  async getLibraryPermissions(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const existing = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("Library not found.", req.originalUrl);
    }
    const permissions = await getLibraryPermissionsAdmin(this.dbProvider.db, id);
    return { libraryId: id, permissions };
  }

  @Put("libraries/:id/permissions")
  async putLibraryPermissions(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const instance = req.originalUrl;
    const existing = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("Library not found.", instance);
    }

    const body = rawBody ?? {};
    // d3-b5: the same allowlist loop the three handlers above run, applied
    // at BOTH levels of this body. LibraryPermissionSet and
    // LibraryPermission are each `additionalProperties: false`, and neither
    // was enforced — an unknown key at the top, or inside any array entry,
    // answered 200 and performed the grant/revoke anyway. That made a client
    // typo indistinguishable from success at exactly the place it matters
    // most: `{"userId": "…", "allowed": true}` used to reach the entry check
    // and 422 with "requires userId and granted", never naming the key the
    // caller actually got wrong, while `{"userId": "…", "granted": true,
    // "bogus": 1}` was applied silently.
    for (const key of Object.keys(body)) {
      if (!PUT_PERMISSIONS_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    if (!Array.isArray(body["permissions"])) {
      throw unprocessableEntity("permissions must be an array.", instance);
    }
    const entries: LibraryPermissionEntry[] = [];
    // Every entry is validated BEFORE putLibraryPermissionsAdmin runs, so a
    // bad entry anywhere in the array writes none of the good ones — the
    // same all-or-nothing posture the flat bodies get for free.
    for (const [index, raw] of (body["permissions"] as unknown[]).entries()) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw unprocessableEntity("Each permission entry requires userId (string) and granted (boolean).", instance);
      }
      const entry = raw as Record<string, unknown>;
      // The unknown-key check runs BEFORE the required-member check on
      // purpose: a misspelled member is BOTH an unknown key and a missing
      // one, and "Unknown property "permissions[0].allowed"." tells the
      // caller what to fix while the generic message does not. The
      // `permissions[i].key` form is this file's only nested detail string;
      // the flat `Unknown property "<key>".` wording is unchanged elsewhere
      // (reauth-review-findings.e2e.spec.ts asserts it verbatim).
      for (const key of Object.keys(entry)) {
        if (!LIBRARY_PERMISSION_ENTRY_KEYS.has(key)) {
          throw unprocessableEntity(`Unknown property "permissions[${index}].${key}".`, instance);
        }
      }
      if (typeof entry["userId"] !== "string" || typeof entry["granted"] !== "boolean") {
        throw unprocessableEntity("Each permission entry requires userId (string) and granted (boolean).", instance);
      }
      // d4-b1: LibraryPermission.userId is `{type: string, format: uuid}`, and
      // "is a string" was the whole check — so a non-UUID reached Postgres's
      // implicit `uuid` cast and 500'd (22P02) on BOTH arms of the delta
      // below, the DELETE's `user_id IN (…)` as surely as the INSERT. Shape
      // is checked for the WHOLE array before any existence probe runs, so a
      // malformed body costs zero DB round-trips and a 422 always wins over
      // the 404 a later entry might have earned.
      if (!isValidUuid(entry["userId"])) {
        throw unprocessableEntity(`permissions[${index}].userId must be a valid UUID.`, instance);
      }
      entries.push({ userId: entry["userId"], granted: entry["granted"] });
    }

    // d4-b1: the other half of the same finding — a syntactically valid uuid
    // naming no user violated library_permissions' FK to users (23503, a 500)
    // on the grant arm and silently no-op'd on the revoke arm, so the same
    // typo'd id meant two different things depending on `granted`. One rule
    // for the member: every referenced user must exist, whichever arm it is
    // headed for. 404 (not 422) with detail "Unknown userId …" is this
    // server's existing answer for a body-carried userId that resolves to no
    // row — remote-wireguard.service.ts's enrollDevice; the `permissions[i]`
    // locator is d3-b5's nested-detail convention from this same handler, and
    // the fixed "Library not found." detail keeps this distinguishable from
    // the route's OWN 404 above. Deduplicated so a long list costs one lookup
    // per DISTINCT user, and run before putLibraryPermissionsAdmin so an
    // unknown id anywhere in the array writes none of the good entries — the
    // same all-or-nothing posture the unknown-key loops above give.
    const checkedUserIds = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (checkedUserIds.has(entry.userId)) continue;
      checkedUserIds.add(entry.userId);
      const user = await getUserById(this.dbProvider.db, entry.userId);
      if (!user) {
        throw notFound(`Unknown userId in permissions[${index}].`, instance);
      }
    }

    const permissions = await putLibraryPermissionsAdmin(this.dbProvider.db, id, entries, clockNowMs());
    return { libraryId: id, permissions };
  }
}
