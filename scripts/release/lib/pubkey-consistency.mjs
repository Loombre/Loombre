// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/lib/pubkey-consistency.mjs
//
// Pure logic for the minisign public-key consistency + placeholder-
// rejection gate. Kept separate from check-pubkey-consistency.mjs (the
// CLI/fs-reading wrapper) so scripts/release/test/pubkey-consistency.
// test.mjs can exercise it with node:test and in-memory fixtures — no real
// files, no CI environment, no git checkout needed.
//
// STATE.md P4.9 itself defines exactly THREE canonical, independently-
// controlled trust locations (keys/minisign.pub, the docs site's
// docs/ops/updating.md, and every release's notes) — "so key-substitution
// attacks require compromising all of them." This module's FIXED_LOCATIONS
// checks five things in total: those three, PLUS the GENERATED
// packages/shared/src/update-public-key.ts (a build-artifact-freshness
// check — "did someone forget to run `pnpm embed-public-key`", not a
// fourth independent P4.9 trust root), PLUS docs/install/linux.md (an
// install-guide page that also displays the key for the reader's
// convenience; not a P4.9 trust root either, but a wrong key on it is
// exactly as misleading to a downloader as a wrong key anywhere else —
// added as the H5 residue fix after an audit found it still showing the
// all-zero placeholder after the real key had landed everywhere else).
//
// Two things this module proves, together:
//
//   1. Byte-identical agreement across FIXED_LOCATIONS.
//   2. Placeholder rejection: the all-zero minisign key
//      (RWQAAA...AAAA) — structurally valid so tooling can parse it, but
//      cryptographically inert by design — is checked EVERYWHERE this
//      module looks, including keys/minisign.pub itself. This closes the
//      gap the H5 audit finding named: five identical placeholders agree
//      with each other perfectly and the old mutual-equality-only check
//      would PASS. Placeholder detection is a separate, prior check, not
//      folded into the equality comparison.
//
// Also runs a docs-wide sweep (`docsSweep`): any OTHER tracked .md page
// under docs/ that happens to carry a LOOMBRE_MINISIGN_PUBLIC_KEY marker
// block (docs pages nobody remembered to add to FIXED_LOCATIONS) must
// still extract cleanly and must not hold the placeholder. This is how
// docs/install/linux.md's placeholder survived a real key landing
// everywhere else — it was never a checked location, and nothing swept
// docs/ for other copies either.

export const BEGIN_MARKER = "LOOMBRE_MINISIGN_PUBLIC_KEY_BEGIN";
export const END_MARKER = "LOOMBRE_MINISIGN_PUBLIC_KEY_END";

// The all-zero placeholder minisign public key's base64 body (see
// keys/README.md — "The file currently committed is the REAL key" /
// docs/install/linux.md's own `untrusted comment:` line). A real Ed25519
// minisign public key is pseudorandom; it will never legitimately equal
// this exact all-zero-padded string.
export const PLACEHOLDER_KEY_LINE = "RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// Belt-and-braces signal: every placeholder block's `untrusted comment:`
// line self-identifies as "PLACEHOLDER" (see docs/install/linux.md line
// ~78 pre-fix). A real key's comment is `minisign public key <key ID>`
// and never contains this word, so this cannot false-positive against a
// real, landed key.
export const PLACEHOLDER_COMMENT_MARKER = "PLACEHOLDER";

export const OWNER_ACTION =
  "generate the real keypair per keys/README.md, wire it with `pnpm embed-public-key` + the marker blocks";

/**
 * The five locations the real minisign public key must be byte-identical
 * across — the three P4.9 trust roots plus the generated-freshness copy
 * plus the H5 residue fix (see module header for which is which). `kind`
 * selects how the raw file text is reduced to "just the key block" before
 * comparison:
 *   - "raw":          the whole file IS the key (keys/minisign.pub).
 *   - "markedBlock":  a single ```-fenced block between BEGIN_MARKER /
 *                     END_MARKER comments, markers OUTSIDE the fence.
 *   - "generatedTs":  the `LOOMBRE_UPDATE_PUBLIC_KEY_TEXT = "...";` JS
 *                     string literal in the GENERATED update-public-key.ts.
 */
export const FIXED_LOCATIONS = [
  { label: "keys/minisign.pub", kind: "raw" },
  { label: "docs/ops/updating.md", kind: "markedBlock" },
  { label: "scripts/release/release-notes-template.md", kind: "markedBlock" },
  { label: "packages/shared/src/update-public-key.ts", kind: "generatedTs" },
  { label: "docs/install/linux.md", kind: "markedBlock" },
];

const FIXED_LOCATION_LABELS = new Set(FIXED_LOCATIONS.map((loc) => loc.label));

const GENERATED_TS_PATTERN = /LOOMBRE_UPDATE_PUBLIC_KEY_TEXT = "([\s\S]*?)";\n?$/;

