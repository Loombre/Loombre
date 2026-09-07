# loombre-tray — Linux system tray controller

The third platform controller, alongside `installers/windows/tray` (C#
NotifyIcon) and `installers/macos/menubar` (Swift NSStatusItem). It speaks the
frozen `@loombre/controller-ipc` contract (`packages/controller-ipc/src/*.ts`)
over loopback HTTP and offers the same menu the other two do.

Go module, no cgo. `fyne.io/systray`'s Linux backend is a pure-Go
StatusNotifierItem + `com.canonical.dbusmenu` implementation over `godbus`, so
the shipped binary is static and has no runtime library to go missing.

## Parity with the other controllers

| | Linux | macOS | Windows |
|---|---|---|---|
| Menu | status · Open Loombre · Start/Stop · Shut down · Reveal crash files · version · Quit | same | same |
| Start a stopped server | `systemctl start` (polkit prompt) | `launchctl` (admin prompt) | SCM (UAC prompt) |
| Stop a running server | `POST /ipc/v1/server/stop` | same | same |
| Full shutdown | `systemctl stop` worker, web, server | `launchctl bootout`, same order | `net stop`, same order |
| Shutdown confirmation | click item twice within 10s | NSAlert dialog | TaskDialog |
| Autostart | `/etc/xdg/autostart/loombre-tray.desktop` → `--autostart` | LaunchAgent | HKLM Run key |
| Launcher | `/usr/share/applications/loombre.desktop` → `--open-web` | `/Applications/Loombre.app` | Start Menu shortcut |
| Reveal crash files | `xdg-open` the directory | Finder, file selected | `explorer /select` |

`POST /ipc/v1/server/start` is never called: it is served by the server
process itself and always answers 409 (`IPC_SERVER_START_SEMANTICS`), which is
why starting goes through systemd on every platform.

## Discovery and the group requirement

The tray looks for `controller-ipc.json` in, in order: `$LOOMBRE_IPC_DIR` (when
set), `/run/loombre`, `/var/lib/loombre`. The first directory holding one wins;
`controller-ipc.token` beside it is the bearer token.

The server writes that token `0640` owned by its admin group. A user who is not
in that group gets `EACCES`, and the tray says so explicitly — status line,
plus one notification carrying the exact `sudo usermod -aG <group> <user>`
command — rather than reporting a healthy server as stopped. Group membership
takes effect at the next login.

## GNOME

Stock GNOME ships no StatusNotifierItem host, so the icon has nowhere to draw.
The tray checks for `org.kde.StatusNotifierWatcher` on the session bus for ~10s
and, if none appears, notifies once telling the user to install the
"AppIndicator and KStatusNotifierItem Support" extension. It keeps running;
`systray` re-registers by itself when a host shows up.

## Launch flags

- (none) — start the tray. A second launch does not start a second tray
  (`flock` on `$XDG_RUNTIME_DIR/loombre-tray.lock`); it opens the web UI and
  exits 0.
- `--autostart` — login autostart. Never opens a browser; exits 0 silently if a
  tray already runs.
- `--open-web` — open the web UI as soon as `/status` reports one, waiting up to
  120s, then falling back to `http://localhost:3000`. Wins over `--autostart`.
- `--version`, `--help`. Unknown arguments are ignored on purpose.

## Build and test

```sh
go test ./...          # runs on Linux and macOS; no D-Bus needed
go vet ./... && gofmt -l .
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X main.buildVersion=$(node -p 'require("../../../package.json").version')" \
  -o loombre-tray .
```

All decision logic — state derivation, the lifecycle table, launch modes, the
confirmation window, systemctl command building — lives in OS-independent
packages under `internal/`. Only the `_linux.go` files touch a tray, D-Bus,
`systemctl`, `xdg-open` or `notify-send`.

The IPC wire tests decode `installers/macos/menubar/fixtures.json`, the shared
canonical fixture values, so this client is proven to agree with the Swift and
C# ones field-for-field rather than only with itself.
