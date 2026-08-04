# System notices

**Settings → Notices** lets you show a message to everyone using your
Loombre, right now — a heads-up before a restart, a maintenance window,
or anything else worth announcing. The message appears live in every
open Loombre screen, including over full-screen playback, and anyone
who signs in while it's up sees it too.

## Composing a notice

Pick a preset or write your own:

- **Restart in 5 / 15 / 30 minutes** — fills in a ready-made message
  with a live countdown everyone sees ("… in 4:32"), marked critical
  so nobody can miss it. The notice clears itself shortly after the
  restart window passes.
- **Maintenance** — a warning-level notice for a window you describe
  yourself. You choose when it stops showing.
- **Custom** — start from a blank message.

Three levels decide how the message shows up:

| Level | How people see it |
|---|---|
| Info | A small passing message that disappears on its own. |
| Warning | A banner at the top of every page. People can dismiss it, but it returns the next time they open Loombre while the notice is still up. |
| Critical | A banner that stays. No dismiss button until the notice ends. |

Every notice stops showing eventually: info after an hour unless you
say otherwise, warnings at the end time you set (they always need
one), and critical notices when you cancel them — or at an end time,
if you choose to set one.

## The countdown does not restart anything

A restart notice is a message, nothing more. When the countdown hits
zero the banner switches to a "restarting now" state — but the actual
restart is still yours to do, from
[Settings → Server → Power](server-power.md). The usual order: publish
the notice, wait out the countdown, then press the Restart button.

## One notice at a time

There is only ever one active notice. Publishing a new one replaces
the current one everywhere — the compose screen asks you to confirm
the swap first. **Cancel** on the active notice takes it down
immediately for everyone.

## Write for every reader

Notices go to **every user on your server**. Never mention
restricted-zone titles, names, or anything personal — the banner does
not know who is looking at it. Keep it to what people need: what is
happening, and when.

## History

The Notices screen keeps a list of past notices — what was sent, by
whom and when, and whether it ran out or was cancelled — so you can
check what people were told.
