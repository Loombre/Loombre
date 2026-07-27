# Watching

<!-- Sourcing: resume/progress tracking — docs/PLAN.md §4.3 domain event
     outbox names "progress.updated" as a real event type; the playback
     reason taxonomy (packages/playback-engine/src/reasons.ts) includes
     subtitle-specific codes (subtitle-format-requires-burn-in,
     subtitle-styling-lost, subtitle-codec-unknown), confirming subtitle
     support is implemented, not aspirational. Restricted-content session
     unlock timing — docs/PLAN.md §6.4 gate 5 (default 30 minutes),
     linked rather than restated here. Supported file types (STATE.md H3) —
     apps/worker/src/scan/parse/path-utils.ts's VIDEO_EXTENSIONS/
     AUDIO_EXTENSIONS/EXCLUDED_MEDIA_EXTENSIONS; the full technical table
     lives in the Admin Guide's Libraries & scanning page instead of here,
     kept plain-language per the audience-register rules. -->

## Starting something

Select **Play** on any movie, episode, or track. If you've watched part of
it before, Loombre picks up right where you left off automatically — you
won't need to find your spot by hand.

[SCREENSHOT: Player screen, mid-playback, showing progress bar and controls]

## Player controls

The usual controls are there: play, pause, skip forward and back, and a
progress bar you can drag to jump to any point.

## Subtitles and audio

If subtitles are available for what you're watching, a subtitle button
lets you turn them on, turn them off, or choose a different language.
The same idea applies to audio — if more than one audio language or mix
is available, you can switch between them from the player.

[SCREENSHOT: Player subtitle and audio selection menu]

## Picking up on another device

Your progress is saved as you watch, so you can pause on one device and
resume on another — a TV in the living room, a laptop, a phone — without
losing your place.

## What kinds of files work

Loombre plays and organizes video and audio files. Most everyday file
types work, including a lot of older ones — files ending in .wmv, .mpg,
or .flv, camcorder files ending in .m2ts or .mts, and audio files ending
in .aac or .aiff, all just work alongside the more common ones.

Some older or uncommon file types aren't supported yet — for example
files ending in .ape, .wv, or .wma. If a folder you pointed Loombre at
has files like that, they're never added incorrectly and never dropped
without a trace — whoever administers your Loombre can see exactly which
files were left out and why (see the [Admin Guide](../admin-guide/libraries.md)).

Occasionally a file that looks like it should work turns out not to be
playable video or audio at all — a corrupted download, or a file that
somehow got renamed to look like one. A file like that can still show up
in your library at first (Loombre finds out it's unreadable only after
taking a closer look), but it won't play — and it's flagged for your
administrator to look into, the same way an unsupported file type is.

## When something won't play smoothly

If a video looks a little softer than usual, or takes a moment to start,
see [Why is this converting?](why-is-it-converting.md) — Loombre
is doing some extra work behind the scenes to make sure it plays properly
on your device.

## Restricted content

If you try to open something and you're asked for a PIN, see
[Restricted content](restricted-content.md).
