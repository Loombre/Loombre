// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/media-info.spec.ts
//
// Pure unit test — deliberately NOT a live-DB spec, unlike every other file
// in this directory (see leak.spec.ts's header for that convention):
// toOpenGop (src/query/media-info.ts) is a plain exported mapping function
// with zero I/O, so it needs no schema/connection at all. Everything else
// this module does (row assembly, the guard, resolvePrimaryFile) is
// exercised end to end by packages/db/test/transcode-sessions.spec.ts's
// `getMediaInfoForFile` describe block (its guard-free twin,
// src/internal/media-assembly.ts, re-exports this same toOpenGop —
// see that file's own import).

import { describe, expect, it } from 'vitest';
import { toOpenGop } from '../src/query/media-info.js';

describe('toOpenGop (migrations/0038_media_streams_open_gop.sql column mapping)', () => {
  it('maps a real true verdict straight through', () => {
    expect(toOpenGop(true)).toBe(true);
  });

  it('maps a real false verdict straight through', () => {
    expect(toOpenGop(false)).toBe(false);
  });

  it('maps NULL ("not yet probed for this fact") to false — conservative: never strip GOP-boundary NAL units unless positively detected', () => {
    expect(toOpenGop(null)).toBe(false);
  });
});
