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
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") || // UNC (\\server\share\...) — common for NAS/SMB media libraries
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^file:\/\//i.test(trimmed)
  );
}

// One absolute-path start marker: a POSIX slash, a UNC \\ prefix, a Windows
// drive (C:\ / C:/), or a file:// scheme. Shared by the quoted (rule 3) and
// bare (rule 4) matchers below so the two can never disagree about what an
// absolute path may begin with.
const ABSOLUTE_MARKER = String.raw`file:\/\/|\\\\|[A-Za-z]:[\\/]|\/`;

// The BODY of a bare (unquoted) path AFTER its start marker, walked as a run
// of: a path separator ([/\\]); OR a non-separator "word" run (which may hold
// a filename's dots, dashes, colons — but never a quote/paren/bracket that
// would end a log token); OR internal whitespace, consumed ONLY when a later
// separator (before the next whitespace) proves the space is inside a
// DIRECTORY segment rather than the boundary between the basename and the
// surrounding message. That lookahead is the whole space-safety story: it
// spans "/data/My Movies/film.mkv not found" up to `film.mkv` (redacting the
// leaked "My Movies/" directory tail) yet still stops "/etc and /var" after
// "/etc" (two separate single-component paths, not one).
const BARE_PATH_BODY = String.raw`(?:[\/\\]|[^\/\\\s'"()\[\]]+|[ \t]+(?=[^\s'"()\[\]]*[\/\\]))*`;

// A bare path anywhere in a line. Group 1 is the PRE-context that pins the
// start to a real boundary and is re-emitted verbatim: line start, or a
// delimiter the old class was too narrow for (whitespace/"("/"["/"="/","),
// or a glued "key:" prefix — matched only when the colon is followed by a
// SINGLE slash, so "error:/data/x" redacts while "postgres://user:pw@host"
// (a `://` scheme authority) is left for the crash redactor's separate
// secret-shaped-value pass and never mangled here. Group 2 is the path.
const BARE_PATH_RE = new RegExp(String.raw`(^|[\s(\[=,]|:(?=\/(?!\/)))((?:${ABSOLUTE_MARKER})${BARE_PATH_BODY})`, "gi");

/** A decision function: true means REDACT this matched path (collapse to
 *  `<redacted>/<basename>`); false means leave it exactly as-is. */
export type PathRedactionDecision = (path: string) => boolean;

function redactOnePath(path: string, shouldRedact: PathRedactionDecision): string {
  return shouldRedact(path) ? `${REDACTED}/${basenameOf(path)}` : path;
}

/** Redacts every absolute filesystem path `shouldRedact` says to, keeping
 *  only the basename. Processes LINE BY LINE (never a single blanket
 *  multi-pass regex sweep over the whole text) so each line's stack-frame
 *  rules (1/2) run first, then the generic message-path rules (3/4) run over
 *  what those left behind. The message-path rules ARE allowed to run on a
 *  line that also carried a stack frame (a single log line can hold both — a
 *  frame AND a trailing "while opening <path>" clause) because the widened
 *  bare-path matcher (BARE_PATH_BODY) is now internal-space-safe: it captures
 *  a whole "/data/App Development/x" rather than truncating at the first
 *  space, so re-scanning a line can neither mis-truncate an already-correct
 *  frame path nor wrongly re-redact a dataDir-INSIDE path that rule 1 left
 *  intact (the full path still classifies the same way under `shouldRedact`).
 *  An already-redacted "<redacted>/basename" is never re-matched either — the
 *  ">" it follows is not a bare-path pre-context character. */
export function redactPathsInText(text: string, shouldRedact: PathRedactionDecision): string {
  return text
    .split("\n")
    .map((line) => redactPathsInLine(line, shouldRedact))
    .join("\n");
}

function redactPathsInLine(line: string, shouldRedact: PathRedactionDecision): string {
  // 1) "at fn (PATH:line:col)" — [^()]+ tolerates spaces inside the parens.
  //    Redacts each frame in place; the (possibly space-containing) message
  //    paths on the SAME line are still handled by rules 3/4 below.
  let matchedParenFrame = false;
  const working = line.replace(/\(([^()]+):(\d+):(\d+)\)/g, (whole, path: string, ln: string, col: string) => {
    if (!looksLikeAbsolutePath(path)) return whole;
    matchedParenFrame = true;
    return `(${redactOnePath(path, shouldRedact)}:${ln}:${col})`;
  });

  // 2) "at PATH:line:col" with no parens (top-level/anonymous frames) —
  //    anchored on the trailing ":digits:digits" so the captured path can
  //    safely contain spaces. Whole-line match, so this fully replaces the
  //    line when it fires. Only checked when the line is not a parenthesized
  //    frame (a paren frame line is never also a bare whole-line frame).
  if (!matchedParenFrame) {
    const bareMatch = /^(\s*at )(.+):(\d+):(\d+)(\s*)$/.exec(working);
    if (bareMatch) {
      const [, prefix, path, ln, col, suffix] = bareMatch as unknown as [string, string, string, string, string, string];
      if (looksLikeAbsolutePath(path)) {
        return `${prefix}${redactOnePath(path, shouldRedact)}:${ln}:${col}${suffix}`;
      }
    }
  }

  // 3) Quoted absolute paths anywhere in a non-stack-frame line (fs error
  //    strings like `open '/Users/x/.secret'`). The inner start now also
  //    admits a file:// URI and a UNC prefix, closing the blind spot where a
  //    quoted/JSON-embedded `"file:///…"` fell between this rule (which only
  //    recognized `/`- or drive-started inners) and the bare rule (whose
  //    pre-context could not see a `file://` glued to an opening quote).
  let result = working;
  result = result.replace(/'((?:file:\/\/|\/|\\\\|[A-Za-z]:[\\/])[^']*)'/g, (_whole, path: string) => `'${redactOnePath(path, shouldRedact)}'`);
  result = result.replace(/"((?:file:\/\/|\/|\\\\|[A-Za-z]:[\\/])[^"]*)"/g, (_whole, path: string) => `"${redactOnePath(path, shouldRedact)}"`);

  // 4) Bare (unquoted) absolute paths, file:// URLs, UNC paths and Windows
  //    drive paths anywhere else. BARE_PATH_RE widens both the pre-context
  //    (glued key=/error:/[.../,... prefixes) and the path body (UNC
  //    backslash separators, internal directory spaces) — see the constant
  //    definitions above.
  result = result.replace(BARE_PATH_RE, (_whole, pre: string, path: string) => `${pre}${redactOnePath(path, shouldRedact)}`);

  return result;
}
