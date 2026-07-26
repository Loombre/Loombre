// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/variant-job.spec.ts
//
// Generates tiny PNG/JPEG sources WITH sharp at test time (no committed
// binaries — P1.8's explicit instruction) and runs runVariantJob directly
// (in-process; worker-runner.spec.ts separately proves the same function
// works correctly when actually run inside a worker_thread).

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { avifSupported, computeDominantColor, runVariantJob, VARIANT_WIDTHS } from '../../src/image/variant-job.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'loombre-variant-job-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makePng(width: number, height: number): Promise<string> {
  const path = join(workDir, 'source.png');
  await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 60 } } })
    .png()
    .toFile(path);
  return path;
}

async function makeJpeg(width: number, height: number): Promise<string> {
  const path = join(workDir, 'source.jpg');
  await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg()
    .toFile(path);
  return path;
}

/** '#rrggbb' -> [r, g, b], for asserting extracted colour is close to a
 *  known solid background (allowing a small tolerance for resize/encode
 *  rounding, per-channel). */
function hexToRgb(hex: string): [number, number, number] {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function expectCloseColor(actualHex: string, expected: { r: number; g: number; b: number }, tolerance = 8): void {
  const [r, g, b] = hexToRgb(actualHex);
  expect(Math.abs(r - expected.r)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(g - expected.g)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(b - expected.b)).toBeLessThanOrEqual(tolerance);
}

describe('runVariantJob', () => {
  it('produces an original + 3 width variants (webp) + a blurhash from a PNG source', async () => {
    const sourcePath = await makePng(200, 300);
    const outputDir = join(workDir, 'out');

    const result = await runVariantJob({ sourcePath, outputDir, baseName: 'poster' });

    expect(result.original.width).toBe(200);
    expect(result.original.height).toBe(300);
    expect(result.original.filePath).toBe(join(outputDir, 'poster-original.png'));

    expect(result.variants).toHaveLength(VARIANT_WIDTHS.length);
    for (const [i, width] of VARIANT_WIDTHS.entries()) {
      expect(result.variants[i]?.width).toBe(width);
      expect(result.variants[i]?.height).toBeGreaterThan(0);
      expect(result.variants[i]?.filePath).toBe(join(outputDir, `poster-${width}.webp`));
    }

    expect(typeof result.blurhash).toBe('string');
    expect(result.blurhash.length).toBeGreaterThan(0);

    expectCloseColor(result.dominantColor, { r: 200, g: 60, b: 60 });

    const files = await readdir(outputDir);
    for (const width of VARIANT_WIDTHS) {
      expect(files).toContain(`poster-${width}.webp`);
    }
    expect(files).toContain('poster-original.png');
  });

  it('preserves JPEG as the original format (not silently converted)', async () => {
    const sourcePath = await makeJpeg(150, 150);
    const outputDir = join(workDir, 'out');

    const result = await runVariantJob({ sourcePath, outputDir, baseName: 'backdrop' });
    expect(result.original.filePath).toBe(join(outputDir, 'backdrop-original.jpg'));

    const files = await readdir(outputDir);
    expect(files).toContain('backdrop-original.jpg');
  });

  it('writes an AVIF sibling for every width when this sharp build supports AVIF encoding', async () => {
    const sourcePath = await makePng(400, 400);
    const outputDir = join(workDir, 'out');

    const result = await runVariantJob({ sourcePath, outputDir, baseName: 'thumb' });
    const files = await readdir(outputDir);

    expect(result.avifWritten).toBe(avifSupported());
    if (result.avifWritten) {
      for (const width of VARIANT_WIDTHS) {
        expect(files).toContain(`thumb-${width}.avif`);
      }
    } else {
      expect(files.some((f) => f.endsWith('.avif'))).toBe(false);
    }
  });

  it('resizes proportionally: a taller-than-wide source keeps its aspect ratio in every variant', async () => {
    const sourcePath = await makePng(100, 300); // 1:3 aspect
    const outputDir = join(workDir, 'out');

    const result = await runVariantJob({ sourcePath, outputDir, baseName: 'poster' });
    for (const variant of result.variants) {
      const ratio = (variant.height ?? 0) / (variant.width ?? 1);
      expect(ratio).toBeCloseTo(3, 1);
    }
  });

  it('rejects cleanly (throws, does not crash) for a malformed/non-image source file', async () => {
    const badPath = join(workDir, 'not-an-image.png');
    await sharp({ create: { width: 1, height: 1, channels: 3, background: 'black' } }).png().toFile(badPath);
    // Corrupt the file after the fact so sharp's header parse fails.
    const fs = await import('node:fs/promises');
    await fs.writeFile(badPath, Buffer.from('not actually a png'));

    await expect(runVariantJob({ sourcePath: badPath, outputDir: join(workDir, 'out2'), baseName: 'poster' })).rejects.toThrow();
  });

  it('rejects cleanly for a source path that does not exist', async () => {
    await expect(
      runVariantJob({ sourcePath: join(workDir, 'nope.png'), outputDir: join(workDir, 'out3'), baseName: 'poster' })
    ).rejects.toThrow();
  });
});

describe('computeDominantColor', () => {
  it('extracts a hex color close to a solid PNG background', async () => {
    const sourcePath = await makePng(120, 80);
    const color = await computeDominantColor(sourcePath);
    expectCloseColor(color, { r: 200, g: 60, b: 60 });
  });

  it('extracts distinct colors for distinct solid backgrounds', async () => {
    const bluePath = join(workDir, 'blue.png');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 10, g: 40, b: 220 } } })
      .png()
      .toFile(bluePath);

    const color = await computeDominantColor(bluePath);
    expectCloseColor(color, { r: 10, g: 40, b: 220 });
  });

  it('rejects cleanly for a source path that does not exist', async () => {
    await expect(computeDominantColor(join(workDir, 'nope.png'))).rejects.toThrow();
  });
});
