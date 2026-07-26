# Why is this converting?

<!-- Sourcing: the decision to convert is driven by a closed set of reasons
     (device support, network conditions, subtitle/audio handling, policy) —
     packages/playback-engine/src/reasons.ts (BlockingReasonCode union:
     device/format mismatch, network conditions, subtitle burn-in, etc.) and
     docs/PLAYBACK.md §3 "The decision algorithm". Quality-level selection
     when converting — docs/PLAYBACK.md §7 "Bitrate ladder" (several quality
     levels chosen automatically), described here in outcome language only. -->

Sometimes, when you press play, you'll see a message that Loombre is
preparing your video before it starts, or the picture looks a little
softer than you expected. Here's what's happening and why.

## What's going on

Every device — a TV, a phone, a laptop, a streaming box — can only play
certain kinds of video and audio directly. When the movie or show you
picked isn't in a form your device can play on its own, **Loombre converts
it on the fly** so it plays correctly instead of failing or looking wrong.

This isn't a bug and it isn't something you need to fix. It's Loombre
doing extra work automatically, in the background, so playback just
works.

## Why this happens

A few common reasons:

- **Your device doesn't support the video's original format.** Some
  devices are pickier than others about what they can play directly.
  Loombre checks and converts only when it needs to.
- **Your network connection is slower than the video needs.** If you're
  watching over a slow connection — especially away from home — Loombre
  may lower the picture quality automatically so playback keeps up
  without constant pausing to catch up.
- **Subtitles need to be drawn directly onto the picture.** Some subtitle
  styles can only be shown this way, which requires converting the video.
- **Whoever administers your Loombre has chosen settings** that affect how
  videos are sent to certain devices or networks.

## What to expect

- **Picture quality may be slightly lower** than the original file, and a
  few seconds may pass before playback starts, while Loombre prepares the
  first bit of video.
- **This is automatic** — you don't need to change any settings for it to
  work correctly.
- **It only happens when needed.** If your device can already play a file
  directly, Loombre sends it as-is, at full quality, with no delay.

## Still looks wrong, or won't play at all?

If playback fails outright, or quality seems unexpectedly poor even on a
fast connection, let whoever administers your Loombre know — they have
tools to see exactly why a particular decision was made (see the
[Admin Guide](../admin-guide/index.md)) and can adjust settings that affect it.
