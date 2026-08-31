# Sessions

<!-- Sourcing: the Sessions screen (row shape: username, item title or
     "content hidden" chip, status pill, device, started, heartbeat;
     expandable per-row reasons view; live refresh; "Load more" paging) —
     apps/web/src/app/admin/sessions/page.tsx header comment. Reasons view
     (decision, per-reason plain-language copy + underlying code, bitrate
     ladder, "No reasons reported — direct play"; restricted-plan
     redaction) — apps/web/src/components/admin/ReasonsPanel.tsx. Status
     pill vocabulary ("Buffered ahead" vs "No heartbeat" split of the one
     suspended state) — apps/web/src/lib/admin-session-presence.ts. -->

The **Sessions** screen (in the admin sidebar) shows everyone playing
something on your Loombre right now — and, for each stream, *why* it's
playing the way it is.

## The list

Each row shows who's watching, what they're watching, the device, when the
stream started, when Loombre last heard from it, and a status: playing,
paused, **Buffered ahead** (the stream is healthy and has simply converted
far enough ahead to rest), or **No heartbeat** (nothing has been heard
from that player for a while). The list keeps itself up to date on its
own — you don't need to reload the page.

[SCREENSHOT: Sessions screen showing several active streams]

## Why is this converting?

Select a row to expand it. You'll see the playback decision Loombre made
for that stream — playing the file directly, or converting it — and, if
it's converting, the full list of reasons in plain language, each with the
short reason code underneath (useful when comparing notes or reporting a
problem), plus the quality ladder being offered. A stream playing
directly says so plainly: nothing to explain.

This is the admin-side view of the same message users see as
"[Why is this converting?](../user-guide/why-is-it-converting.md)". The
[Capability report](capability-report.md) tells you what this machine
*can* do; this screen tells you what each stream is actually doing, and
why.

## Restricted sessions

A session playing restricted content never disappears from this list —
who's streaming, on what device, and its status are always visible. But
the item's title and its playback details stay hidden behind a "content
hidden" chip unless you're cleared for that content and currently
unlocked (see [Restricted content](../user-guide/restricted-content.md)).