export function normalize(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

/** Extracts the fenced-code-block content between the two marker comments. */
export function extractMarkedBlock(source, sourceLabel) {
  const beginIdx = source.indexOf(BEGIN_MARKER);
  const endIdx = source.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`${sourceLabel}: missing or misordered ${BEGIN_MARKER}/${END_MARKER} markers`);
  }
  const between = source.slice(beginIdx + BEGIN_MARKER.length, endIdx);
  const fenceMatches = [...between.matchAll(/```(?:\n|\r\n)([\s\S]*?)```/g)];
  if (fenceMatches.length !== 1) {
    const hint =
      fenceMatches.length === 0
        ? " (if a ``` fence WRAPS the markers instead of the markers wrapping the fence, there is no fence strictly between them — reorder so the markers are outside the fence)"
        : "";
    throw new Error(
      `${sourceLabel}: expected exactly one \`\`\`-fenced block between the markers, found ${fenceMatches.length}${hint}`,
    );
  }
  const content = fenceMatches[0][1];
  if (content === undefined) {
    throw new Error(`${sourceLabel}: fenced block matched but captured no content`);
  }
  return content.trimEnd();
}

/** Extracts the LOOMBRE_UPDATE_PUBLIC_KEY_TEXT string literal's decoded value. */
export function extractGeneratedTsKey(source, sourceLabel) {
  const match = source.match(GENERATED_TS_PATTERN);
  if (!match || match[1] === undefined) {
    throw new Error(`${sourceLabel}: could not find the LOOMBRE_UPDATE_PUBLIC_KEY_TEXT export`);
  }
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch (err) {
    throw new Error(`${sourceLabel}: LOOMBRE_UPDATE_PUBLIC_KEY_TEXT literal failed to JSON-decode: ${err.message}`, {
      cause: err,
    });
  }
}

function extractByKind(kind, raw, label) {
  switch (kind) {
    case "raw":
      return raw;
    case "markedBlock":
      return extractMarkedBlock(raw, label);
    case "generatedTs":
      return extractGeneratedTsKey(raw, label);
    default:
      throw new Error(`${label}: unknown location kind ${JSON.stringify(kind)}`);
  }
}

/** @param {string} value already-normalized key-block text */
export function detectPlaceholder(value) {
  return value.includes(PLACEHOLDER_KEY_LINE) || value.includes(PLACEHOLDER_COMMENT_MARKER);
}

export function placeholderMessage(label) {
  return `${label}: still holds the all-zero PLACEHOLDER minisign key — ${OWNER_ACTION}.`;
}

/**
 * @param {object} input
 * @param {Record<string, string>} input.files map of FIXED_LOCATIONS label
 *   -> that file's raw text. A label with no entry is reported as a
 *   "missing" problem rather than thrown, so one absent file doesn't abort
 *   the whole run.
 * @param {Array<{ path: string, content: string }>} [input.docsSweep] every
 *   other tracked .md file under docs/ (source tree — never
 *   docs/.vitepress/dist), regardless of whether it contains a marker
 *   block. Entries whose `path` matches a FIXED_LOCATIONS label are
 *   skipped here (already fully checked, with equality, above).
 * @returns {{ ok: boolean, problems: Array<{type: "missing"|"structural"|"placeholder"|"mismatch", label: string, message: string}>, locations: Array<{label: string, value: string}> }}
 */
export function checkPubkeyConsistency({ files, docsSweep = [] }) {
  const problems = [];
  const extracted = [];

  for (const loc of FIXED_LOCATIONS) {
    const raw = files[loc.label];
    if (raw === undefined) {
      problems.push({
        type: "missing",
        label: loc.label,
        message: `${loc.label}: no content supplied to check-pubkey-consistency (file missing or unreadable)`,
      });
      continue;
    }
    let value;
    try {
      value = normalize(extractByKind(loc.kind, raw, loc.label));
    } catch (err) {
      problems.push({ type: "structural", label: loc.label, message: err.message });
      continue;
    }
    extracted.push({ label: loc.label, value });
  }

  // Placeholder detection FIRST, and over every successfully-extracted
  // fixed location including keys/minisign.pub — this is what makes the
  // placeholder itself a failure condition instead of something that
  // merely agrees with itself four times over. See module header.
  const validLocations = [];
  for (const loc of extracted) {
    if (detectPlaceholder(loc.value)) {
      problems.push({ type: "placeholder", label: loc.label, message: placeholderMessage(loc.label) });
    } else {
      validLocations.push(loc);
    }
  }

  // Mutual byte-equality over whatever's left (placeholder locations
  // already have their own, more specific problem entry above and are
  // excluded here to avoid a redundant "disagrees with X" on top of it).
  if (validLocations.length > 1) {
    const [reference, ...rest] = validLocations;
    for (const loc of rest) {
      if (loc.value !== reference.value) {
        problems.push({
          type: "mismatch",
          label: loc.label,
          message: `${loc.label}: disagrees with ${reference.label} (P4.9 five-location consistency check)`,
        });
      }
    }
  }

  // Docs-wide sweep: any other tracked docs/**/*.md page carrying a marker
  // block must extract cleanly and must not hold the placeholder. Not
  // folded into the mutual-equality set above — this is a general safety
  // net over pages nobody added to FIXED_LOCATIONS, not a sixth+ P4.9
  // location.
  for (const doc of docsSweep) {
    if (FIXED_LOCATION_LABELS.has(doc.path)) continue;
    if (!doc.content.includes(BEGIN_MARKER)) continue;
    let value;
    try {
      value = normalize(extractMarkedBlock(doc.content, doc.path));
    } catch (err) {
      problems.push({ type: "structural", label: doc.path, message: err.message });
      continue;
    }
    if (detectPlaceholder(value)) {
      problems.push({ type: "placeholder", label: doc.path, message: placeholderMessage(doc.path) });
    }
  }

  return { ok: problems.length === 0, problems, locations: extracted };
}
