# Playback error codes

<!-- Sourcing: the codes come from three closed maps — the worker's ffmpeg
     failure classifier (packages/shared/src/ffmpeg-failure.ts, written to
     playback_sessions.error_code by apps/worker/src/transcode/runner.ts),
     the server's playback problem responses
     (apps/server/src/playback/*.exception.ts, hls-file.controller.ts), and
     the web player's client-side reasons (apps/web/src/lib/playback-reasons.ts,
     apps/web/src/lib/playback-recovery.ts). The plan-refusal reasons in the
     first table are docs/PLAYBACK.md §4's reason taxonomy, described here in
     outcome language. -->

When something can't play, Loombre shows a short **error code** together
with a one-line explanation and, when there is one, a detail line such as
the HTTP status or the name of the file segment that failed. The code is
the thing to quote when you ask your administrator for help or file a bug
report — use the **Copy details** button on the error screen and paste
what it copied.

Most of the time the fix is on the server side and your administrator can
see more in the server logs. **Try again** on the error screen restarts
playback from where you were.

## Codes you may see

### The server could not prepare the video

These come from the conversion (transcoding) pipeline on the server.

| Code | What it means | What to do |
|---|---|---|
| `transcode-input-missing` | The media file is no longer where the library expects it. | Check that the drive or folder is still mounted and the file still exists; rescan the library. |
| `transcode-input-unreadable` | The server found the file but couldn't read it (permissions, a damaged file, an I/O error). | Check read permissions for the Loombre service account and that the file plays elsewhere. |
| `transcode-decoder-unsupported` | The server's ffmpeg build can't decode this file's video or audio format. | Try another version of the title, or check the server's capability report in the admin area. |
| `transcode-encoder-init-failed` | The video encoder (hardware or software) failed to start. | Check the hardware self-test in the admin area; the server may need drivers or a restart. |
| `transcode-encoder-malfunction` | The hardware encoder kept dying mid-stream and the software fallback couldn't keep the session alive. | Retry; if it keeps happening the server machine needs attention. |
| `transcode-disk-full` | The server ran out of space in its conversion staging folder. | Free disk space (or move staging to a bigger disk) on the server. |
| `transcode-killed` | The conversion process was killed by the operating system, usually for running out of memory. | Retry; lower the quality ladder or the simultaneous-conversions setting if it recurs. |
| `transcode-failed` | The conversion stopped for a reason the server didn't recognise. | Retry; the detail line and the server logs have the specifics. |
| `evicted-for-admission` | Your session was closed to free the server for another viewer — it had been paused or idle for a while. | Press play to start again. |
| `heartbeat-timeout` | The server stopped hearing from this player and closed the session as idle. | Press play to start a fresh session. |
| `playback-session-ended` | The server closed the session — another device or tab took over, or an administrator ended it. | Press play to start a fresh session. |
| `playback-session-failed` | The server marked the session failed without recording a reason. | Retry; check the server logs. |
| `playback-session-create-failed` | The request to start playback never reached the server or came back with an unexpected error. | Check the connection and try again. |

### Playback was refused before it started

| Code | What it means | What to do |
|---|---|---|
| `media-unplayable` (HTTP 409) | The server worked out that this file cannot be played on this device — for example HDR that needs tone-mapping the server's policy forbids. The rows on the screen list the exact reasons. | Try a different version if one is offered, or ask your administrator about the policy. |
| `transcode-slots-exhausted` (HTTP 429) | Every conversion slot is in use and none could be reclaimed. | Wait a moment and try again; administrators can raise the simultaneous-conversions setting. |
| `item-unavailable` (HTTP 404) | The link didn't lead to anything playable — the item was removed or isn't available to your account. | Go back to browsing. |

### Something went wrong in your browser or on the network

| Code | What it means | What to do |
|---|---|---|
| `hls-network-error` | Video segments or the playlist stopped arriving (the detail shows the HTTP status and the segment). A 503 usually means the server was restarting the converter for a seek and didn't finish in time. | Retry; check the connection between this device and the server. |
| `hls-media-error` | The browser couldn't append or decode a segment it received. | Retry; if it recurs, try a different browser or quality level. |
| `hls-fatal-error` | The player hit an error it can't classify (the detail names it). | Retry; report the detail if it recurs. |
| `client-media-decode-error` | The browser's decoder rejected the stream. | Try another browser or device. |
| `client-media-src-not-supported` | The browser refused the stream format outright. | Try another browser or device. |
| `client-media-network-error` | The browser lost the stream mid-playback. | Retry; check the connection. |
| `client-media-aborted` | The browser aborted loading the stream. | Retry. |
| `playback-stalled` | Playback stopped advancing for ten seconds and the player could not recover. | Retry; check the connection and the server's load. |
| `seek-landing-timeout` | You seeked, the server was asked to restart conversion at the new position, and it didn't produce that position within 20 seconds. | Seek again; if it recurs the server is overloaded. |
| `seek-request-failed` | The seek request itself failed (the detail shows the HTTP status). | Check the connection and try again. |

## For administrators

Every failed conversion session keeps a sanitized one-line detail on the
API (`GET /playback/sessions/{id}` → `errorDetail`; the raw ffmpeg log is
never exposed to viewers) and the server logs carry the full context. See
[Why is this converting?](why-is-it-converting.md) for what triggers
conversion in the first place, and the
[settings reference](/admin-guide/settings-reference#maximum-simultaneous-conversions)
for the simultaneous-conversions setting.
