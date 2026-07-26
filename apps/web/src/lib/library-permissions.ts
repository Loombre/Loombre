// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/library-permissions.ts
//
// Pure diff for the Libraries admin panel's permissions editor (Phase 4
// deliverable D). PUT /libraries/{id}/permissions replaces grants ONLY for
// the userIds explicitly present in the submitted `permissions` array
// (packages/db/src/query/libraries.ts's putLibraryPermissionsAdmin doc
// comment: entries not present are left untouched, not implicitly
// revoked) — so the editor must submit an entry for every user whose
// checked state actually CHANGED from what GET /libraries/{id}/permissions
// returned, in both directions (newly granted -> true, newly unchecked ->
// false), never the full user roster on every save.

export interface PermissionEntry {
  userId: string;
  granted: boolean;
}

/**
 * `originallyGranted`/`currentlyChecked` are both userId sets. Returns the
 * minimal entry list to submit: one entry per userId whose membership
 * differs between the two sets, `granted` reflecting the NEW (current)
 * state.
 */
export function diffPermissionsToSubmit(
  originallyGranted: ReadonlySet<string>,
  currentlyChecked: ReadonlySet<string>,
): PermissionEntry[] {
  const entries: PermissionEntry[] = [];

  for (const userId of currentlyChecked) {
    if (!originallyGranted.has(userId)) entries.push({ userId, granted: true });
  }
  for (const userId of originallyGranted) {
    if (!currentlyChecked.has(userId)) entries.push({ userId, granted: false });
  }

  return entries;
}
