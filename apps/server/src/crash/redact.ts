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
  //
  // V1-003: a literal "@" is legal in BOTH the username and the password
  // (WHATWG URL parsing splits authority on the LAST "@", not the first —
  // verified against pg-connection-string and the URL constructor, which
  // both accept it as a working connection string). This first finds the
  // scheme://...@...host-shaped TOKEN (up to the next whitespace/slash),
  // then — for each token found — resolves the split itself with plain
  // string ops (lastIndexOf the "@" that separates userinfo from host,
  // then the first ":" that separates username from password) rather than
  // trusting a single greedy capture group to land on the right "@".
  //
  // R5 ALLOWLIST FIX (third-wave denylist finally retired): every prior
  // pass here tried to stop the HOST half at the separator between two
  // DISTINCT connection strings by enumerating forbidden characters
  // (first whitespace/"/", then +",;\"'", then +"`()[]{}") — and each
  // time, a new separator (this wave: "&", "|", "<", ">") turned up that
  // wasn't on the list, over-consumed past it, and swallowed the second
  // scheme://user:pass@host whole, leaving ITS password unredacted (the
  // /g scan resumes mid-token, past the "\w+://" the next match needs).
  // A denylist can only ever be as complete as the set of separators
  // someone thought to type into a connection-failure message — that set
  // is unbounded (JSON, shell quoting, log-array brackets, arbitrary
  // punctuation a driver chooses to glue two DSNs together with).
  //
  // A host, unlike "whatever comes after the first '@'", is NOT an
  // open-ended alphabet — RFC 3986 reg-name is unreserved (ALPHA / DIGIT /
  // "-" / "." / "_" / "~") + pct-encoded + a handful of sub-delims that no
  // real DNS name or IPv4/IPv6 literal actually uses, plus "[" "]" for an
  // IPv6 literal and ":" for the port. So HOST is allowlisted instead:
  // `[A-Za-z0-9._~%:[\]-]*`. "&", "|", "<", ">", ",", ";", the quote
  // characters, and paren/brace punctuation are NOT legal host characters,
  // so the allowlist alone stops the match at any of THOSE boundaries —
  // for free, without a denylist entry for each one.
  //
  // F1 LOOKAHEAD FIX: that guarantee does NOT extend to a boundary made of
  // characters that ARE legal in a host — and "[", "]", ".", ":", "-",
  // "_", "~", "%" are exactly the IPv6-literal / port / reg-name
  // characters this allowlist exists to permit. Two credentialed URLs
  // glued by nothing but those characters — `[postgres://u1:P1@h1]
  // [postgres://u2:P2@h2]`, a colon-joined "h1::postgres://…", a
  // dot-joined "h1.postgres://…", or no separator at all — over-consume
  // straight past the real host boundary into the second URL's scheme,
  // swallow it whole, and its password survives unredacted: the same
  // "can't enumerate every separator" failure the denylist-to-allowlist
  // rewrite above was meant to retire, recurring one level up. An
  // allowlist of legal host characters can't also express "and don't
  // cross into a following scheme," because a following scheme is built
  // entirely out of characters the host allowlist has to accept — no
  // character-class boundary, allow or deny, can supply that; only
  // looking at what comes next can. So the host run is matched one
  // character at a time with a negative lookahead,
  // `(?:(?!\w+:\/\/)[A-Za-z0-9._~%:[\]-])*`: each candidate host
  // character is consumed only if the position it sits at does not
  // itself begin a new `scheme://`. That is the structural property —
  // "stop before the next connection string starts," not "stop at an
  // illegal character" — the allowlist alone could never provide.
  //
  // That in turn means the USERINFO (username:password) half no longer
  // has to defensively exclude those same separator characters — the
  // now-bounded host is what stops the match from crossing into a second
  // connection string, not the userinfo class. So userinfo is relaxed
  // back to excluding only whitespace (can't span a token boundary) and
  // "/" (so it can never read through a second string's own "scheme://").
  // This restores redaction for a password that legitimately contains a
  // "," ";" '"' "'" "`" "(" ")" "[" "]" or "{" "}" — under the old
  // denylist that password broke the match ENTIRELY (userinfo could never
  // reach the required "@"), leaving the whole token unredacted and the
  // password leaking IN FULL, which is a strictly worse failure than the
  // over-consumption bug this fix also closes.
  result = result.replace(/\w+:\/\/[^\s/]*@(?:(?!\w+:\/\/)[A-Za-z0-9._~%:[\]-])*/g, (token) => {
    const schemeEnd = token.indexOf("://") + 3;
    const schemePrefix = token.slice(0, schemeEnd);
    const authority = token.slice(schemeEnd);
    const atIdx = authority.lastIndexOf("@");
    if (atIdx === -1) return token;
    const userinfo = authority.slice(0, atIdx);
    const host = authority.slice(atIdx + 1);
    const colonIdx = userinfo.indexOf(":");
    if (colonIdx === -1) return token;
    const username = userinfo.slice(0, colonIdx);
    return `${schemePrefix}${username}:${REDACTED}@${host}`;
  });

  return result;
}

export function redactFreeText(text: string, dataDir: string): string {
  return redactSecretShapedValues(redactPaths(text, dataDir));
}
