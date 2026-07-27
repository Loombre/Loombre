// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/contract/test/admin-only-parity-diff.ts
//
// L3 (owner brief), adjudication C-4: a small pure helper computing the
// diff between the canonical admin-only event-type list
// (packages/shared/src/admin-only-event-types.ts) and its machine-readable
// mirror in envelope.schema.json's `x-loombre-admin-only-event-types`
// array — extracted out of the parity spec so the FAILURE MESSAGE SHAPE
// itself can be unit-tested (admin-only-parity-diff.spec.ts) independent
// of the live schema/canonical files, per C-5's "demonstrated, not
// assumed" requirement.
//
// No I/O, no test-framework import — a pure function over two string
// arrays, callable from both the unit tests (fixture inputs) and the live
// parity test (real files read off disk).

export interface AdminOnlyParityDiff {
  /** Present in the canonical list but absent from the schema's mirror. */
  missingFromSchema: string[];
  /** Present in the schema's mirror but absent from the canonical list. */
  extraInSchema: string[];
}

/** Diffs the canonical admin-only event-type list against the schema's
 *  `x-loombre-admin-only-event-types` mirror. Order-independent (both are
 *  logically sets); duplicates in either input collapse. Returned arrays
 *  are sorted for a deterministic, readable message. */
export function diffAdminOnlyEventTypes(canonical: readonly string[], schemaMirror: readonly string[]): AdminOnlyParityDiff {
  const canonicalSet = new Set(canonical);
  const schemaSet = new Set(schemaMirror);
  return {
    missingFromSchema: [...canonicalSet].filter((t) => !schemaSet.has(t)).sort(),
    extraInSchema: [...schemaSet].filter((t) => !canonicalSet.has(t)).sort(),
  };
}

/** Formats a human-readable failure message naming both files and every
 *  differing entry, or `undefined` when the diff is empty (perfect
 *  parity — the caller asserts this is `undefined`). Both `canonicalFile`
 *  and `schemaFile` are repo-relative paths, always named in the message
 *  regardless of which side (or both) has the delta — C-4's requirement
 *  that the failure "name both files". */
export function formatAdminOnlyParityMessage(diff: AdminOnlyParityDiff, canonicalFile: string, schemaFile: string): string | undefined {
  if (diff.missingFromSchema.length === 0 && diff.extraInSchema.length === 0) {
    return undefined;
  }

  const lines = [`Admin-only event-type list parity mismatch between ${canonicalFile} and ${schemaFile}:`];
  if (diff.missingFromSchema.length > 0) {
    lines.push(`  missing from schema (present in ${canonicalFile}, absent from ${schemaFile}): ${diff.missingFromSchema.join(", ")}`);
  }
  if (diff.extraInSchema.length > 0) {
    lines.push(`  extra in schema (present in ${schemaFile}, absent from ${canonicalFile}): ${diff.extraInSchema.join(", ")}`);
  }
  return lines.join("\n");
}
