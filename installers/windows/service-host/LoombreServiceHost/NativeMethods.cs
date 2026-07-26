// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost/NativeMethods.cs
//
// The Win32 console-control-signal P/Invoke surface LoombreHostedService
// uses to ask its child process to shut down gracefully. See that file's
// header for the full mechanism and why AttachConsole/FreeConsole
// bracket the actual GenerateConsoleCtrlEvent call.
//
// UNTESTED ON REAL WINDOWS as of this build (no Windows host in this lane —
// see the I3 report's validation-ceiling section). This is exactly the
// kind of obscure-but-load-bearing Win32 sequencing that belongs on the
// Wave 3 Windows VM smoke checklist, not assumed correct from source
// reading alone.

using System.Runtime.InteropServices;

namespace Loombre.ServiceHost;

internal static class NativeMethods
{
    internal const uint CTRL_BREAK_EVENT = 1;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);

    internal delegate bool ConsoleCtrlDelegate(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate? handlerRoutine, [MarshalAs(UnmanagedType.Bool)] bool add);
}
