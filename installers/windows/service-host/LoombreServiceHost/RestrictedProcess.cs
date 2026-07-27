// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost/RestrictedProcess.cs
//
// Launches a child process under a RESTRICTED copy of this process's token
// with the Administrators (and Power Users) group SIDs DISABLED — the same
// technique PostgreSQL's own pg_ctl/initdb use to self-drop privileges on
// Windows. WHY (installer completeness audit, gap 3): both Loombre services
// run as LocalSystem, whose token is admin-privileged; the server's child
// (node.exe) supervises an embedded postgres.exe via a DIRECT spawn
// (packages/provisioning-pg deliberately never uses `pg_ctl start` — it
// daemonizes and loses the child handle), and postgres.exe hard-refuses to
// run from an admin token ("Execution of PostgreSQL by a user with
// administrative permissions is not permitted"). Dropping admin at the
// NODE spawn means everything below it — node, postgres, ffmpeg — runs
// restricted, while supervisor code stays platform-agnostic.
//
// What survives the restriction (why media access is not lost): the token
// USER stays SYSTEM (S-1-5-18), so ACEs granting SYSTEM still apply —
// which covers user-profile media folders and Windows defaults.
// Administrators-granted ACEs become deny-only. This is a per-child
// choice (ServiceOptions.SpawnRestricted): Services.wxs sets it for
// LoombreServer; the worker keeps a plain spawn.
//
// Interop shape: CreateRestrictedToken + CreateProcessAsUser with
// anonymous-pipe stdout/stderr. The caller gets back a
// System.Diagnostics.Process (from the PID) for exit supervision +
// Kill(entireProcessTree), and two StreamReaders for the pipes — the same
// surface LoombreHostedService already programs against.

using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Loombre.ServiceHost;

internal static class RestrictedProcess
{
    internal sealed record Started(Process Process, StreamReader Stdout, StreamReader Stderr);

    private const uint TOKEN_ALL_ACCESS = 0xF01FF;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int STARTF_USESTDHANDLES = 0x00000100;

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(
        IntPtr existingTokenHandle,
        uint flags,
        uint disableSidCount,
        SID_AND_ATTRIBUTES[]? sidsToDisable,
        uint deletePrivilegeCount,
        IntPtr privilegesToDelete,
        uint restrictedSidCount,
        IntPtr sidsToRestrict,
        out IntPtr newTokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(
        IntPtr tokenHandle,
        string? applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>
    /// Spawns <paramref name="psi"/>'s FileName/ArgumentList/WorkingDirectory/
    /// Environment as a restricted-token child with redirected stdout/stderr.
    /// Only ProcessStartInfo fields listed above are honored.
    /// </summary>
    internal static Started Start(ProcessStartInfo psi)
    {
        var disable = new[]
        {
            WellKnownSidToNative(WellKnownSidType.BuiltinAdministratorsSid),
            WellKnownSidToNative(WellKnownSidType.BuiltinPowerUsersSid),
        };

        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TOKEN_ALL_ACCESS, out var ownToken))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed");
        }
        IntPtr restrictedToken = IntPtr.Zero;
        try
        {
            if (!CreateRestrictedToken(ownToken, 0, (uint)disable.Length, disable, 0, IntPtr.Zero, 0, IntPtr.Zero, out restrictedToken))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateRestrictedToken failed");
            }

            // Inheritable write ends for the child; we read the server ends.
            var stdoutPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            var stderrPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);

            var startupInfo = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                dwFlags = STARTF_USESTDHANDLES,
                hStdInput = IntPtr.Zero,
                hStdOutput = stdoutPipe.ClientSafePipeHandle.DangerousGetHandle(),
                hStdError = stderrPipe.ClientSafePipeHandle.DangerousGetHandle(),
            };

            var commandLine = new StringBuilder(WindowsCommandLine.Build(psi.FileName, psi.ArgumentList));
            var environmentBlock = BuildEnvironmentBlock(psi);
            var environmentPtr = Marshal.StringToHGlobalUni(environmentBlock);
            try
            {
                if (!CreateProcessAsUser(
                        restrictedToken,
                        null,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        inheritHandles: true,
                        CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                        environmentPtr,
                        string.IsNullOrEmpty(psi.WorkingDirectory) ? null : psi.WorkingDirectory,
                        ref startupInfo,
                        out var processInformation))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), $"CreateProcessAsUser failed for '{psi.FileName}'");
                }
                CloseHandle(processInformation.hThread);
                CloseHandle(processInformation.hProcess);

                // The child now owns duplicated ends; release ours so EOF
                // propagates when the child exits.
                stdoutPipe.DisposeLocalCopyOfClientHandle();
                stderrPipe.DisposeLocalCopyOfClientHandle();

                var process = Process.GetProcessById(processInformation.dwProcessId);
                return new Started(
                    process,
                    new StreamReader(stdoutPipe, Encoding.UTF8),
                    new StreamReader(stderrPipe, Encoding.UTF8));
            }
            finally
            {
                Marshal.FreeHGlobal(environmentPtr);
            }
        }
        finally
        {
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            CloseHandle(ownToken);
        }
    }

    private static SID_AND_ATTRIBUTES WellKnownSidToNative(WellKnownSidType type)
    {
        var sid = new SecurityIdentifier(type, null);
        var bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        var native = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, native, bytes.Length);
        // Deliberately never freed: two tiny allocations for the process
        // lifetime, made once per spawn.
        return new SID_AND_ATTRIBUTES { Sid = native, Attributes = 0 };
    }

    private static string BuildEnvironmentBlock(ProcessStartInfo psi)
    {
        // psi.Environment starts pre-populated with this process's own
        // environment, plus whatever the caller added — sorted, unicode,
        // double-NUL-terminated per CreateProcess's contract.
        var entries = psi.Environment
            .Where(kv => kv.Value is not null)
            .OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
            .Select(kv => $"{kv.Key}={kv.Value}");
        return string.Join('\0', entries) + "\0\0";
    }
}
