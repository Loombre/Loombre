// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/redact-paths.ts
//
// Pure filesystem-path text redaction, lifted from
// apps/worker/src/crash/redact.ts (M-7 second-half fix wave, closes the
// deferred LPP ledger-error-path-redaction half — STATE.md's LPP
// adversarial findings). That module's original header explains the
// pattern-matching rules in full; they are reproduced verbatim here,
// parameterized on a `shouldRedact` decision per matched path instead of
// that module's own hardcoded "outside dataDir" rule, so a second caller
// with a DIFFERENT (or no) notion of a trusted root directory — the job
// ledger, which has none — can reuse the exact same, already-hardened
// matching logic (stack-frame parens/bare forms, quoted paths, bare
// unquoted paths, file:// URLs) without re-deriving it.
//
// Every absolute filesystem path found in free text is matched; whether a
// given match is ACTUALLY redacted is entirely up to the caller-supplied
// `shouldRedact` predicate. apps/worker's/apps/server's own crash-report
// redactPaths(text, dataDir) wraps this with "redact everything outside
// dataDir" (paths inside Loombre's own managed directory are useful
// diagnostic signal, not personal information); a caller with no such
// exception (e.g. packages/jobs's ledger — see that package's own
// redact-paths.ts for why it holds a deliberate LOCAL duplicate of this
// file rather than importing it) simply passes `() => true`.

const REDACTED = "<redacted>";

/** Exported so a caller's own path-classification logic (e.g.
 *  apps/worker's/apps/server's "is this path inside my managed dataDir"
 *  check, which feeds this module's `shouldRedact` predicate) can compare
 *  paths under the SAME slash-normalization this module itself uses,
 *  rather than risking a subtly different comparison. */
export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** `file://` URLs are percent-encoded — a literal space becomes `%20` — so
 *  decodeURIComponent recovers the real filesystem path first. Malformed
 *  percent-encoding must never throw and abort redaction — falls back to
 *  the raw string. Non-file:// input passes through unchanged. Exported
 *  for the same reason as normalizeSlashes above. */
export function stripFileUrlPrefix(candidate: string): string {
  if (!/^file:\/\//i.test(candidate)) return candidate;
  const withoutScheme = candidate.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

function basenameOf(path: string): string {
  const normalized = normalizeSlashes(stripFileUrlPrefix(path)).replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function looksLikeAbsolutePath(candidate: string): boolean {
  const trimmed = candidate.trim();
  return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || /^file:\/\//i.test(trimmed);
}

/** A decision function: true means REDACT this matched path (collapse to
 *  `<redacted>/<basename>`); false means leave it exactly as-is. */
export type PathRedactionDecision = (path: string) => boolean;

function redactOnePath(path: string, shouldRedact: PathRedactionDecision): string {
  return shouldRedact(path) ? `${REDACTED}/${basenameOf(path)}` : path;
}

/** Redacts every absolute filesystem path `shouldRedact` says to, keeping
 *  only the basename. Processes LINE BY LINE (never a single blanket
 *  multi-pass regex sweep over the whole text) so a line a stack-frame rule
 *  (1/2) already resolved — including the "leave it alone" outcome — is
 *  never re-scanned by the generic message-path rules (3/4) below it: those
 *  use a no-embedded-spaces fast path that would otherwise truncate an
 *  ALREADY-CORRECT parenthesized match at the first space (a dev checkout
 *  path containing a space, e.g. "App Development", is caught by exactly
 *  this bug if the rules are allowed to double-scan a line) and mis-redact
 *  the tail as if it were a second, unrelated path. */
export function redactPathsInText(text: string, shouldRedact: PathRedactionDecision): string {
  return text
    .split("\n")
    .map((line) => redactPathsInLine(line, shouldRedact))
    .join("\n");
}

function redactPathsInLine(line: string, shouldRedact: PathRedactionDecision): string {
  // 1) "at fn (PATH:line:col)" — [^()]+ tolerates spaces inside the parens.
  //    If this line contains one or more such frames, that's the ENTIRE
  //    redaction this line gets — rules 3/4 below are skipped for it.
  let matchedParenFrame = false;
  const parenResult = line.replace(/\(([^()]+):(\d+):(\d+)\)/g, (whole, path: string, ln: string, col: string) => {
    if (!looksLikeAbsolutePath(path)) return whole;
    matchedParenFrame = true;
    return `(${redactOnePath(path, shouldRedact)}:${ln}:${col})`;
  });
  if (matchedParenFrame) return parenResult;

  // 2) "at PATH:line:col" with no parens (top-level/anonymous frames) —
  //    anchored on the trailing ":digits:digits" so the captured path can
  //    safely contain spaces. Whole-line match, so this also fully
  //    replaces the line when it fires (no rule-3/4 fallthrough needed).
  const bareMatch = /^(\s*at )(.+):(\d+):(\d+)(\s*)$/.exec(line);
  if (bareMatch) {
    const [, prefix, path, ln, col, suffix] = bareMatch as unknown as [string, string, string, string, string, string];
    if (looksLikeAbsolutePath(path)) {
      return `${prefix}${redactOnePath(path, shouldRedact)}:${ln}:${col}${suffix}`;
    }
  }

  // 3) Quoted absolute paths anywhere in a non-stack-frame line (fs error
  //    strings like `open '/Users/x/.secret'`).
  let result = line;
  result = result.replace(/'((?:\/|[A-Za-z]:[\\/])[^']*)'/g, (_whole, path: string) => `'${redactOnePath(path, shouldRedact)}'`);
  result = result.replace(/"((?:\/|[A-Za-z]:[\\/])[^"]*)"/g, (_whole, path: string) => `"${redactOnePath(path, shouldRedact)}"`);

  // 4) Bare (unquoted) absolute paths and file:// URLs anywhere else — the
  //    common case for most real deployments. file:// URLs never contain a
  //    literal space (always percent-encoded), so this no-embedded-spaces
  //    pass captures them completely regardless of the underlying path's
  //    own contents; a space-containing bare PLAIN path OUTSIDE a stack
  //    frame or quotes has no reliable delimiter and is a known, documented
  //    limitation (inherited from this logic's original apps/worker home).
  result = result.replace(
    /(^|[\s(])((?:file:\/\/|\/|[A-Za-z]:[\\/])[^\s'")]+)/gi,
    (whole, pre: string, path: string) => `${pre}${redactOnePath(path, shouldRedact)}`,
  );

  return result;
}
