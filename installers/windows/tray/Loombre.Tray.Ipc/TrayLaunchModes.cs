// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Ipc/TrayLaunchModes.cs
//
// Launch-intent parsing for the tray exe's three registered launch paths
// (pinned by Loombre.Tray.Tests/TrayLaunchModeTests.cs — the flags are
// authored in Shortcuts.wxs and Bundle.wxs, so a typo THERE fails a test
// HERE):
//
//   (no flags)    Start Menu shortcut — the user asked to see the app:
//                 surface the web UI (open the browser when the server is
//                 reachable, otherwise say what's going on).
//   --autostart   HKLM Run key at logon — background chrome only, never
//                 open a browser at the user uninvited.
//   --open-web    Installer completion ("Launch" on the bundle's success
//                 page, ca.LaunchTray on interactive MSI installs) — wait
//                 out the server's first boot, then open the browser; on a
//                 fresh install that lands on the /setup wizard.

namespace Loombre.Tray.Ipc;

public enum TrayLaunchMode
{
    Interactive,
    Autostart,
    OpenWeb,
}

public static class TrayLaunchModes
{
    public const string AutostartFlag = "--autostart";
    public const string OpenWebFlag = "--open-web";

    public static TrayLaunchMode Parse(IReadOnlyList<string> args)
    {
        var autostart = false;
        var openWeb = false;
        foreach (var arg in args)
        {
            if (string.Equals(arg, AutostartFlag, StringComparison.OrdinalIgnoreCase))
            {
                autostart = true;
            }
            else if (string.Equals(arg, OpenWebFlag, StringComparison.OrdinalIgnoreCase))
            {
                openWeb = true;
            }
            // Unknown args are ignored, deliberately: an older tray exe
            // launched by a newer installer's flag must degrade to a
            // normal launch, not crash or dialog.
        }
        // An explicit open-web request wins even if the invoking
        // registration also carries --autostart.
        if (openWeb)
        {
            return TrayLaunchMode.OpenWeb;
        }
        return autostart ? TrayLaunchMode.Autostart : TrayLaunchMode.Interactive;
    }
}
