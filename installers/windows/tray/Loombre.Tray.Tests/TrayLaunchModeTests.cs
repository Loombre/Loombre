// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Tests/TrayLaunchModeTests.cs
//
// The three launch paths carry three different intents, and the rc field
// report ("nothing happens ... I open the app via the start menu") is what
// happens when they are indistinguishable:
//
//   Start Menu shortcut  -> no flags      -> Interactive: surface the web UI
//   HKLM Run key (logon) -> --autostart   -> silent tray icon only
//   installer completion -> --open-web    -> wait for readiness, open browser
//
// Shortcuts.wxs (Run key) and Bundle.wxs (LaunchTarget) pass these flags;
// these tests pin the parse so a flag typo there degrades loudly here.

using Loombre.Tray.Ipc;
using Xunit;

namespace Loombre.Tray.Tests;

public sealed class TrayLaunchModeTests
{
    [Fact]
    public void No_arguments_is_interactive()
    {
        Assert.Equal(TrayLaunchMode.Interactive, TrayLaunchModes.Parse([]));
    }

    [Fact]
    public void Autostart_flag_is_autostart()
    {
        Assert.Equal(TrayLaunchMode.Autostart, TrayLaunchModes.Parse(["--autostart"]));
    }

    [Fact]
    public void Open_web_flag_is_open_web()
    {
        Assert.Equal(TrayLaunchMode.OpenWeb, TrayLaunchModes.Parse(["--open-web"]));
    }

    [Fact]
    public void Open_web_wins_over_autostart_when_both_are_present()
    {
        // Both flags means an explicit open-web request reached an exe
        // whose registration also carries --autostart; the explicit intent
        // to SEE the app wins.
        Assert.Equal(TrayLaunchMode.OpenWeb, TrayLaunchModes.Parse(["--autostart", "--open-web"]));
    }

    [Fact]
    public void Flags_are_case_insensitive()
    {
        Assert.Equal(TrayLaunchMode.Autostart, TrayLaunchModes.Parse(["--AutoStart"]));
        Assert.Equal(TrayLaunchMode.OpenWeb, TrayLaunchModes.Parse(["--Open-Web"]));
    }

    [Fact]
    public void Unknown_arguments_are_ignored()
    {
        Assert.Equal(TrayLaunchMode.Interactive, TrayLaunchModes.Parse(["--future-flag", "value"]));
        Assert.Equal(TrayLaunchMode.Autostart, TrayLaunchModes.Parse(["--future-flag", "--autostart"]));
    }
}
