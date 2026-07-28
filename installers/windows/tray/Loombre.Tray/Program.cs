// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray/Program.cs

using System.Threading;

namespace Loombre.Tray;

internal static class Program
{
    /// <summary>Per-session single-instance guard.
    ///
    /// The v0.9.0-rc.1 field report showed TWO Loombre.Tray.exe processes
    /// running at once on a real machine — two identical icons, two poll
    /// loops against the IPC listener, and a "quit" that only closes one of
    /// them. There are now three ways the tray can start (the Start Menu
    /// shortcut, the HKLM Run key at logon, and ca.LaunchTray at the end of
    /// an install), so duplicates are the expected case, not an accident.
    ///
    /// "Local\" prefix, NOT "Global\": the tray is per-user, per-session by
    /// design (Services.wxs deliberately does not run it as LocalSystem).
    /// A Global mutex would let the FIRST user to log in block every other
    /// account's tray on a shared machine — including the fast-user-switch
    /// case where two sessions are legitimately live at once.
    ///
    /// initiallyOwned:false + WaitOne(0): asking for the mutex without
    /// blocking. Owning it means we are the first; failing means another
    /// instance in this session already has it and we exit quietly (exit 0
    /// — being second is a normal outcome, not an error worth a dialog or
    /// a WER report).</summary>
    private const string SingleInstanceMutexName = "Local\\Loombre.Tray.SingleInstance";

    [STAThread]
    private static void Main()
    {
        using var singleInstance = new Mutex(initiallyOwned: false, name: SingleInstanceMutexName);
        bool isFirstInstance;
        try
        {
            isFirstInstance = singleInstance.WaitOne(TimeSpan.Zero, exitContext: false);
        }
        catch (AbandonedMutexException)
        {
            // The previous owner died without releasing (killed, crashed,
            // or logged off mid-run). The mutex is ours now and the tray it
            // belonged to is gone — carry on as the live instance.
            isFirstInstance = true;
        }

        if (!isFirstInstance)
        {
            return;
        }

        try
        {
            RunTray();
        }
        finally
        {
            singleInstance.ReleaseMutex();
        }
    }

    private static void RunTray()
    {
        // Classic manual setup (not the source-generated
        // ApplicationConfiguration.Initialize()) — deliberately, since that
        // generator's activation depends on exact SDK/project-property
        // wiring this lane cannot verify by compiling on this host (no
        // Windows/dotnet — see the I3 report). This sequence has been
        // correct across every .NET / .NET Framework WinForms version.
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayApplicationContext());
    }
}
