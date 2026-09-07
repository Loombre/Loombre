// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/launch.go
//
// Launch-intent parsing for the tray binary's registered launch paths — a
// port of the Windows tray's TrayLaunchModes. The flags are authored in
// the desktop files the packages install, so a typo THERE fails a test
// HERE:
//
//	(no flags)    manual run: put the tray up, nothing else.
//	--autostart   /etc/xdg/autostart/loombre-tray.desktop at login —
//	              background chrome only, never open a browser at someone
//	              uninvited.
//	--open-web    /usr/share/applications/loombre.desktop and the
//	              installer's completion step: the user asked to SEE
//	              Loombre, so wait out the server's first boot and open the
//	              web UI.
//
// Unlike the Windows port these compare case-sensitively: Linux command
// line flags are case-sensitive by convention, and the only things passing
// them are desktop files in this repo.

package control

// LaunchMode is the parsed intent.
type LaunchMode int

const (
	ModeInteractive LaunchMode = iota
	ModeAutostart
	ModeOpenWeb
)

func (m LaunchMode) String() string {
	switch m {
	case ModeAutostart:
		return "autostart"
	case ModeOpenWeb:
		return "open-web"
	default:
		return "interactive"
	}
}

// Flags this binary recognises.
const (
	FlagAutostart = "--autostart"
	FlagOpenWeb   = "--open-web"
	FlagVersion   = "--version"
	FlagHelp      = "--help"
)

// Launch is what the command line asked for.
type Launch struct {
	Mode        LaunchMode
	ShowVersion bool
	ShowHelp    bool
}

// ParseLaunch reads the argument list. Unknown arguments are ignored,
// deliberately: an older tray binary launched by a newer package's desktop
// file must degrade to a normal launch, not exit with a usage error at
// login.
func ParseLaunch(args []string) Launch {
	var launch Launch
	var autostart, openWeb bool
	for _, arg := range args {
		switch arg {
		case FlagAutostart:
			autostart = true
		case FlagOpenWeb:
			openWeb = true
		case FlagVersion, "-v":
			launch.ShowVersion = true
		case FlagHelp, "-h":
			launch.ShowHelp = true
		}
	}
	switch {
	case openWeb:
		// An explicit request to surface the UI wins even when the
		// invoking registration also carries --autostart.
		launch.Mode = ModeOpenWeb
	case autostart:
		launch.Mode = ModeAutostart
	default:
		launch.Mode = ModeInteractive
	}
	return launch
}

// UsageText is what --help prints.
const UsageText = `loombre-tray — Loombre system tray controller

Usage:
  loombre-tray [flags]

Flags:
  --autostart   Login autostart: show the tray, never open a browser.
  --open-web    Show the tray and open the Loombre web interface once the
                server reports one (waits up to 120s, then falls back to
                ` + InstalledDefaultWebURL + `).
  --version     Print the version and exit.
  --help        Print this help and exit.

With no flags the tray starts and stays in the notification area. A second
launch does not start a second tray: it opens the web interface instead.

Environment:
  LOOMBRE_IPC_DIR   Directory holding controller-ipc.json and
                    controller-ipc.token. Searched before /run/loombre and
                    /var/lib/loombre.
`
