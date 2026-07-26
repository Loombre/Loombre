// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/variant-job.ts
//
// The actual CPU-heavy work (P1.8, CLAUDE.md invariant 9 / docs/PLAN.md
// §9.2): given a local source image file, produce an unmodified original
// copy + N resized WebP (always) / AVIF (when libvips reports encoder
// support) variants + a blurhash — nothing here does network I/O. This
// module's `runVariantJob` is the function worker-runner.ts's worker
// thread calls; it is also exported directly for tests, which may call it
// in-process for speed while worker-runner.ts is what production code
// actually calls (through a real worker_thread, per the T0 mandate).
//
// Schema-driven design decision: the `images` table's unique key is
// (entity_type, entity_id, kind, width) — ONE row per width, with no
// format/mime column, so it cannot record a WebP row and an AVIF row at
// the same width as two rows. Both files ARE written to disk at each
// width; the DB row (written by consumer.ts) points at the .webp path,
// and an AVIF sibling — same path with .avif instead of .webp — sits
// alongside it whenever encoded, discoverable by a future serving
// endpoint via a deterministic extension swap + existsSync, without a
// schema change. Documented here since this file is where both are
// produced.

import { createHash } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { encode as encodeBlurhash } from 'blurhash';

/** The three standard variant widths (P1.8), fixed and not caller-configurable
 *  — a closed, documented contract the (future) serving endpoint can rely on. */
export const VARIANT_WIDTHS: readonly number[] = [320, 720, 1280];

const BLURHASH_RASTER_SIZE = 32;
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;
/** Registry defaults for images.webpQuality/images.avifQuality/
 *  images.avifEnabled (packages/shared/src/settings-registry.ts) — used
 *  when a caller (image/consumer.ts, resolving these fresh per job from
 *  SettingsService's worker-side equivalent, apps/worker/src/settings/
 *  effective-settings.ts) omits the corresponding VariantJobInput field,
 *  e.g. a direct test call to runVariantJob. Kept under their historical
 *  names for exactly that. */
const WEBP_QUALITY = 80;
const AVIF_QUALITY = 50;
const AVIF_ENABLED = true;

/** Small enough to be cheap, large enough that the histogram sharp's
 *  stats() builds isn't dominated by a handful of edge/border pixels. */
const DOMINANT_COLOR_RASTER_SIZE = 64;

export interface VariantJobInput {
  /** Local filesystem path to the already-downloaded/local source image. */
  sourcePath: string;
  /** Directory variant + original files are written into (created if absent). */
  outputDir: string;
  /** Filename stem — files become `${baseName}-original.<ext>`,
   *  `${baseName}-320.webp`, `${baseName}-320.avif`, etc. */
  baseName: string;
  /** images.avifEnabled (Addendum A registry) — ANDed with the runtime
   *  libvips AVIF-encode support check (avifSupported() below); disabling
   *  only stops NEW AVIF encodes (registry description). Defaults to the
   *  registry default (true) when omitted. */
  avifEnabled?: boolean;
  /** images.webpQuality (1-100). Defaults to the registry default (80). */
  webpQuality?: number;
  /** images.avifQuality (1-100). Defaults to the registry default (50). */
  avifQuality?: number;
}

export interface VariantFile {
  width: number | null;
  height: number | null;
  filePath: string;
}

export interface VariantJobResult {
  /** The images-table row for `original` is written with width=null
   *  (that is the convention consumer.ts/upsertImage use to distinguish
   *  the original from a resized variant, matching the unique key
   *  (entity_type, entity_id, kind, width) treating width=NULL as its own
   *  distinct value) even though this VariantFile carries the source's
   *  real natural dimensions for informational purposes. */
  original: VariantFile;
  /** One entry per VARIANT_WIDTHS entry — filePath always points at the
   *  .webp file (see header comment re: the AVIF sibling). */
  variants: VariantFile[];
  /** True if an AVIF sibling was written next to every variant's .webp file. */
  avifWritten: boolean;
  blurhash: string;
  /** '#rrggbb' — see computeDominantColor below (P2.11/CLAUDE.md invariant
   *  9: computed here, worker-thread side, never on a request path). */
  dominantColor: string;
}

