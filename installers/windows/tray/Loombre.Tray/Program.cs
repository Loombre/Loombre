// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray/Program.cs

using System.Threading;
using Loombre.Tray.Ipc;

namespace Loombre.Tray;

internal static class Program
{
    /// <summary>Per-session single-instance guard.
    ///
    /// The v0.9.0-rc.1 field report showed TWO Loombre.Tray.exe processes
    /// running at once on a real machine — two identical icons, two poll
    /// loops against the IPC listener, and a "quit" that only closes one of
    /// them. There are now three ways the tray can start (the Start Menu
    /// shortcut, the HKLM Run key at logon, and the installer's completion
    /// launch), so duplicates are the expected case, not an accident.
    ///
    /// "Local\" prefix, NOT "Global\": the tray is per-user, per-session by
    /// design (Services.wxs deliberately does not run it as LocalSystem).
    /// A Global mutex would let the FIRST user to log in block every other
    /// account's tray on a shared machine — including the fast-user-switch
    /// case where two sessions are legitimately live at once.
    ///
    /// initiallyOwned:false + WaitOne(0): asking for the mutex without
    /// blocking. Owning it means we are the first; failing means another
    /// instance in this session already has it — exit 0, being second is a
    /// normal outcome. But NOT a silent one anymore: the next rc field
    /// report was "nothing happens ... I open the app via the start menu",
    /// which is exactly a second interactive launch hitting this guard.
    /// A second INTERACTIVE launch now signals the live instance (the
    /// event below) to surface the web UI before exiting.</summary>
    private const string SingleInstanceMutexName = "Local\\Loombre.Tray.SingleInstance";

    /// <summary>Auto-reset event the live instance listens on
    /// (TrayApplicationContext registers a wait). A second interactive
    /// launch Set()s it — "the user just asked to see Loombre" — and the
    /// live instance runs its surface-the-web-UI flow. Same "Local\"
    /// per-session scoping rationale as the mutex.</summary>
    internal const string OpenWebSignalName = "Local\\Loombre.Tray.OpenWebSignal";

    [STAThread]
    private static void Main(string[] args)
    {
        var launchMode = TrayLaunchModes.Parse(args);

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
            if (launchMode != TrayLaunchMode.Autostart)
            {
                SignalLiveInstanceToOpenWeb();
            }
            return;
        }

        // Created (not opened) by the owning instance, before the message
        // loop starts, so a racing second launch can never miss it.
        using var openWebSignal = new EventWaitHandle(
            initialState: false, EventResetMode.AutoReset, OpenWebSignalName);

        try
        {
            RunTray(launchMode, openWebSignal);
        }
        finally
        {
            singleInstance.ReleaseMutex();
        }
    }

    private static void SignalLiveInstanceToOpenWeb()
    {
        try
        {
            using var signal = EventWaitHandle.OpenExisting(OpenWebSignalName);
            signal.Set();
        }
        catch (Exception ex) when (ex is WaitHandleCannotBeOpenedException or UnauthorizedAccessException or IOException)
        {
            // The live instance is mid-startup (owns the mutex, hasn't
            // created the event yet) or the handle is inaccessible —
            // nothing worth a dialog; the user still has the live tray.
        }
    }

    private static void RunTray(TrayLaunchMode launchMode, EventWaitHandle openWebSignal)
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
        Application.Run(new TrayApplicationContext(launchMode, openWebSignal));
    }
}
