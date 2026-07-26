# Libraries & scanning

<!-- Sourcing: library creation fields (name, kind, restricted toggle,
     paths), scan-now action, and the "every library needs an explicit
     permission grant, general included, except the creating admin" rule —
     apps/web/src/app/admin/libraries/page.tsx header comment. Scanner
     behavior (incremental, watches folders, filename parsing patterns,
     rename detection via content matching, 72-hour grace period before a
     missing file is removed) — docs/PLAN.md §8.1-8.2, and
     apps/worker/src/scan/scanner.ts's header comment (checkpointing,
     file.relocated events, MISSING_HARD_CASCADE_GRACE_MS = 72h). -->

A **library** is a collection of media that lives in one or more folders
on disk — for example, "Movies" pointing at your movies folder, or "TV
Shows" pointing at a folder of shows.

## Creating a library

From the Libraries screen, choose **New library** and fill in:

- **Name** — whatever you want to call it.
- **Kind** — Movie, TV, or Music. This affects how Loombre reads
  filenames and organizes what it finds.
- **Restricted** — turn this on if this library should require a PIN and
  explicit permission to view (see
  [Users & permissions](users-permissions.md)). Off by default.
- **Paths** — one or more folder locations. Ask whoever installed Loombre
  for the correct value here if you're not sure — it depends on how
  Loombre was installed (see the [Operator Guide](../ops/index.md) if that's you).

[SCREENSHOT: Create library modal, showing name/kind/restricted/paths fields]

Only you (the admin who created it) can see a newly created library at
first — **every library needs an explicit permission grant to be visible
to anyone**, including other admins, with one exception: the admin who
creates a library is automatically granted access to it. See
[Users & permissions](users-permissions.md) for granting access
to everyone else.

## What scanning does

Once a library has paths, Loombre scans it — walking through the folder,
finding media files, and reading each one's name (and, for music, its
embedded tags) to figure out what it is.

- **It keeps watching.** After the first scan, Loombre notices new,
  changed, or removed files in that folder automatically — you don't need
  to trigger a scan by hand every time you add something, though a
  **Scan now** button is available on each library if you want to force
  an immediate check.
- **It recognizes renamed or moved files.** If you rename or reorganize a
  file within your library, Loombre matches it to the same file it already
  knew about (by its content, not just its name), so your watch history
  and other details are preserved instead of treated as a brand-new item.
- **Missing files aren't removed immediately.** If a file becomes
  temporarily unreachable — a network drive dropping out, for
  example — Loombre waits before treating it as actually gone (about three
  days), rather than immediately discarding it and losing your watch
  history over what might be a temporary hiccup.
- **Naming matters for movies and TV.** Loombre expects a reasonably
  standard naming pattern to correctly identify titles and episodes (for
  example, a movie folder or file named with its title and year, and TV
  episodes numbered by season and episode). Music is identified primarily
  by the tags embedded in the audio files themselves, not the filename.

[SCREENSHOT: Library detail view showing scan progress / Scan now button]

If a scan doesn't find what you expect, the
[Jobs dashboard](jobs-dashboard.md) shows the scan's progress
and any errors it ran into.
