// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/crash/redact.ts
//
// Pure text redaction for crash reports (STATE.md P4.14, docs/PLAN.md §10
// "Crash reports are written to a local file only" — D14 "no telemetry,
// ever" makes what we WRITE locally the only privacy boundary that
// matters, since nothing here is ever transmitted automatically).
//
// Two independent redaction passes run over every free-text field (an
// Error's `message` and `stack`):
//
//   1. PATH redaction — "every path outside the app-data dir replaced by
//      <redacted>/basename" (task spec, verbatim). Paths INSIDE dataDir are
//      left alone (that's Loombre's own managed directory — a path like
//      `<dataDir>/postgres/data/base/16384` in a crash stack is useful
//      diagnostic signal, not personal information). Everything else — the
//      operator's home directory, the dev checkout path, any filesystem
//      location a stack frame or an fs error message happens to mention —
//      collapses to `<redacted>/<basename>`, keeping just enough to tell
//      "a config file" from "a media file" apart without exposing the
//      directory structure (which can itself leak a username, a NAS
//      mount name, a media library's folder-naming scheme, etc).
//   2. SECRET-SHAPED VALUE redaction — independent of paths entirely:
//      Bearer tokens, JWT-shaped three-part base64url strings, and
//      key=value / key: value pairs whose key looks like
//      token/password/secret/api-key/authorization. This is the "NO env
//      values, NO tokens" half of the spec — belt-and-suspenders on top of
//      the crash report NEVER including a raw process.env dump in the
//      first place (buildCrashReport, ./report.ts, only ever serializes
//      {ts, version, platform, error: {name, message, stack}} — there is
//      no field an env var could ride in except these two free-text ones,
//      which is exactly what this pass scrubs).
//
// Deliberately module-local (not imported from packages/shared): this
// wave's task explicitly scopes the ONE new packages/shared export to
// crashDirPath alone, to avoid touching shared files a concurrent lane
// (the IPC listener) also depends on. apps/worker/src/crash/redact.ts is
// an intentional near-identical twin — same rationale as
// packages/secrets/src/file0600.ts's header on package-local duplication
// across an app boundary neither app may import the other across (D2).

const REDACTED = "<redacted>";

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** `file://` URLs (ESM import errors/stack frames commonly carry these,
 *  e.g. "Cannot find package ... imported from file:///Users/x/app.js") are
 *  percent-encoded — a literal space becomes `%20` — so decodeURIComponent
 *  recovers the real filesystem path before the inside/outside-dataDir
 *  comparison runs. Non-file:// input passes through unchanged. Malformed
 *  percent-encoding must never throw and abort redaction — falls back to
 *  the raw string. */
