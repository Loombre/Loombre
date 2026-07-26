// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/people-tags.controller.ts
//
// GET /people, /people/{id}, /tags (P1.17 — first-class leak surfaces per
// docs/PLAN.md §6.4; guard semantics live entirely in
// packages/db/src/query/{people,tags}.ts, this controller only maps rows
// 1:1 to the Person/Tag contract schemas — see openapi.yaml's comment on
// why those schemas mirror the DB row shape exactly rather than the
// mission text's literal "kind" field, which the underlying TagRow does
// not carry).

import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import {
  getCatalogDetail,
  getPersonById,
  listItemsForPerson,
  listPeople,
  listTags,
  type CatalogDetail,
  type ItemTagKind,
  type ItemType,
} from "@loombre/db";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { resolveViewer, parseListQuery } from "./viewer.js";
import { mapByType } from "./mappers.js";

function mapPerson(row: { id: string; name: string; contentClass: string; creditCount: number }) {
  return { id: row.id, name: row.name, contentClass: row.contentClass, creditCount: row.creditCount };
}

// Phosphor Wave 2 lane L3 (/people/[id] route filmography) — the only
// itemTypes PersonCredit is ever attached to (Movie/Series/Episode/Artist's
// `people` fields in openapi.yaml); Season/Album/Track never carry one.
const PERSON_ITEM_ELIGIBLE_TYPES: readonly ItemType[] = ["movie", "series", "episode", "artist"];

function mapTag(row: { id: string; name: string; contentClass: string; itemCount: number }) {
  return { id: row.id, name: row.name, contentClass: row.contentClass, itemCount: row.itemCount };
}

@Controller()
export class PeopleTagsController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  @Get("people")
  async listPeople(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const q = typeof query["q"] === "string" ? query["q"] : undefined;
    const page = await listPeople(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(q !== undefined ? { q } : {}),
    });
    return { items: page.rows.map(mapPerson), nextCursor: page.nextCursor };
  }

  @Get("people/:id")
  async getPerson(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Person not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const person = await getPersonById(this.dbProvider.db, ctx, id);
    if (!person) {
      throw notFound("Person not found.", req.originalUrl);
    }
    return mapPerson(person);
  }

  @Get("people/:id/items")
  async listPersonItems(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Person not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);

    // getPersonById first, same as getPerson above: a person that does not
    // exist or is not itself visible to ctx (restricted-class, uncleared
    // viewer) 404s — indistinguishable from "person visible, zero visible
    // credits" is NOT what we want to conflate here, so this existence
    // check is separate from (and precedes) the filmography query itself.
    const person = await getPersonById(this.dbProvider.db, ctx, id);
    if (!person) {
      throw notFound("Person not found.", req.originalUrl);
    }

    const { cursor, limit } = parseListQuery(query);
    const page = await listItemsForPerson(this.dbProvider.db, ctx, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    const eligible = page.rows.filter((r) => PERSON_ITEM_ELIGIBLE_TYPES.includes(r.itemType));
    const details = await Promise.all(eligible.map((r) => getCatalogDetail(this.dbProvider.db, ctx, r.itemId)));

    const items = eligible
      .map((r, i) => ({ row: r, detail: details[i] }))
      .filter((x): x is { row: (typeof eligible)[number]; detail: CatalogDetail } => x.detail !== undefined)
      .map(({ row, detail }) => ({ itemType: row.itemType, item: mapByType(row.itemType, detail) }));

    return { items, nextCursor: page.nextCursor };
  }

  @Get("tags")
  async listTags(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const kindRaw = query["kind"];
    const kind: ItemTagKind | undefined =
      kindRaw === "genre" || kindRaw === "tag" ? kindRaw : undefined;
    const page = await listTags(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(kind !== undefined ? { kind } : {}),
    });
    return { items: page.rows.map(mapTag), nextCursor: page.nextCursor };
  }
}
