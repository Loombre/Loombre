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
//
// deriveHdrForDisplay (browser-items-F6, P3): same "plain mapping function,
// zero I/O" shape as toOpenGop above, so it gets the same pure-unit
// treatment here rather than a live-DB round trip. See its own doc comment
// in src/query/media-info.ts for the full rationale; catalog-detail.spec.ts
// covers the live-DB integration (fetchMediaFilesBatch actually selecting
// color_transfer and wiring it through).

import { describe, expect, it } from 'vitest';
import { deriveHdrForDisplay, toOpenGop } from '../src/query/media-info.js';

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

describe('deriveHdrForDisplay (browser-items-F6: unset hdr must not read back as a confident "SDR")', () => {
  it('trusts a real stored hdr verdict unconditionally, even when color_transfer disagrees', () => {
    // hdr and color_transfer are always written together by the SAME
    // resolveHdr() call (apps/worker/src/probe/extract.ts) — a stored hdr
    // value is never second-guessed against color_transfer.
    expect(deriveHdrForDisplay('dv', 'smpte2084')).toBe('dv');
    expect(deriveHdrForDisplay('none', 'bt709')).toBe('none');
  });

  it('passes a stored hdr value through toHdr()\'s existing untrusted-enum defense unchanged', () => {
    expect(deriveHdrForDisplay('not-a-real-enum-value', null)).toBe('none');
  });

  it('derives hdr10 from color_transfer=smpte2084 (PQ) when hdr is unset', () => {
    expect(deriveHdrForDisplay(null, 'smpte2084')).toBe('hdr10');
  });

  it('derives hlg from color_transfer=arib-std-b67 when hdr is unset', () => {
    expect(deriveHdrForDisplay(null, 'arib-std-b67')).toBe('hlg');
  });

  it('never guesses "dv" from color_transfer alone (a DV profile-8 stream also carries smpte2084 — DV needs the DOVI side-data signal, which is not a separate stored column)', () => {
    expect(deriveHdrForDisplay(null, 'smpte2084')).toBe('hdr10');
  });

  it('omits the label (returns null) rather than asserting "SDR" when hdr is unset and color_transfer gives no HDR signal either', () => {
    expect(deriveHdrForDisplay(null, 'bt709')).toBeNull();
    expect(deriveHdrForDisplay(null, null)).toBeNull();
  });
});
