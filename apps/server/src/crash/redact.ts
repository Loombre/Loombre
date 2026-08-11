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
// TWIN CONSOLIDATION (pre-D consolidation item 5; A3's Wave-D cleanup
// candidate, recorded in STATE.md). The generic path-matching MACHINERY
// (stack-frame parens/bare forms, quoted paths, bare unquoted paths,
// file:// URLs, and the line-by-line discipline that keeps rules 3/4 from
// re-scanning a line rules 1/2 already resolved) lives in
// packages/shared/src/redact-paths.ts — lifted out of
// apps/worker/src/crash/redact.ts by the M-7 wave so a caller with a
// different notion of a trusted root could reuse it. This module was the
// THIRD copy of that logic and is now the second CONSUMER of the
// canonical one: it keeps only the dataDir-aware DECISION
// (isInsideDataDir) and hands it to `redactPathsInText` as the predicate,
// exactly as apps/worker's twin already does.
//
// What is NOT shared, deliberately: `redactSecretShapedValues` below. Its
// rules are crash-report-specific (Bearer headers, JWT shapes,
// connection-string userinfo) rather than generic path matching, and the
// two apps' copies are a package-local duplication across an app boundary
// neither may import the other across (D2) — the same rationale
// packages/secrets/src/file0600.ts's header gives. Lifting it too would be
// a separate decision with its own callers to find; this change moves only
// what already had a canonical home.
//
// The original module-local pattern documentation now lives in the shared
// module's header, verbatim.

import { normalizeSlashes, redactPathsInText, stripFileUrlPrefix } from "@loombre/shared";

const REDACTED = "<redacted>";

function isInsideDataDir(candidatePath: string, dataDir: string): boolean {
  if (dataDir.length === 0) return false;
  const normCandidate = normalizeSlashes(stripFileUrlPrefix(candidatePath));
  const normDataDir = normalizeSlashes(dataDir).replace(/\/+$/, "");
  return normCandidate === normDataDir || normCandidate.startsWith(`${normDataDir}/`);
}

/** Redacts every absolute filesystem path found in free text that lies
 *  OUTSIDE dataDir, keeping only the basename — paths INSIDE dataDir
 *  (Loombre's own managed directory — a path like
 *  `<dataDir>/postgres/data/base/16384` in a crash stack is useful
 *  diagnostic signal, not personal information) are left alone. Thin
 *  wrapper: the actual line-by-line pattern matching is
 *  packages/shared/src/redact-paths.ts's redactPathsInText; this function
 *  supplies only the dataDir decision. */
export function redactPaths(text: string, dataDir: string): string {
  return redactPathsInText(text, (path) => !isInsideDataDir(path, dataDir));
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
