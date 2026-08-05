# Restarting or shutting down the server

**Settings → Server → Power** has two buttons, both admin-only, both
asking you to confirm first.

## Restart server

Stops and starts the server program. Everything on the settings screens
applies immediately when you save — no restart needed. This button is for
what happens *outside* those screens: applying changes made where Loombre
is installed (ports, folders, and similar — the settings screen shows
those as controlled by the environment), finishing an update, or plain
troubleshooting.

What to expect:

- Anyone streaming is interrupted for a few seconds while the server comes
  back. Nothing is lost — players pick up where they left off.
- The page waits and tells you when the server is back online. A restart
  normally takes five to fifteen seconds; the very first start after an
  update can take longer.
- Only the server program restarts. Background work (scanning, converting)
  and this web app's own service keep running.

Want to warn everyone first? Publish a
[system notice](system-notices.md) with a countdown, then restart when
it reaches zero.

## Shut down server

Stops the server and leaves it stopped. Streaming stops for every device,
and this web app stops working until the server is started again — the
shutdown screen stays up to tell you exactly that before it goes.

Starting it again happens outside this web app (the web app talks to the
very server that was just stopped):

- **macOS** — click the Loombre menu bar icon and choose **Start Loombre**.
- **Windows** — right-click the Loombre tray icon and choose **Start
  Loombre**.
- **Linux, or no icon available** — ask whoever installed Loombre; they
  can start the service the same way it was set up (see the install guide
  for your platform), and a computer restart also brings everything back
  automatically.

**Running Loombre in Docker?** The shut-down button politely refuses and
explains why: Docker is set up to bring the server right back whenever it
stops, so a real shutdown has to be done where Docker runs
(`docker compose stop` — see the
[Docker install guide](../install/docker.md#stopping--shutting-down-completely)).
The restart button works normally.

## What these buttons are not

Neither button turns the whole Loombre installation off the way the menu
bar / tray "Shut Down Loombre" does — that stops the background worker and
this web app too. These buttons manage the server program only, from
inside the web app, for the everyday cases: applying restart-required
settings and stopping the catalog/streaming side of Loombre without
touching the rest.
