// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/series-resume.ts
//
// Pure decision logic for the Series-detail primary action (design/phosphor/
// README.md "Series detail": "Continue S2E4 primary action"). Split out
// from SeriesDetailScreen.tsx so the resume-target RULE is unit-testable
// without a real fetch: given every episode across every season plus each
// one's real Progress row (or null — never fetched/no progress yet), pick
// exactly one target.
//
// Rule (real data only, no invented "recommended next episode" heuristics):
//   1. Among episodes with progress.state === 'in-progress', the one with
//      the latest updatedAtMs wins (the same recency signal
//      progress_continue_watching_idx is built on, packages/db/migrations/
//      0001_init.sql).
//   2. Otherwise, the first NOT-played episode in (season, episode) order
//      — "continue from where a fresh viewer would start".
//   3. If every fetched episode is played, fall back to the very first
//      episode (a deliberate "start a rewatch" default rather than no
//      action at all).
//   Ties in rule 1 (identical updatedAtMs) resolve to (season, episode)
//   order for determinism.

export interface EpisodeProgressEntry {
  seasonNumber: number;
  episodeNumber: number;
  episodeId: string;
  runtimeMs: number | null;
  progressState: "unplayed" | "in-progress" | "played" | null;
  positionMs: number | null;
  updatedAtMs: number | null;
}

export interface ResumeTarget {
  episodeId: string;
  seasonNumber: number;
  episodeNumber: number;
  /** Only set when the target came from rule 1 (an actual in-progress
   *  position to resume from). */
  positionMs: number | null;
}

function byOrder(a: EpisodeProgressEntry, b: EpisodeProgressEntry): number {
  return a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber;
}

export function pickResumeTarget(entries: EpisodeProgressEntry[]): ResumeTarget | null {
  if (entries.length === 0) return null;

  const inProgress = entries.filter((e) => e.progressState === "in-progress");
  if (inProgress.length > 0) {
    const latest = inProgress.slice().sort((a, b) => {
      const deltaMs = (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0);
      return deltaMs !== 0 ? deltaMs : byOrder(a, b);
    })[0]!;
    return {
      episodeId: latest.episodeId,
      seasonNumber: latest.seasonNumber,
      episodeNumber: latest.episodeNumber,
      positionMs: latest.positionMs,
    };
  }

  const ordered = entries.slice().sort(byOrder);
  const nextUnplayed = ordered.find((e) => e.progressState !== "played");
  const target = nextUnplayed ?? ordered[0]!;
  return {
    episodeId: target.episodeId,
    seasonNumber: target.seasonNumber,
    episodeNumber: target.episodeNumber,
    positionMs: null,
  };
}
