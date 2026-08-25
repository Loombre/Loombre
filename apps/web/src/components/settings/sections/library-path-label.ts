// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/library-path-label.ts
//
// browser-admin-F9: library NAMES are not unique — nothing in the schema
// or the create endpoint forbids two libraries called "Movies", and in
// practice that is the common case (a seeded fixture library alongside a
// real one). The only stable disambiguator a human can act on is the
// library's root path(s), which every Library carries (`paths`, required
// by the contract's Library schema).
//
// /settings/libraries has always shown a path sub-line per row
// (LibrariesSection's LibraryRow). The GRANT surfaces — the per-user
// Library access modal (UsersSection) and the invite grant list
// (CreateInviteSheet) — did not, so an admin picking between two "Movies"
// rows was guessing. An invite grant is unrevokable once claimed, so the
// guess is not cheap. This module is the one place that formats that
// sub-line, so both surfaces stay identical.
//
// Returns null (never an empty string) when there is nothing worth
// showing, so callers can drop the element entirely rather than render an
// empty line: `paths` is required by the contract, but a defensive
// undefined/[] must not become "undefined" on an admin's screen.

export function libraryPathLabel(paths: readonly string[] | null | undefined): string | null {
  if (!paths) return null;
  const roots = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  return roots.length > 0 ? roots.join(", ") : null;
}

/**
 * d3-d9: the same disambiguator for surfaces that have only ONE STRING to
 * work with — an `aria-label`, a dialog title — where the row's two-line
 * name-over-path treatment above is not available. /settings/libraries had
 * three: the row menu's `Manage <name>` (two libraries called "Movies"
 * yielded two buttons with the identical accessible name, so an AT user
 * picking between them was guessing where a sighted user reads the path
 * sub-line), and the Edit/Permissions dialog titles.
 *
 * Falls back to the bare name when there is no path worth showing, so a
 * defensive empty `paths` can never render "Movies ()".
 */
export function libraryNameWithPath(name: string, paths: readonly string[] | null | undefined): string {
  const label = libraryPathLabel(paths);
  return label === null ? name : `${name} (${label})`;
}
