// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/match.ts
//
// Deterministic best-match picking (P1.6): combines title similarity
// (normalized Levenshtein) with a year-distance penalty. Ties are broken
// deterministically by search-result order (first candidate wins), and a
// close-call between the top two candidates is logged as an ambiguity —
// never silently guessed without a trace.

import type { ProviderSearchResult, SearchQuery } from './provider.js';

const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]/g;

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICAL_MARKS, '') // strip diacritics (post-NFKD)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Classic Levenshtein edit distance, O(n*m), fine for title-length strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/** 1.0 = identical (after normalization), 0.0 = completely dissimilar. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

const YEAR_PENALTY_PER_YEAR = 0.05;
const MAX_YEAR_PENALTY = 0.5;
/** Candidates within this score of the top pick are logged as ambiguous. */
const AMBIGUITY_MARGIN = 0.03;

export interface ScoredCandidate {
  result: ProviderSearchResult;
  score: number;
}

/**
 * Exported (Phosphor retheme Wave 2, Lane L2 — Fix Match): the same
 * title-similarity-minus-year-penalty score pickBestMatch uses internally,
 * exposed so match-search-consumer.ts can rank EVERY candidate across
 * EVERY provider in a chain (not just the single winner pickBestMatch
 * picks per provider) for the admin candidate-list UI's confidence bars.
 */
export function scoreCandidate(query: SearchQuery, candidate: ProviderSearchResult): number {
  const similarity = titleSimilarity(query.title, candidate.title);
  let yearPenalty = 0;
  if (query.year != null && candidate.year != null) {
    yearPenalty = Math.min(MAX_YEAR_PENALTY, Math.abs(query.year - candidate.year) * YEAR_PENALTY_PER_YEAR);
  }
  return similarity - yearPenalty;
}

export interface PickBestMatchOptions {
  /** Injectable for tests that want to assert on the ambiguity log without
   *  polluting stdout. @default console.warn */
  log?: (message: string) => void;
}

/**
 * Scores every candidate deterministically and returns the highest-scoring
 * one (stable order: the first candidate wins a tie), or null if
 * `candidates` is empty. Logs (does not throw) when the top two scores are
 * within AMBIGUITY_MARGIN of each other.
 */
export function pickBestMatch(
  query: SearchQuery,
  candidates: ProviderSearchResult[],
  opts: PickBestMatchOptions = {}
): ProviderSearchResult | null {
  if (candidates.length === 0) return null;

  const log = opts.log ?? ((message: string) => console.warn(message));

  const scored: ScoredCandidate[] = candidates.map((result) => ({ result, score: scoreCandidate(query, result) }));

  let bestIndex = 0;
  for (let i = 1; i < scored.length; i++) {
    if ((scored[i]?.score ?? -Infinity) > (scored[bestIndex]?.score ?? -Infinity)) {
      bestIndex = i;
    }
  }
  const best = scored[bestIndex]!;

  if (scored.length > 1) {
    const runnerUp = scored
      .filter((_, i) => i !== bestIndex)
      .reduce((max, c) => (c.score > max.score ? c : max));
    if (best.score - runnerUp.score <= AMBIGUITY_MARGIN) {
      log(
        `metadata/match: ambiguous match for "${query.title}"` +
          `${query.year != null ? ` (${query.year})` : ''} — top candidate "${best.result.title}" ` +
          `(score ${best.score.toFixed(3)}) vs "${runnerUp.result.title}" (score ${runnerUp.score.toFixed(3)})`
      );
    }
  }

  return best.result;
}
