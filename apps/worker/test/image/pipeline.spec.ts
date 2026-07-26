// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/pipeline.spec.ts

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { outputDirFor, resolveDataDir, runImagePipeline } from '../../src/image/pipeline.js';
import { runVariantJob } from '../../src/image/variant-job.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'loombre-pipeline-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  delete process.env.LOOMBRE_DATA_DIR;
});

describe('resolveDataDir', () => {
  it('defaults to ./data', () => {
    expect(resolveDataDir()).toBe('./data');
  });

  it('honors LOOMBRE_DATA_DIR', () => {
    process.env.LOOMBRE_DATA_DIR = '/custom/data';
    expect(resolveDataDir()).toBe('/custom/data');
  });

  it('an explicit argument wins over the env var', () => {
    process.env.LOOMBRE_DATA_DIR = '/custom/data';
    expect(resolveDataDir('/explicit')).toBe('/explicit');
  });
});

describe('outputDirFor', () => {
  it('lays out <dataDir>/images/<entityType>/<entityId>', () => {
    expect(outputDirFor('/data', 'catalog_item', 'abc-123')).toBe(join('/data', 'images', 'catalog_item', 'abc-123'));
  });
});

describe('runImagePipeline', () => {
  it('processes a local source end-to-end into <dataDir>/images/<entityType>/<entityId>/', async () => {
    const sourcePath = join(workDir, 'source.png');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: 'green' } }).png().toFile(sourcePath);

    const result = await runImagePipeline({
      entityType: 'catalog_item',
      entityId: 'item-1',
      kind: 'poster',
      sourcePath,
      dataDir: workDir,
      execute: runVariantJob, // in-process for test speed; worker-runner.spec.ts proves the thread path
    });

    expect(result.variants).toHaveLength(3);
    const outDir = outputDirFor(workDir, 'catalog_item', 'item-1');
    const files = await readdir(outDir);
    expect(files).toContain('poster-original.png');
  });

  it('downloads a url: source, runs the pipeline, then cleans up the temp download', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer();
    const fetchImpl = async (): Promise<Response> => {
      const stream = Readable.toWeb(Readable.from([png])) as unknown as ReadableStream;
      return { ok: true, status: 200, statusText: 'OK', body: stream } as Response;
    };

    const result = await runImagePipeline({
      entityType: 'catalog_item',
      entityId: 'item-2',
      kind: 'backdrop',
      sourcePath: 'url:https://example.invalid/backdrop.jpg',
      dataDir: workDir,
      fetchImpl,
      execute: runVariantJob,
    });

    expect(result.original.width).toBe(64);
    const outDir = outputDirFor(workDir, 'catalog_item', 'item-2');
    const files = await readdir(outDir);
    expect(files).toContain('backdrop-original.png');
  });

  it('propagates a download failure without writing any output files', async () => {
    const fetchImpl = async (): Promise<Response> => ({ ok: false, status: 404, statusText: 'not found', body: null }) as Response;

    await expect(
      runImagePipeline({
        entityType: 'catalog_item',
        entityId: 'item-3',
        kind: 'poster',
        sourcePath: 'url:https://example.invalid/missing.jpg',
        dataDir: workDir,
        fetchImpl,
        execute: runVariantJob,
      })
    ).rejects.toThrow();

    await expect(readdir(outputDirFor(workDir, 'catalog_item', 'item-3'))).rejects.toThrow();
  });
});
