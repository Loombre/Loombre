// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/src/redact-paths.ts
//
// M-7 fix wave (second half, STATE.md LPP adversarial findings): a job's
// error string (thrown by a scan/probe/transcode/metadata job — CLAUDE.md
// invariant 6 territory) can embed a filesystem path from the user's own
// library/staging directories (e.g. an ENOENT naming the exact file that
// failed). ledger.ts's recordFailed/recordRetrying persist that string
// into `jobs.last_error` AND the `job.updated` outbox payload — both of
// which a general (non-admin-scoped) audience can eventually read once a
// plugin is granted job.updated (the LIVE-SUBSCRIBER leak itself was
// already closed by H-4's ADMIN_ONLY gating; this is the STORED-STRING
// half that gating alone does not redact). Narrow scope: paths only, never
// the rest of the message.
//
// Deliberately duplicated from packages/shared/src/redact-paths.ts's
// redactPathsInText (the canonical, already-hardened path-matching
// implementation — see that file's own header for the full rule set)
// rather than imported: this package takes no @loombre/shared workspace
// dependency, same documented constraint packages/jobs/src/ids.ts and
// types.ts's MetadataJobPayload doc comment already establish for exactly
// this reason (a small, pure, rarely-changing utility is cheaper to keep
// in sync by convention than to justify a new cross-package dependency
// edge for). Unlike the canonical version, this package has no "trusted
// root directory" concept at all (no dataDir, no equivalent) — every
// absolute path found is redacted, unconditionally.
//
// If the underlying matching rules ever need to change, update BOTH this
// file and packages/shared/src/redact-paths.ts together (packages/shared/
// test/redact-paths.test.ts and this package's own ledger-events.spec.ts
// M-7 cases both pin the exact same output shapes, so a divergence would
// surface as a test failure in one package or the other, not silently).

const REDACTED = '<redacted>';

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

function stripFileUrlPrefix(candidate: string): string {
  if (!/^file:\/\//i.test(candidate)) return candidate;
  const withoutScheme = candidate.replace(/^file:\/\//i, '');
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

function basenameOf(path: string): string {
  const normalized = normalizeSlashes(stripFileUrlPrefix(path)).replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function looksLikeAbsolutePath(candidate: string): boolean {
  const trimmed = candidate.trim();
  return (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\\\') || // UNC (\\server\share\...) — common for NAS/SMB media libraries
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^file:\/\//i.test(trimmed)
  );
}

function redactOnePath(path: string): string {
  return `${REDACTED}/${basenameOf(path)}`;
}

// KEEP IN SYNC with packages/shared/src/redact-paths.ts's ABSOLUTE_MARKER /
// BARE_PATH_BODY / BARE_PATH_RE (this package holds a deliberate local
// duplicate — see this file's header). One absolute-path start marker:
// POSIX slash, UNC \\, Windows drive, or file://.
const ABSOLUTE_MARKER = String.raw`file:\/\/|\\\\|[A-Za-z]:[\\/]|\/`;

// Body of a bare path AFTER its marker: separators, non-separator "word"
// runs, or internal whitespace consumed only when a later separator (before
// the next whitespace) proves the space is inside a directory segment. This
// is what makes "/data/My Movies/film.mkv not found" redact to the basename
// without leaking the "My Movies/" tail, while "/etc and /var" stays two
// separate single-component paths.
const BARE_PATH_BODY = String.raw`(?:[\/\\]|[^\/\\\s'"()\[\]]+|[ \t]+(?=[^\s'"()\[\]]*[\/\\]))*`;

// A bare path anywhere in a line. Group 1 is the re-emitted pre-context
// (line start / whitespace / "(" / "[" / "=" / "," / a glued "key:" prefix
// whose colon is followed by a SINGLE slash, so "error:/data/x" redacts but
// a "scheme://" authority is never touched). Group 2 is the path.
const BARE_PATH_RE = new RegExp(String.raw`(^|[\s(\[=,]|:(?=\/(?!\/)))((?:${ABSOLUTE_MARKER})${BARE_PATH_BODY})`, 'gi');

/**
 * Redacts every absolute filesystem path found in `text`, unconditionally,
 * keeping only the basename — e.g. `open '/data/library/movie.mkv'` becomes
 * `open '<redacted>/movie.mkv'`. Processes line by line: each line's
 * stack-frame rules run first, then the generic message-path rules run over
 * what those left behind (a single log line can carry both a frame and a
 * trailing message path). The widened bare-path body is internal-space-safe,
 * so re-scanning a line never mis-truncates an already-correct match, and an
 * already-redacted `<redacted>/basename` is never re-matched (see packages/
 * shared/src/redact-paths.ts's header for the full rationale).
 */
export function redactAllPaths(text: string): string {
  return text
    .split('\n')
    .map((line) => redactPathsInLine(line))
    .join('\n');
}

function redactPathsInLine(line: string): string {
  // 1) "at fn (PATH:line:col)" stack-frame form. Redacts each frame in
  //    place; same-line message paths are still handled by rules 3/4 below.
  let matchedParenFrame = false;
  const working = line.replace(/\(([^()]+):(\d+):(\d+)\)/g, (whole, path: string, ln: string, col: string) => {
    if (!looksLikeAbsolutePath(path)) return whole;
    matchedParenFrame = true;
    return `(${redactOnePath(path)}:${ln}:${col})`;
  });

  // 2) "at PATH:line:col" with no parens (only when the line is not a paren
  //    frame — a paren frame line is never also a bare whole-line frame).
  if (!matchedParenFrame) {
    const bareMatch = /^(\s*at )(.+):(\d+):(\d+)(\s*)$/.exec(working);
    if (bareMatch) {
      const [, prefix, path, ln, col, suffix] = bareMatch as unknown as [string, string, string, string, string, string];
      if (looksLikeAbsolutePath(path)) {
        return `${prefix}${redactOnePath(path)}:${ln}:${col}${suffix}`;
      }
    }
  }

  // 3) Quoted absolute paths (fs error strings, e.g. `open
  //    '/data/library/movie.mkv'`). Inner start now also admits file:// and
  //    UNC prefixes (quoted/JSON-embedded `"file:///…"` blind spot).
  let result = working;
  result = result.replace(/'((?:file:\/\/|\/|\\\\|[A-Za-z]:[\\/])[^']*)'/g, (_whole, path: string) => `'${redactOnePath(path)}'`);
  result = result.replace(/"((?:file:\/\/|\/|\\\\|[A-Za-z]:[\\/])[^"]*)"/g, (_whole, path: string) => `"${redactOnePath(path)}"`);

  // 4) Bare (unquoted) absolute paths, file:// URLs, UNC and Windows drive
  //    paths — BARE_PATH_RE (widened pre-context + internal-space-safe body).
  result = result.replace(BARE_PATH_RE, (_whole, pre: string, path: string) => `${pre}${redactOnePath(path)}`);

  return result;
}
