// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/test/redact-paths.spec.ts
//
// F4 (M-7 fix wave): the CROSS-PIN half. packages/jobs/src/redact-paths.ts
// is a deliberate LOCAL duplicate of packages/shared/src/redact-paths.ts's
// path-matching machinery (this package takes no @loombre/shared workspace
// dependency — see the src file's header). Both must produce byte-identical
// output for the same input; this unit suite drives redactAllPaths over the
// SAME golden-vector fixture the shared suite drives redactPathsInText(text,
// () => true) over, so any future divergence in the UNC / stack-frame /
// file:// / glued-prefix / space-containing rules between the two copies
// surfaces as a failure here rather than silently.
//
// The fixture is read by relative path (not imported) precisely because
// this package must not take a dependency edge on @loombre/shared —
// mirroring how apps/worker's delivery-loop.integration.spec.ts reaches the
// packages/db migrate script by resolved path. Pure/no-DB, unlike this
// package's ledger-events.spec.ts (which exercises the SAME redaction end to
// end through recordFailed/recordRetrying at persistence time).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactAllPaths } from '../src/redact-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../shared/test/fixtures/redact-path-vectors.json');

interface RedactVector {
  name: string;
  input: string;
  expected: string;
}

const { vectors } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { vectors: RedactVector[] };

describe('redactAllPaths — shared golden-vector fixture (F4: byte-for-byte identical to @loombre/shared redactPathsInText)', () => {
  it('the fixture actually loaded (guards against a silently-empty relative-path read)', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(vector.name, () => {
      expect(redactAllPaths(vector.input)).toBe(vector.expected);
    });
  }
});
