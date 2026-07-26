// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray/Program.cs

namespace Loombre.Tray;

internal static class Program
{
    [STAThread]
    private static void Main()
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
