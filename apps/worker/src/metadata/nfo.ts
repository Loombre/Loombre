// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/nfo.ts
//
// Kodi-dialect NFO parsing (P1.7, docs/PLAN.md §8.3/§8.4, CLAUDE.md
// invariant 8: "NFO/sidecar reading lives only in the scanner import
// path" — this module has zero side effects and is only ever invoked from
// that path; it does not itself enforce the invariant, the caller does by
// only existing in apps/worker/src/scan|metadata).
//
// Parses movie.nfo / tvshow.nfo / <episode>.nfo. Malformed input (bad XML,
// unrecognized root element) never throws — it returns a typed failure with
// a reason string, exactly like docs/PLAN.md's read-only-sidecar posture
// requires (a corrupt NFO must not crash a scan).

import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface NfoActor {
  name: string;
  role: string | null;
  order: number | null;
}

export interface NfoUniqueId {
  type: string;
  id: string;
}

export interface ParsedNfo {
  /** Which root element was found — the caller uses this to know which
   *  fields are meaningful (season/episode only populated for 'episodedetails'). */
  root: 'movie' | 'tvshow' | 'episodedetails';
  title: string | null;
  sortTitle: string | null;
  year: number | null;
  plot: string | null;
  mpaa: string | null;
  genres: string[];
  tags: string[];
  actors: NfoActor[];
  uniqueIds: NfoUniqueId[];
  /** ISO date string (yyyy-mm-dd) as written in the NFO, unparsed — the
   *  caller converts to epoch ms (CLAUDE.md invariant 5) since that
   *  conversion needs a policy for ambiguous/partial dates this module
   *  should not own. */
  premiered: string | null;
  season: number | null;
  episode: number | null;
}

export type NfoParseResult = { ok: true; nfo: ParsedNfo } | { ok: false; reason: string };

const ROOT_TAGS = ['movie', 'tvshow', 'episodedetails'] as const;
type RootTag = (typeof ROOT_TAGS)[number];

const ARRAY_TAGS = new Set(['genre', 'tag', 'actor', 'uniqueid']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
});

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // fast-xml-parser can hand back an object for a self-closing/empty tag;
  // treat those as "field present but empty" rather than crashing.
  return null;
}

function asInt(value: unknown): number | null {
  const s = asString(value);
  if (s === null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(asString).filter((s): s is string => s !== null);
}

interface RawActor {
  name?: unknown;
  role?: unknown;
  order?: unknown;
}

function asActors(value: unknown): NfoActor[] {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const actors: NfoActor[] = [];
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as RawActor;
    const name = asString(r.name);
    if (name === null) continue;
    actors.push({ name, role: asString(r.role), order: asInt(r.order) });
  }
  return actors;
}

interface RawUniqueId {
  '@_type'?: unknown;
  '#text'?: unknown;
}

function asUniqueIds(value: unknown): NfoUniqueId[] {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const ids: NfoUniqueId[] = [];
  for (const raw of arr) {
    // A <uniqueid> with no children/attributes parses as a bare string.
    if (typeof raw === 'string' || typeof raw === 'number') {
      const id = asString(raw);
      if (id !== null) ids.push({ type: 'unknown', id });
      continue;
    }
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as RawUniqueId;
    const id = asString(r['#text']);
    if (id === null) continue;
    ids.push({ type: asString(r['@_type']) ?? 'unknown', id });
  }
  return ids;
}

function findRoot(doc: Record<string, unknown>): RootTag | null {
  for (const tag of ROOT_TAGS) {
    if (tag in doc) return tag;
  }
  return null;
}

/**
 * Parses NFO XML text. Never throws: malformed XML or an unrecognized root
 * element both come back as `{ ok: false, reason }`. Unknown/unmapped child
 * elements are silently ignored (Kodi NFOs commonly carry extra tags this
 * project has no use for — passthrough-ignored, not an error).
 */
export function parseNfo(xml: string): NfoParseResult {
  // fast-xml-parser's XMLParser.parse() is deliberately lenient (it will
  // silently nest mismatched tags rather than throw), so well-formedness is
  // checked explicitly via XMLValidator first — this is what actually
  // catches unclosed/mismatched tags, not a try/catch around parse().
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    return { ok: false, reason: `xml parse error: ${validation.err.msg} (line ${validation.err.line})` };
  }

  let doc: unknown;
  try {
    doc = parser.parse(xml) as unknown;
  } catch (err) {
    return { ok: false, reason: `xml parse error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (typeof doc !== 'object' || doc === null) {
    return { ok: false, reason: 'xml did not parse to an object' };
  }

  const root = findRoot(doc as Record<string, unknown>);
  if (!root) {
    return { ok: false, reason: `no recognized root element (expected one of ${ROOT_TAGS.join(', ')})` };
  }

  const node = (doc as Record<string, unknown>)[root];
  if (typeof node !== 'object' || node === null) {
    return { ok: false, reason: `<${root}> root element has no content` };
  }
  const n = node as Record<string, unknown>;

  const nfo: ParsedNfo = {
    root,
    title: asString(n.title),
    sortTitle: asString(n.sorttitle),
    year: asInt(n.year),
    plot: asString(n.plot),
    mpaa: asString(n.mpaa),
    genres: asStringArray(n.genre),
    tags: asStringArray(n.tag),
    actors: asActors(n.actor),
    uniqueIds: asUniqueIds(n.uniqueid),
    premiered: asString(n.premiered),
    season: root === 'episodedetails' ? asInt(n.season) : null,
    episode: root === 'episodedetails' ? asInt(n.episode) : null,
  };

  return { ok: true, nfo };
}
