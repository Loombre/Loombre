# Connecting Stash

<!-- Sourcing: read-only open + retry + snapshot-copy fallback (never
     writes a byte to the source file, proven at the filesystem level) —
     apps/worker/src/stash/adapter.ts header + openStashConnection.
     Schema-version guard, the exact admin notice text, and the supported
     range — apps/worker/src/stash/guard.ts (STASH_SUPPORTED_SCHEMA_MIN/MAX,
     formatUnsupportedSchemaNotice) and apps/worker/src/stash/connect.ts
     (a database outside the range disables the connection rather than
     guessing). Connection config shape (database path + on/off) —
     packages/contract/openapi.yaml's AdminStashConnection /
     PutAdminStashConnectionRequest schemas. Path mapping (longest-prefix-
     wins, segment-boundary matching) — packages/shared/src/stash-path-
     mapping.ts. Preview reflecting the last inventory pass, never opening
     Stash itself — packages/contract/openapi.yaml's
     AdminStashPathMappingPreview schema + previewAdminLibraryStashPathMappings
     description. What syncs, the authority split, and locked fields —
     apps/worker/src/stash/apply.ts header (probed duration/resolution are
     never written from Stash; ten catalog-level fields go through the same
     locking every other source respects; rating100/10 scale). Sync
     triggers — apps/worker/src/stash/sync-consumer.ts (checkpointed,
     resumable, incremental diff via Stash's own updated_at), apps/worker/
     src/stash/schedule-loop.ts + packages/shared/src/settings-registry.ts's
     `stash.sync.scheduleIntervalMs` (default off), apps/worker/src/stash/
     watcher.ts (debounced database-file watch). Staleness (marked, never
     deleted) — packages/db/src/query/stash-sync-reports.ts's
     markStashScenesStale. Sync report shape — packages/contract/
     openapi.yaml's StashSyncReport/StashSyncReportEnvelope schemas +
     apps/server/src/plugins/admin-stash-sync-report.service.ts. A sync's
     progress appears as an ordinary background job — apps/web/src/
     components/admin/JobsPanel.tsx (see Jobs dashboard). -->

If you keep your own Stash database for a personal collection, Loombre
can read it and bring that information into a restricted library here —
so you get Loombre's browsing, search, and playback on top of the
cataloging work you've already done in Stash, without keeping the two in
sync by hand.

This chapter covers connecting a library to your Stash database, how
Loombre matches Stash's records to your actual files, what information
comes across, and how it stays current over time.

## The one-way guarantee

**Loombre never changes your Stash.** Every connection to your Stash
database opens it strictly for reading — Loombre has no code path that
writes to it, renames it, or otherwise touches it in any way. This isn't a
setting you could accidentally turn off; there is nothing to write with.

If your Stash program happens to be using the database at the exact
moment Loombre wants to read it, Loombre retries automatically for a few
seconds. If the file is still busy after that, Loombre reads a temporary
copy instead — made fresh, read once, and deleted afterward — rather than
giving up or waiting indefinitely. Either way, nothing is ever written
back to your actual Stash database. There is currently no way for changes
made in Loombre to flow back to Stash; this is a one-way connection, by
design.

## Connecting a library

A Stash connection belongs to one restricted library at a time, the same
way that library already has its own name and its own folders (see
[Libraries & scanning](libraries.md)). Two things make up the connection:

- **The Stash database file** — its location on the disk your Loombre
  server can see.
- **On or off** — whether Loombre is currently allowed to read it.
  Turning this off simply stops Loombre from reading that database; it
  doesn't undo anything already brought in, and turning it back on later
  picks up right where things left off.

The first time Loombre opens a database you've pointed it at (and again
every time afterward), it checks which version of Stash produced it. Stash
has changed its own internal layout over the years, and Loombre only
understands a tested range of them. If your database falls outside that
range — usually because it's from a much older or a much newer Stash than
this version of Loombre has been tested against — Loombre doesn't try to
guess. It disables the connection and tells you exactly why, with a
message naming both the version it saw and the range it supports, for
example:

> Stash schema v58 unsupported; supported: 67–85

Nothing about your Stash database is affected by this — it's simply left
alone until either Stash or Loombre catches up to the other.

## Path mapping

Stash and Loombre don't always see your files at the same location. Stash
might know a scene as `/data/videos/clip.mp4` while Loombre, running
somewhere else or with a different set of folders attached, sees that same
file as `/media/collection/clip.mp4`. A **path mapping** tells Loombre how
to translate one into the other: a piece of the beginning of a Stash path,
and what it corresponds to on Loombre's side.

You can set up more than one mapping for a library — useful if only part
of your collection lives somewhere different. When more than one mapping
could apply to the same file, Loombre always uses the most specific
(longest) match, regardless of the order the mappings are listed in.

Before you commit to a mapping, Loombre can check it against what it
already knows about your Stash library and show you how many files it
would actually match — a running **"N of M matched"** count, plus a
sample of anything that wouldn't. This reflects Loombre's most recent look
at your Stash database, not a live check performed at that exact moment,
so it's most useful right after a sync or right after Loombre first
connects.

## What syncs, and who's in charge of what

Once a library is connected, Loombre brings across a scene's editorial
information: its title, release date, description, rating, studio,
performers, tags and genres, cover art, and any named chapter markers
Stash has recorded for it. For a performer, Loombre also keeps whatever
extra detail Stash has on file — known aliases, birth date, nationality,
and measurements, where available.

Two kinds of fact never come from Stash, on purpose: a scene's duration
and its picture quality. Those come from Loombre inspecting the actual
video file itself, the same as it does for every other library — Loombre
treats its own inspection as the authority on technical fact, and treats
Stash as the authority on editorial fact. If you've locked a field on an
item yourself, Stash's sync respects that lock exactly like every other
source does — a locked field is never overwritten.

## Keeping in sync

A first sync brings in everything at once. Even for a very large
collection, this is measured in minutes rather than hours, and it's
resumable — if it's ever interrupted partway through, picking back up
finds exactly where it left off instead of starting over. After that
first pass, an **incremental** sync only looks at what actually changed on
the Stash side since the last time, so a handful of edits in Stash stays a
handful of updates in Loombre, not a full re-scan.

A sync can start in three ways:

- **On demand** — you can trigger one yourself at any time, choosing a
  full or an incremental sync.
- **On a schedule** — an optional setting lets Loombre re-sync
  automatically at an interval you choose. It's off by default; Stash
  still syncs when you ask for it directly, or when its database file
  changes, regardless of this setting.
- **Automatically, on change** — Loombre notices when your Stash database
  file itself changes and, after things settle down, starts an
  incremental sync on its own.

While a sync is running, it shows up like any other background task on
the [Jobs dashboard](jobs-dashboard.md), so you can watch its progress or
confirm it finished the same way you would for a library scan.

## When something disappears from Stash

If a scene is removed from Stash, Loombre doesn't remove it. The matching
item stays in your library exactly as it was, but is marked **stale** —
Loombre's honest way of saying "this used to be backed by a Stash record,
and no longer is." Nothing about your watch history, your files, or the
item itself is touched. A stale item is never deleted on your behalf; if
you want it gone, that's your call to make.

## The sync report

Every library with a Stash connection keeps a running report of its most
recent sync: how many scenes matched, how many were updated, how many
couldn't be matched to anything, how many are stale, and how many were
left untouched because nothing about them had changed. Alongside those
counts, the report also lists which specific Stash scenes couldn't be
matched to a file, and which of your items have gone stale — so you're
never just told a number, you can see exactly what it refers to.
