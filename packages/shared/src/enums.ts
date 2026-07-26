// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cross-cutting domain enums, shared by every package (docs/PLAN.md §5-6).
 * Modeled as string literal unions rather than TS `enum` — plain string
 * values serialize identically to the DB Postgres enums and the OpenAPI
 * contract, with no numeric/erasure surprises.
 */

export type ItemType =
  | "movie"
  | "series"
  | "season"
  | "episode"
  | "artist"
  | "album"
  | "track";

export const ITEM_TYPES: readonly ItemType[] = [
  "movie",
  "series",
  "season",
  "episode",
  "artist",
  "album",
  "track",
];

export type ContentClass = "general" | "restricted";

export const CONTENT_CLASSES: readonly ContentClass[] = ["general", "restricted"];

export type WatchState = "unplayed" | "in-progress" | "played";

export const WATCH_STATES: readonly WatchState[] = [
  "unplayed",
  "in-progress",
  "played",
];

/**
 * Library media kind. Singular, matching the contract's MediaKind and the PG
 * media_kind enum verbatim — the value crosses the API boundary unmapped.
 */
export type MediaKind = "movie" | "tv" | "music";

export const MEDIA_KINDS: readonly MediaKind[] = ["movie", "tv", "music"];

export type JobStatus = "queued" | "active" | "completed" | "failed" | "cancelled";

export const JOB_STATUSES: readonly JobStatus[] = [
  "queued",
  "active",
  "completed",
  "failed",
  "cancelled",
];
