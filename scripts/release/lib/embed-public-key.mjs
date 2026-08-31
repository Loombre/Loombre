// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/lib/embed-public-key.mjs
//
// Pure rendering of packages/shared/src/update-public-key.ts from the raw
// text of keys/minisign.pub (P4.9's location #1). Embedding the key as a
// compiled TS constant — rather than having the server read keys/
// minisign.pub off disk at boot — sidesteps install-layout path
// resolution entirely (installer lanes I1/I3/I4 don't need to agree on
// "where does keys/ end up relative to the running server" the way they
// would for a runtime file read): the key becomes part of
// packages/shared's compiled dist output, exactly like LOOMBRE_VERSION_FULL
// (scripts/release/lib/derive-version.mjs).

const GENERATED_BANNER = "// GENERATED — do not edit (node scripts/release/embed-public-key.mjs)\n";

/**
 * @param {string} rawFileContents keys/minisign.pub's exact text
 * @returns {string} packages/shared/src/update-public-key.ts source
 */
export function renderPublicKeyFileSource(rawFileContents) {
  const trimmed = rawFileContents.trimEnd();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error(
      `embed-public-key: keys/minisign.pub does not look like a minisign public-key file (expected >= 2 non-empty lines, got ${lines.length})`,
    );
  }

  return (
    GENERATED_BANNER +
    "//\n" +
    "// The pinned minisign public key (P4.9 location #1: keys/minisign.pub —\n" +
    "// this file is a direct, byte-faithful embed of it). The server's\n" +
    "// update-check verifier (apps/server/src/common/update-check) imports\n" +
    "// ONLY this constant, never reads keys/minisign.pub off disk at runtime —\n" +
    "// see scripts/release/lib/embed-public-key.mjs's header for why.\n" +
    "// Regenerate with `pnpm embed-public-key` whenever keys/minisign.pub\n" +
    "// changes — initial real-key rollout (done; see keys/README.md) or any\n" +
    "// future key rotation (keys/README.md has the full checklist either way).\n" +
    "\n" +
    `export const LOOMBRE_UPDATE_PUBLIC_KEY_TEXT = ${JSON.stringify(`${trimmed}\n`)};\n`
  );
}
