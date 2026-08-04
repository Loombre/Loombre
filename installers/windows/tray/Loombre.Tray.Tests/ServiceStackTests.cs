// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Tests/ServiceStackTests.cs
//
// Pins ServiceStack — the canonical service names, start/stop orderings,
// and the UAC-elevated cmd.exe argument strings behind "Start Loombre"
// and "Shut down Loombre…". The mirror of the macOS controller's
// LifecyclePlanTests launchd-fallback pins (LoombreIPCKit): the two
// encode the same policy — start server-first, stop consumers-first with
// the embedded-PG-hosting server LAST — and should be edited together.

using Loombre.Tray.Ipc;
using Xunit;

namespace Loombre.Tray.Tests;

public sealed class ServiceStackTests
{
    [Fact]
    public void Service_names_match_the_Services_wxs_registrations()
    {
        // Lockstep with installers/windows/msi/Services.wxs — if a
        // registration is renamed there, this test is the tripwire.
        Assert.Equal("LoombreServer", ServiceStack.ServerServiceName);
        Assert.Equal("LoombreWorker", ServiceStack.WorkerServiceName);
        Assert.Equal("LoombreWeb", ServiceStack.WebServiceName);
    }

    [Fact]
    public void Start_order_is_server_first()
    {
        // The server hosts the embedded PostgreSQL the worker and web UI
        // depend on. (SCM dependencies only order starts the SCM itself
        // initiates — a manual stack start must still touch all three.)
        Assert.Equal(
            new[] { "LoombreServer", "LoombreWorker", "LoombreWeb" },
            ServiceStack.StartOrder);
    }

    [Fact]
    public void Stop_order_is_consumers_first_server_last()
    {
        // Worker and web declare SCM dependencies ON the server, so they
        // must stop before it (stopping a service with running dependents
        // fails) — and stopping the PG-hosting server last also means
        // neither spends its shutdown window flailing against a dead
        // database. Same ordering as the macOS shutdownAllShellCommand.
        Assert.Equal(
            new[] { "LoombreWorker", "LoombreWeb", "LoombreServer" },
            ServiceStack.StopOrder);
    }

    [Fact]
    public void Elevated_start_arguments_sc_start_each_service_in_start_order()
    {
        // The exact string ServiceManagerProbe hands to an elevated
        // cmd.exe: /d skips AutoRun, sc start per service in StartOrder
        // (& chains regardless of failure — an already-running service's
        // ERROR_SERVICE_ALREADY_RUNNING is harmless).
        Assert.Equal(
            "/d /c sc start LoombreServer & sc start LoombreWorker & sc start LoombreWeb",
            ServiceStack.ElevatedStartArguments);
    }

    [Fact]
    public void Elevated_stop_arguments_net_stop_each_service_in_stop_order()
    {
        // net stop, NOT sc stop: net stop WAITS for each service to
        // reach Stopped before moving on, which both respects the stop
        // order for real and lets the caller treat process exit as
        // "shutdown finished" before verifying + quitting the tray.
        // & chains regardless of failure — an already-stopped service's
        // "service is not started" error is harmless (idempotent kill
        // switch).
        Assert.Equal(
            "/d /c net stop LoombreWorker & net stop LoombreWeb & net stop LoombreServer",
            ServiceStack.ElevatedStopArguments);
    }
}