function stripFileUrlPrefix(candidate: string): string {
  if (!/^file:\/\//i.test(candidate)) return candidate;
  const withoutScheme = candidate.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

function isInsideDataDir(candidatePath: string, dataDir: string): boolean {
  if (dataDir.length === 0) return false;
  const normCandidate = normalizeSlashes(stripFileUrlPrefix(candidatePath));
  const normDataDir = normalizeSlashes(dataDir).replace(/\/+$/, "");
  return normCandidate === normDataDir || normCandidate.startsWith(`${normDataDir}/`);
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

function redactPath(path: string, dataDir: string): string {
  if (isInsideDataDir(path, dataDir)) return path;
  return `${REDACTED}/${basenameOf(path)}`;
}

/** Redacts every absolute filesystem path found in free text that lies
 *  OUTSIDE dataDir, keeping only the basename. Processes LINE BY LINE
 *  (never a single blanket multi-pass regex sweep over the whole text) so
 *  a line that a stack-frame rule (1/2) already resolved — including the
 *  "leave it alone, it's inside dataDir" outcome — is never re-scanned by
 *  the generic message-path rules (3/4) below it: those use a
 *  no-embedded-spaces fast path that would otherwise truncate an
 *  ALREADY-CORRECT parenthesized match at the first space (this repo's own
 *  dev checkout path has one — "App Development" — caught by exactly this
 *  bug during testing) and mis-redact the tail as if it were a second,
 *  unrelated path. */
export function redactPaths(text: string, dataDir: string): string {
  return text
    .split("\n")
    .map((line) => redactPathsInLine(line, dataDir))
    .join("\n");
}

function redactPathsInLine(line: string, dataDir: string): string {
  // 1) "at fn (PATH:line:col)" — [^()]+ tolerates spaces inside the parens.
  //    If this line contains one or more such frames, that's the ENTIRE
  //    redaction this line gets — rules 3/4 below are skipped for it.
  let matchedParenFrame = false;
  const parenResult = line.replace(/\(([^()]+):(\d+):(\d+)\)/g, (whole, path: string, ln: string, col: string) => {
    if (!looksLikeAbsolutePath(path)) return whole;
    matchedParenFrame = true;
    return `(${redactPath(path, dataDir)}:${ln}:${col})`;
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
      return `${prefix}${redactPath(path, dataDir)}:${ln}:${col}${suffix}`;
    }
  }

  // 3) Quoted absolute paths anywhere in a non-stack-frame line (fs error
  //    strings like `open '/Users/x/.secret'`).
  let result = line;
  result = result.replace(/'((?:\/|[A-Za-z]:[\\/])[^']*)'/g, (_whole, path: string) => `'${redactPath(path, dataDir)}'`);
  result = result.replace(/"((?:\/|[A-Za-z]:[\\/])[^"]*)"/g, (_whole, path: string) => `"${redactPath(path, dataDir)}"`);

  // 4) Bare (unquoted) absolute paths and file:// URLs anywhere else — the
  //    common case for most real deployments. file:// URLs never contain a
  //    literal space (always percent-encoded), so this no-embedded-spaces
  //    pass captures them completely regardless of the underlying path's
  //    own contents; a space-containing bare PLAIN path OUTSIDE a stack
  //    frame or quotes has no reliable delimiter and is a known, documented
  //    limitation (see this module's header).
  result = result.replace(
    /(^|[\s(])((?:file:\/\/|\/|[A-Za-z]:[\\/])[^\s'")]+)/gi,
    (whole, pre: string, path: string) => `${pre}${redactPath(path, dataDir)}`,
  );

  return result;
}

/** Redacts Bearer tokens, JWT-shaped three-segment base64url strings, and
 *  `key=value`/`key: value` pairs whose key names a credential — belt and
 *  suspenders on top of the crash report never carrying a raw env dump. */
export function redactSecretShapedValues(text: string): string {
  let result = text;

  // Bearer TOKEN first — the realistic shape for an Authorization header
  // (apps/server's own AuthGuard: `Bearer <jwt>`, token.service.ts). Runs
  // BEFORE the generic key=value rule below so "Authorization: Bearer …"
  // is fully consumed here; "authorization" is deliberately EXCLUDED from
  // that rule's key list so it can never re-match and mangle the literal
  // word "Bearer" this pass just placed next to <redacted>.
  result = result.replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, `Bearer ${REDACTED}`);

  // Three dot-separated base64url segments, each long enough not to catch
  // ordinary short dotted identifiers (semver strings, hostnames).
  result = result.replace(/[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}/g, REDACTED);

  result = result.replace(
    /((?:token|password|passwd|secret|api[_-]?key)\s*[:=]\s*)("?)([^\s,;"'&]+)("?)/gi,
    (_whole, prefix: string, openQuote: string, _value: string, closeQuote: string) => `${prefix}${openQuote}${REDACTED}${closeQuote}`,
  );

  // Connection-string-embedded credentials: scheme://user:PASSWORD@host —
  // e.g. a postgres:// DATABASE_URL surfacing in a connection-failure
  // message. Only the password segment is replaced; user/host/port stay
  // (diagnostically useful, not secret).
  result = result.replace(
    /(\w+:\/\/[^\s:/@]+:)([^@\s/]+)(@)/g,
    (_whole, prefix: string, _password: string, at: string) => `${prefix}${REDACTED}${at}`,
  );

  return result;
}

export function redactFreeText(text: string, dataDir: string): string {
  return redactSecretShapedValues(redactPaths(text, dataDir));
}