function avifSupported(): boolean {
  // sharp exposes AVIF encode support under the 'heif' format entry (AVIF
  // is a HEIF-family container) — see this file's PR notes for the sharp
  // API shape this reads (`sharp.format.heif.output.buffer`).
  const heif = sharp.format.heif as { output?: { buffer?: boolean } } | undefined;
  return heif?.output?.buffer === true;
}

async function computeBlurhash(sourcePath: string): Promise<string> {
  const { data, info } = await sharp(sourcePath)
    .resize(BLURHASH_RASTER_SIZE, BLURHASH_RASTER_SIZE, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return encodeBlurhash(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, BLURHASH_COMPONENTS_X, BLURHASH_COMPONENTS_Y);
}

function componentToHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

/**
 * Dominant colour extraction (P2.11): sharp's `.stats()` derives a
 * histogram-based dominant RGB triple directly — no manual pixel-averaging
 * needed. Resizing down first (same rationale as computeBlurhash) keeps
 * this cheap regardless of the source's native resolution. Used both by
 * the new-image ingest path (runVariantJob below) and, standalone, by the
 * one-time backfill job (apps/worker/src/image/dominant-color-worker-entry.ts)
 * for pre-existing rows that already have variants/blurhash but predate
 * this column.
 */
export async function computeDominantColor(sourcePath: string): Promise<string> {
  const { dominant } = await sharp(sourcePath)
    .resize(DOMINANT_COLOR_RASTER_SIZE, DOMINANT_COLOR_RASTER_SIZE, { fit: 'inside' })
    .stats();

  return `#${componentToHex(dominant.r)}${componentToHex(dominant.g)}${componentToHex(dominant.b)}`;
}

export async function runVariantJob(input: VariantJobInput): Promise<VariantJobResult> {
  await mkdir(input.outputDir, { recursive: true });

  const metadata = await sharp(input.sourcePath).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new Error(`variant-job: could not read image metadata for ${input.sourcePath}`);
  }

  const originalExt = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
  const originalPath = join(input.outputDir, `${input.baseName}-original.${originalExt}`);
  await copyFile(input.sourcePath, originalPath);

  const avifEnabled = input.avifEnabled ?? AVIF_ENABLED;
  const webpQuality = input.webpQuality ?? WEBP_QUALITY;
  const avifQuality = input.avifQuality ?? AVIF_QUALITY;
  const avif = avifEnabled && avifSupported();

  const variants: VariantFile[] = [];
  for (const width of VARIANT_WIDTHS) {
    const webpPath = join(input.outputDir, `${input.baseName}-${width}.webp`);
    const webpResult = await sharp(input.sourcePath).resize({ width }).webp({ quality: webpQuality }).toFile(webpPath);

    if (avif) {
      const avifPath = join(input.outputDir, `${input.baseName}-${width}.avif`);
      await sharp(input.sourcePath).resize({ width }).avif({ quality: avifQuality }).toFile(avifPath);
    }

    variants.push({ width, height: webpResult.height, filePath: webpPath });
  }

  const [blurhash, dominantColor] = await Promise.all([computeBlurhash(input.sourcePath), computeDominantColor(input.sourcePath)]);

  return {
    // Original keeps the source's natural dimensions (no resize applied).
    original: { width: metadata.width, height: metadata.height, filePath: originalPath },
    variants,
    avifWritten: avif,
    blurhash,
    dominantColor,
  };
}

/** Exposed for tests/diagnostics — pipeline.ts and the admin surface (a
 *  future wave) both want to know this without re-deriving the sharp API
 *  shape check. */
export { avifSupported };

/** Small helper used by download.ts to name temp files deterministically
 *  per source URL, avoiding collisions across concurrent jobs. */
export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
