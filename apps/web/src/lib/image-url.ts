// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/image-url.ts
//
// GET /images/{entityType}/{id}/{kind}?token=<accessJWT>&width=<n> (P2.18):
// <img> tags cannot send an Authorization header, so the access token
// travels as a query param on this — and only this — GET surface. The
// controller (apps/server/src/catalog/images.controller.ts) does
// nearest-width-<=-requested selection among whatever pre-scaled variants
// ingest actually wrote; it does not enumerate fixed "kinds" of sizes, so
// srcset just asks for a few representative widths and lets the server
// pick the closest match it has.

const SRCSET_WIDTHS = [320, 720, 1280] as const;

export interface ImageUrlOptions {
  serverUrl: string;
  entityType: string;
  entityId: string;
  kind: string;
  accessToken: string;
  width?: number;
}

export function buildImageUrl(options: ImageUrlOptions): string {
  const base = options.serverUrl.replace(/\/$/, "");
  // No /v1 segment: the real server mounts controllers at bare paths (see
  // api-client.ts's header for why — contract's `servers` entry vs. tested
  // reality).
  const url = new URL(`${base}/images/${options.entityType}/${options.entityId}/${options.kind}`);
  url.searchParams.set("token", options.accessToken);
  if (options.width !== undefined) url.searchParams.set("width", String(options.width));
  return url.toString();
}

export function buildImageSrcSet(options: Omit<ImageUrlOptions, "width">): string {
  return SRCSET_WIDTHS.map((width) => `${buildImageUrl({ ...options, width })} ${width}w`).join(", ");
}

export function defaultImageSizes(): string {
  return "(max-width: 600px) 45vw, (max-width: 1200px) 220px, 280px";
}
