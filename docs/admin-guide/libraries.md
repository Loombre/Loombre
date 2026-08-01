# Libraries & scanning

<!-- Sourcing: library creation fields (name, kind, restricted toggle,
     paths), scan-now action, and the "every library needs an explicit
     permission grant, general included, except the creating admin" rule —
     apps/web/src/app/admin/libraries/page.tsx header comment. Scanner
     behavior (incremental, watches folders, filename parsing patterns,
     rename detection via content matching, 72-hour grace period before a
     missing file is removed) — docs/PLAN.md §8.1-8.2, and
     apps/worker/src/scan/scanner.ts's header comment (checkpointing,
     file.relocated events, MISSING_HARD_CASCADE_GRACE_MS = 72h). Supported
     file types + the v1 exclusions (STATE.md H3; .mts admission, owner
     ledger L1) — apps/worker/src/scan/parse/path-utils.ts's
     VIDEO_EXTENSIONS/AUDIO_EXTENSIONS/EXCLUDED_MEDIA_EXTENSIONS; the skip
     report — scanner.ts's scan.completed skippedUnsupportedCount/
     skippedUnsupportedFiles, surfaced in the admin dashboard's Libraries
     panel (apps/web/src/components/admin/LibrariesPanel.tsx). Files that
     fail inspection after ingest (owner ledger L1) — apps/worker/src/
     probe/terminal-failure-hook.ts's probe.failed event (packages/
     contract/event-schemas/probe.failed.schema.json), surfaced on the
     same Libraries panel via apps/web/src/lib/admin-dashboard-live.ts's
     probeFailed accumulator. -->

A **library** is a collection of media that lives in one or more folders
on disk — for example, "Movies" pointing at your movies folder, or "TV
Shows" pointing at a folder of shows.

## Creating a library

From **Settings → Libraries**, choose **+ Add library** and fill in:

- **Name** — whatever you want to call it.
- **Kind** — Movie, TV, or Music. This affects how Loombre reads
  filenames and organizes what it finds.
- **Restricted** — turn this on if this library should require a PIN and
  explicit permission to view (see
  [Users & permissions](users-permissions.md)). Off by default.
- **Paths** — one or more folder locations. The **Browse…** button opens
  a picker that navigates the *server's* own folders, so you can find the
  right location without knowing the path by heart. You can still type a
  path manually (useful for locations the picker can't show, e.g. inside
  a container); if you're unsure what's right, ask whoever installed
  Loombre (see the [Operator Guide](../ops/index.md) if that's you).

[SCREENSHOT: Create library modal, showing name/kind/restricted/paths fields]

**Every library needs an explicit permission grant to be visible to
anyone**, including other admins, with one exception that applies to
*general* libraries only: the admin who creates a general library is
automatically granted access to it. A **restricted** library is never
auto-granted to anyone — including its creator: you must grant yourself
access the same way you'd grant anyone else, so a newly created
restricted library is invisible to everybody until you do. See
[Users & permissions](users-permissions.md) for granting access.

## What scanning does

Once a library has paths, Loombre scans it — walking through the folder,
finding media files, and reading each one's name (and, for music, its
embedded tags) to figure out what it is.

- **It keeps watching.** After the first scan, Loombre notices new,
  changed, or removed files in that folder automatically — you don't need
  to trigger a scan by hand every time you add something. To force an
  immediate check anyway, use the **Scan now** button on the admin
  Dashboard's Libraries panel, or the **Scan** / **Full rescan** actions
  in a library's **⋯** menu under Settings → Libraries.
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

### Supported file types

Loombre recognizes most common video and audio file types when scanning:

| Kind  | File endings recognized |
| ----- | ------------------------ |
| Video | .mkv, .mp4, .avi, .mov, .m4v, .ts, .m2ts, .mts, .webm, .wmv, .mpg, .mpeg, .vob, .flv |
| Audio | .flac, .mp3, .m4a, .ogg, .oga, .opus, .wav, .alac, .aac, .aiff, .aif |

A number of recognized media file types are **not** supported in this
version:

| File ending | Why it's left out |
| ----------- | ------------------ |
| .ape | Genuinely rare, thin support for turning it into something playable |
| .wv | Genuinely rare, thin support for turning it into something playable |
| .wma | Genuinely rare, thin support for turning it into something playable |
| .asf, .ogv, .3gp, .3g2, .divx, .m2v, .rm, .rmvb, .wtv, .f4v, .dv | Recognized video types not yet supported — reported as skipped so nothing disappears without a trace |
| .mka, .m4b, .dsf, .dff, .mpc, .tta, .ra, .shn, .amr, .ac3, .dts, .spx | Recognized audio types not yet supported — reported as skipped so nothing disappears without a trace |

Files with one of those endings are never dropped silently — the scan's
outcome always records a **"N skipped (unsupported format)"** count and
the exact list of files. You'll see that note on the Libraries panel of
your admin dashboard when a scan finishes while the dashboard is open
(including if you opened it mid-scan), and the server's own log records
every skipped file for after-the-fact review, so you always know what was
left out and why, and can decide whether to convert those files to a
supported type yourself.

Files whose endings aren't recognized as media at all — notes, artwork,
text files, and other junk that rides along in media folders — are
treated as non-media and ignored without a report. The skip report covers
recognized media types only.

Separately, a file with a recognized ending can still turn out not to be
readable media once Loombre actually inspects it — a corrupted download, a
placeholder file, or a file that was simply misnamed. Those are reported
too: the same Libraries panel shows a **"N failed inspection (unreadable
media)"** note listing the affected files, as they're discovered, for as
long as the dashboard stays open.
