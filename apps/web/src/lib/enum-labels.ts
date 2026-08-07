// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/enum-labels.ts
//
// W3-R (opus review, D-3): display-label maps for the USER-DOMAIN API
// enums that were leaking raw lowercase values into chips/tags. D-3
// (locked): title-case display labels everywhere; lowercase strings are
// internal enum values only. One shared map per enum so a chip and a
// picker can never disagree (UsersSection's role chip said "admin" while
// its own picker said "Admin").
//
// Deliberately NOT here: the registry/plugin-manifest enum values
// rendered by SettingField/PluginConfigForm ("starttls", "http-01",
// "tier-gated", …) — those are the canonical technical config tokens the
// descriptions, tooltips, and env pins reference verbatim; title-casing
// them ("Http-01") would corrupt the vocabulary. That adjudicated D-3
// exception is recorded in STATE.md's Wave-3 section.

export const MEDIA_KIND_LABEL: Record<string, string> = {
  movie: "Movie",
  tv: "TV",
  music: "Music",
};

export const USER_ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  member: "Member",
};

export const PROVIDER_KIND_LABEL: Record<string, string> = {
  builtin: "Built-in",
  plugin: "Plugin",
};

export const STASH_SYNC_MODE_LABEL: Record<string, string> = {
  full: "Full",
  incremental: "Incremental",
};

/** Lookup with an honest fallback: an unknown value renders as itself
 *  rather than crashing or hiding — new enum members degrade visibly. */
export function enumLabel(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}
