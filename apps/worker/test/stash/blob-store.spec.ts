// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stashBlobRelativePath, readFilesystemBlob, makeBlobResolver } from '../../src/stash/blob-store.js';
import type { StashBlob } from '../../src/stash/read-model.js';

describe('stash filesystem blob store', () => {
  describe('stashBlobRelativePath — Stash sharding (depth=2, length=2)', () => {
    it('shards a checksum into <c0:2>/<c2:4>/<checksum> (verified vs Stash fs.go/dir.go)', () => {
      expect(stashBlobRelativePath('abcd1234ef567890')).toBe(join('ab', 'cd', 'abcd1234ef567890'));
      // A real cover checksum shape from the owner's DB (32-hex md5-style).
      expect(stashBlobRelativePath('0001c51c2799abde1122334455667788')).toBe(
        join('00', '01', '0001c51c2799abde1122334455667788'),
      );
    });

    it('returns the bare checksum when it is too short to shard (mirrors GetIntraDir\'s guard)', () => {
      expect(stashBlobRelativePath('abc')).toBe('abc'); // depth*length (4) > len (3)
    });
  });

  describe('readFilesystemBlob + makeBlobResolver', () => {
    let root: string;
    const checksum = 'deadbeefcafef00d';
    const bytes = Buffer.from([1, 2, 3, 4, 5]);

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'loombre-blobstore-'));
      const dir = join(root, 'de', 'ad');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, checksum), bytes);
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('reads bytes from the sharded on-disk path', () => {
      expect(readFilesystemBlob(root, checksum)).toEqual(bytes);
    });

    it('returns null for an absent blob (missing cover is normal, never throws)', () => {
      expect(readFilesystemBlob(root, 'ffffffffffffffff')).toBeNull();
    });

    it('returns null when no blobs path is configured', () => {
      expect(readFilesystemBlob('', checksum)).toBeNull();
    });

    it('resolver: DB bytes win when present (Database-mode Stash / fixtures)', () => {
      const dbBytes = Buffer.from([9, 9]);
      const sqliteGetBlob = (c: string): StashBlob => ({ checksum: c, bytes: dbBytes });
      const resolve = makeBlobResolver(sqliteGetBlob, root);
      expect(resolve(checksum)?.bytes).toEqual(dbBytes); // never fell through to fs
    });

    it('resolver: falls back to the filesystem when the DB row carries no bytes', () => {
      const sqliteGetBlob = (c: string): StashBlob => ({ checksum: c, bytes: null });
      const resolve = makeBlobResolver(sqliteGetBlob, root);
      const got = resolve(checksum);
      expect(got?.bytes).toEqual(bytes);
      expect(got?.checksum).toBe(checksum);
    });

    it('resolver: DB-only mode (blobsPath null) preserves the exact prior return', () => {
      const nullReturn = makeBlobResolver(() => null, null);
      expect(nullReturn(checksum)).toBeNull();
      const bytelessReturn = makeBlobResolver((c) => ({ checksum: c, bytes: null }), null);
      expect(bytelessReturn(checksum)?.bytes).toBeNull(); // unchanged: no fs consulted
    });

    it('resolver: DB has no bytes and fs has no file → the DB return (byteless) is preserved', () => {
      const resolve = makeBlobResolver((c) => ({ checksum: c, bytes: null }), root);
      expect(resolve('ffffffffffffffff')?.bytes).toBeNull();
    });
  });
});
