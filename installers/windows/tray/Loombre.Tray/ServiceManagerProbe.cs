// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray/ServiceManagerProbe.cs
//
// The tray's window onto the Service Control Manager: a status snapshot
// for ServerControl.Decide, and the start path for a stopped server —
// IPC_SERVER_START_SEMANTICS' sanctioned mechanism (the IPC start
// endpoint is hosted BY the server and can never start a stopped one).
//
// PERMISSIONS: querying status needs SERVICE_QUERY_STATUS, which the SCM
// grants interactive users by default. STARTING needs SERVICE_START,
// which it does NOT — Services.wxs therefore grants BUILTIN\Users
// ServiceStart on the three Loombre services (util:PermissionEx), the
// same trust boundary the owner already accepted for the IPC token file
// (any local user may drive status/start/stop — STATE.md owner-review
// item). On an install predating that grant, StartServerStack throws
// access-denied and the caller falls back to a UAC-elevated `sc start`.
//
// Lives in the WinForms project, not Loombre.Tray.Ipc, deliberately:
// System.ServiceProcess is Windows-only, and the Ipc project's plain
// net8.0 testability on any OS is load-bearing (its csproj header).

using System.ComponentModel;
using System.Diagnostics;
using System.ServiceProcess;
using Loombre.Tray.Ipc;

namespace Loombre.Tray;

internal static class ServiceManagerProbe
{
    internal const string ServerServiceName = ServiceStack.ServerServiceName;

    private const int ErrorAccessDenied = 5;
    private const int ErrorCancelled = 1223; // user declined the UAC prompt
    private const int ErrorServiceDoesNotExist = 1060;

    internal static ScmSnapshot? Query()
    {
        try
        {
            using var controller = new ServiceController(ServerServiceName);
            return new ScmSnapshot(true, Map(controller.Status));
        }
        catch (InvalidOperationException ex)
            when ((ex.InnerException as Win32Exception)?.NativeErrorCode == ErrorServiceDoesNotExist)
        {
            return new ScmSnapshot(false, ScmStates.Other);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            // SCM unreachable or query denied — no answer, distinct from
            // "answered: not installed" above (ServerControl disables the
            // Start item for both, but the distinction keeps this honest).
            return null;
        }
    }

    /// <summary>Starts every stopped service in the stack, server first.
    /// Throws (typically InvalidOperationException wrapping an
    /// access-denied Win32Exception) only for the server itself — the
    /// downstream two are best-effort.</summary>
    internal static void StartServerStack()
    {
        foreach (var name in ServiceStack.StartOrder)
        {
            try
            {
                using var controller = new ServiceController(name);
                var status = controller.Status;
                if (status == ServiceControllerStatus.Stopped || status == ServiceControllerStatus.Paused)
                {
                    controller.Start();
                }
            }
            catch (Exception ex)
                when (name != ServerServiceName && ex is InvalidOperationException or Win32Exception)
            {
                // Worker/web best-effort: they are auto-start services
                // that usually never stopped; a failure here must not
                // mask a successful server start.
            }
        }
    }

    internal static bool IsAccessDenied(Exception ex) =>
        (ex as Win32Exception ?? ex.InnerException as Win32Exception)?.NativeErrorCode == ErrorAccessDenied;

    /// <summary>UAC fallback for installs whose services predate the
    /// Services.wxs ServiceStart grant. Returns false if the user
    /// declined the elevation prompt — a normal outcome, not an error.</summary>
    internal static bool TryStartServerStackElevated()
    {
        // Window hidden — the tray's balloon + poll loop are the
        // user-visible feedback. Command shape pinned by ServiceStackTests.
        var startInfo = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = ServiceStack.ElevatedStartArguments,
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        try
        {
            using var process = Process.Start(startInfo);
            return true;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == ErrorCancelled)
        {
            return false;
        }
    }

    /// <summary>UAC-elevated full-stack stop — the "Shut down Loombre…"
    /// path. ALWAYS elevated: Services.wxs deliberately grants Users
    /// ServiceQueryStatus + ServiceStart but NOT ServiceStop (its own
    /// comment: unelevated stop stays an IPC-only, in-band graceful
    /// shutdown of the server alone), so a whole-stack stop is an admin
    /// operation by design — the same posture as the macOS controller's
    /// admin-prompted `launchctl bootout`. Blocks until the elevated
    /// process exits (`net stop` waits per service — ServiceStack's
    /// doc), bounded so a wedged service can't hang the caller forever.
    /// Returns false if the user declined the elevation prompt — a
    /// normal outcome, not an error.</summary>
    internal static bool TryStopServerStackElevated()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = ServiceStack.ElevatedStopArguments,
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        try
        {
            using var process = Process.Start(startInfo);
            process?.WaitForExit(120_000);
            return true;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == ErrorCancelled)
        {
            return false;
        }
    }

    /// <summary>Post-shutdown verification: true when every stack service
    /// reports Stopped or is not installed. Anything else — still
    /// running, a pending transition, or an SCM query failure — is
    /// "cannot confirm stopped", so the caller reports instead of
    /// silently exiting over services that may still be up.</summary>
    internal static bool AllStackServicesStopped()
    {
        foreach (var name in ServiceStack.StopOrder)
        {
            try
            {
                using var controller = new ServiceController(name);
                if (controller.Status != ServiceControllerStatus.Stopped)
                {
                    return false;
                }
            }
            catch (InvalidOperationException ex)
                when ((ex.InnerException as Win32Exception)?.NativeErrorCode == ErrorServiceDoesNotExist)
            {
                // Not installed — nothing to stop.
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
            {
                return false;
            }
        }
        return true;
    }

    private static string Map(ServiceControllerStatus status) => status switch
    {
        ServiceControllerStatus.Running => ScmStates.Running,
        ServiceControllerStatus.Stopped => ScmStates.Stopped,
        ServiceControllerStatus.StartPending => ScmStates.StartPending,
        ServiceControllerStatus.StopPending => ScmStates.StopPending,
        ServiceControllerStatus.Paused
            or ServiceControllerStatus.PausePending
            or ServiceControllerStatus.ContinuePending => ScmStates.Paused,
        _ => ScmStates.Other,
    };
}
