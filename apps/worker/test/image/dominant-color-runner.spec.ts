// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/dominant-color-runner.spec.ts
//
// Proves runDominantColorInWorkerThread actually offloads the decode to a
// real `node:worker_threads` Worker (T0 mandate, CLAUDE.md invariant 9) —
// not just calling computeDominantColor in-process. Mirrors
// worker-runner.spec.ts's own convention exactly.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { runDominantColorInWorkerThread } from '../../src/image/dominant-color-runner.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'loombre-dominant-color-runner-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('runDominantColorInWorkerThread', () => {
  it('extracts a hex color inside a real worker thread, close to the solid background', async () => {
    const sourcePath = join(workDir, 'source.png');
    await sharp({ create: { width: 150, height: 150, channels: 3, background: { r: 20, g: 180, b: 40 } } }).png().toFile(sourcePath);

    const color = await runDominantColorInWorkerThread(sourcePath);

    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    expect(Math.abs(r - 20)).toBeLessThanOrEqual(8);
    expect(Math.abs(g - 180)).toBeLessThanOrEqual(8);
    expect(Math.abs(b - 40)).toBeLessThanOrEqual(8);
  }, 20_000);

  it('rejects (does not hang or crash the process) for a source path that does not exist', async () => {
    await expect(runDominantColorInWorkerThread(join(workDir, 'nope.png'))).rejects.toThrow();
  }, 20_000);
});
