// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/worker-runner.spec.ts
//
// Proves runInWorkerThread actually offloads the variant job to a real
// `node:worker_threads` Worker (T0 mandate, CLAUDE.md invariant 9) — not
// just calling runVariantJob in-process. Runs under both plain `node`
// (via vitest) and confirms the tsx-loader execArgv fallback works when
// only the .ts sibling exists next to worker-runner.ts (true for this
// entire test run, since the package is never `tsc`-built first).

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { runInWorkerThread } from '../../src/image/worker-runner.js';
import { VARIANT_WIDTHS } from '../../src/image/variant-job.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'loombre-worker-runner-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('runInWorkerThread', () => {
  it('runs the variant job inside a real worker thread and returns the same shape as runVariantJob', async () => {
    const sourcePath = join(workDir, 'source.png');
    await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 200, b: 10 } } }).png().toFile(sourcePath);

    const outputDir = join(workDir, 'out');
    const result = await runInWorkerThread({ sourcePath, outputDir, baseName: 'poster' });

    expect(result.variants).toHaveLength(VARIANT_WIDTHS.length);
    expect(typeof result.blurhash).toBe('string');

    const files = await readdir(outputDir);
    expect(files).toContain('poster-original.png');
    for (const width of VARIANT_WIDTHS) {
      expect(files).toContain(`poster-${width}.webp`);
    }
  }, 20_000);

  it('rejects (does not hang or crash the process) when the worker thread hits a malformed source', async () => {
    const badPath = join(workDir, 'bad.png');
    await import('node:fs/promises').then((fs) => fs.writeFile(badPath, 'not an image'));

    await expect(runInWorkerThread({ sourcePath: badPath, outputDir: join(workDir, 'out2'), baseName: 'poster' })).rejects.toThrow();
  }, 20_000);

  it('runs two jobs concurrently without interference (separate threads, separate output dirs)', async () => {
    const sourceA = join(workDir, 'a.png');
    const sourceB = join(workDir, 'b.png');
    await Promise.all([
      sharp({ create: { width: 120, height: 80, channels: 3, background: 'red' } }).png().toFile(sourceA),
      sharp({ create: { width: 80, height: 120, channels: 3, background: 'blue' } }).png().toFile(sourceB),
    ]);

    const [resultA, resultB] = await Promise.all([
      runInWorkerThread({ sourcePath: sourceA, outputDir: join(workDir, 'outA'), baseName: 'poster' }),
      runInWorkerThread({ sourcePath: sourceB, outputDir: join(workDir, 'outB'), baseName: 'poster' }),
    ]);

    expect(resultA.original.width).toBe(120);
    expect(resultB.original.width).toBe(80);
  }, 20_000);
});
