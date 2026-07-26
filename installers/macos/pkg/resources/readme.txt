What this installer does
=========================

Installs to:
  /opt/loombre/<version>       Node runtime, bundled ffmpeg, server + worker
  /opt/loombre/current         symlink to the active version (upgrade swap point)
  /Applications/Loombre.app    menubar controller (status, start/stop, logs)
  /Library/Application Support/Loombre   app data (config, embedded-PG data
                               dir once bundled, local secrets)
  /Library/Logs/Loombre        server.{out,err}.log, worker.{out,err}.log
  /Library/LaunchDaemons/com.loombre.server.plist
  /Library/LaunchDaemons/com.loombre.worker.plist

Creates a dedicated, unprivileged system account (_loombre) that the server
and worker run as — never root, never your login account.

After installation, the web UI is reachable at http://localhost:3001 once
you point the server at a PostgreSQL database — see
/Library/Application Support/Loombre/config/loombre.env and
docs/install/macos.md for full configuration + first-run instructions.

Full layout rationale: installers/macos/LAYOUT.md in the Loombre source
repository.
