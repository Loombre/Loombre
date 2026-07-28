What this installer does
=========================

Installs to:
  /opt/loombre/<version>       Node runtime, bundled ffmpeg + PostgreSQL,
                               server + worker + web UI
  /opt/loombre/current         symlink to the active version (upgrade swap point)
  /Applications/Loombre.app    menubar controller (status, start/stop, logs)
  /Library/Application Support/Loombre   app data (config, embedded-PG data
                               dir, local secrets)
  /Library/Logs/Loombre        server/worker/web .{out,err}.log
  /Library/LaunchDaemons/com.loombre.server.plist
  /Library/LaunchDaemons/com.loombre.worker.plist
  /Library/LaunchDaemons/com.loombre.web.plist
  /Library/LaunchAgents/com.loombre.menubar.plist   starts the menu bar
                               app at login (and right after this install)

Creates a dedicated, unprivileged system account (_loombre) that the
server, worker, and web UI run as — never root, never your login account.

After installation, the web UI is reachable at http://localhost:3000
(the API serves on port 3001). No database setup is required — the server
provisions its bundled PostgreSQL automatically on first boot. To use your
own PostgreSQL instead, or to reach the web UI from other devices on your
network, see /Library/Application Support/Loombre/config/loombre.env and
docs/install/macos.md for full configuration + first-run instructions.

Full layout rationale: installers/macos/LAYOUT.md in the Loombre source
repository.
