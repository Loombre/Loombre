// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Ipc/ServiceStack.cs
//
// The canonical Windows-service names + orderings + elevated command
// lines for whole-stack lifecycle operations — pure data, pinned by
// ServiceStackTests, consumed by the WinForms side's ServiceManagerProbe.
// Mirrors the macOS controller's LaunchdFallback (LoombreIPCKit): the two
// encode the same policy — start server-first (it hosts the embedded
// PostgreSQL), stop consumers-first with the server LAST — and should be
// edited together.
//
// Lives here rather than in the WinForms project so the strings and
// orderings are testable on any OS (this project's plain-net8.0
// portability is load-bearing — its csproj header); the actual SCM/UAC
// calls stay in ServiceManagerProbe, which is Windows-only by nature.

namespace Loombre.Tray.Ipc;

public static class ServiceStack
{
    // Lockstep with installers/windows/msi/Services.wxs' three
    // ServiceInstall registrations (test-pinned).
    public const string ServerServiceName = "LoombreServer";
    public const string WorkerServiceName = "LoombreWorker";
    public const string WebServiceName = "LoombreWeb";

    /// <summary>Start order: server first. Worker and web declare SCM
    /// dependencies on the server, but SCM dependencies only order starts
    /// the SCM itself initiates — they never auto-start a stopped
    /// dependent — so a full-stack start touches all three.</summary>
    public static readonly IReadOnlyList<string> StartOrder =
        [ServerServiceName, WorkerServiceName, WebServiceName];

    /// <summary>Stop order: consumers first, server LAST. The SCM refuses
    /// to stop a service whose dependents are still running (worker/web
    /// depend on the server), and the server hosts the embedded
    /// PostgreSQL — stopping it last means nothing spends its shutdown
    /// window flailing against a dead database.</summary>
    public static readonly IReadOnlyList<string> StopOrder =
        [WorkerServiceName, WebServiceName, ServerServiceName];

    /// <summary>cmd.exe arguments for the UAC-elevated stack start.
    /// /d skips AutoRun registry commands; `sc start` per service,
    /// &amp;-chained so one failure (e.g. ERROR_SERVICE_ALREADY_RUNNING on
    /// a service that never stopped) doesn't skip the rest.</summary>
    public static string ElevatedStartArguments =>
        "/d /c " + string.Join(" & ", StartOrder.Select(name => $"sc start {name}"));

    /// <summary>cmd.exe arguments for the UAC-elevated full shutdown.
    /// `net stop`, NOT `sc stop`: net stop WAITS for each service to
    /// reach Stopped before moving on — the stop order is respected for
    /// real, and the elevated process's exit doubles as "shutdown
    /// finished" for the caller. &amp;-chained so an already-stopped
    /// service's "service is not started" error doesn't skip the rest
    /// (idempotent kill switch).</summary>
    public static string ElevatedStopArguments =>
        "/d /c " + string.Join(" & ", StopOrder.Select(name => $"net stop {name}"));
}
