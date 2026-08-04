# Restarting or shutting down the server

**Settings → Server → Power** has two buttons, both admin-only, both
asking you to confirm first.

## Restart server

Stops and starts the server program. Use it when the settings screen shows
the amber "Restart required" banner — some settings are saved right away
but only take effect after a restart, and the banner lists which ones are
waiting. Restarting from here applies them.

What to expect:

- Anyone streaming is interrupted for a few seconds while the server comes
  back. Nothing is lost — players pick up where they left off.
- The page waits and tells you when the server is back online. A restart
  normally takes five to fifteen seconds; the very first start after an
  update can take longer.
- Only the server program restarts. Background work (scanning, converting)
  and this web app's own service keep running.

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
