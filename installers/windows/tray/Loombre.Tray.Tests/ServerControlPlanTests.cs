// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Tests/ServerControlPlanTests.cs
//
// Decision-table tests for ServerControl.Decide — the logic behind the
// tray's Start/Stop-server menu item. The load-bearing case is the first
// one: with the IPC listener unreachable (server stopped) and SCM
// reporting the LoombreServer service stopped, the item must be an
// ENABLED "Start server" routed to the Service Control Manager. The
// v0.9.0-rc field reports showed it permanently grayed out: the old
// enable condition required a successful IPC poll — a connection to the
// very process the user was trying to start (IPC_SERVER_START_SEMANTICS
// documents that the IPC start endpoint can never start a stopped server;
// the SCM is the sanctioned mechanism). Mirrors the macOS decision table
// (LoombreIPCKit MenuState.lifecyclePlan + LifecyclePlanTests.swift).

using Loombre.Tray.Ipc;
using Xunit;

namespace Loombre.Tray.Tests;

public sealed class ServerControlPlanTests
{
    private static IpcStatusResponse Status(string serverState) => new()
    {
        IpcContractVersion = ContractVersion.ControllerIpcContractVersion,
        Server = new ProcessInfo { State = serverState, Version = "0.9.0" },
        Worker = new ProcessInfo { State = ProcessStates.Running, Version = "0.9.0" },
        WebUrl = "http://localhost:3000",
        Provisioning = new ProvisioningStatus { State = ProvisioningStates.Ready, LastCheckMs = 1 },
    };

    [Fact]
    public void Unreachable_with_stopped_service_yields_enabled_start_via_scm()
    {
        var plan = ServerControl.Decide(status: null, scm: new ScmSnapshot(true, ScmStates.Stopped));
        Assert.Equal("Start server", plan.Text);
        Assert.True(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.StartViaScm, plan.Action);
    }

    [Fact]
    public void Unreachable_with_paused_service_yields_enabled_start_via_scm()
    {
        var plan = ServerControl.Decide(status: null, scm: new ScmSnapshot(true, ScmStates.Paused));
        Assert.True(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.StartViaScm, plan.Action);
    }

    [Fact]
    public void Unreachable_with_running_service_reads_as_starting_and_disables()
    {
        // Service up but the IPC listener not yet bound = the child is
        // still booting (first-start payload extraction, migrations).
        // Honest label, no action to offer yet.
        var plan = ServerControl.Decide(status: null, scm: new ScmSnapshot(true, ScmStates.Running));
        Assert.Equal("Starting server…", plan.Text);
        Assert.False(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.None, plan.Action);
    }

    [Fact]
    public void Unreachable_with_start_pending_service_reads_as_starting_and_disables()
    {
        var plan = ServerControl.Decide(status: null, scm: new ScmSnapshot(true, ScmStates.StartPending));
        Assert.Equal("Starting server…", plan.Text);
        Assert.False(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.None, plan.Action);
    }

    [Fact]
    public void Unreachable_with_stop_pending_service_reads_as_stopping_and_disables()
    {
        var plan = ServerControl.Decide(status: null, scm: new ScmSnapshot(true, ScmStates.StopPending));
        Assert.Equal("Stopping server…", plan.Text);
        Assert.False(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.None, plan.Action);
    }

    [Fact]
    public void Unreachable_without_installed_service_disables_start()
    {
        // Dev runs / broken installs: nothing the tray could start.
        var plan = ServerControl.Decide(status: null, scm: new ScmSnapshot(false, ScmStates.Other));
        Assert.Equal("Start server", plan.Text);
        Assert.False(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.None, plan.Action);
    }

    [Fact]
    public void Unreachable_without_scm_answer_disables_start()
    {
        var plan = ServerControl.Decide(status: null, scm: null);
        Assert.Equal("Start server", plan.Text);
        Assert.False(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.None, plan.Action);
    }

    [Fact]
    public void Reachable_running_server_yields_enabled_stop_via_ipc()
    {
        var plan = ServerControl.Decide(Status(ProcessStates.Running), scm: null);
        Assert.Equal("Stop server", plan.Text);
        Assert.True(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.StopViaIpc, plan.Action);
    }

    [Fact]
    public void Reachable_stopped_server_still_routes_start_to_scm()
    {
        // Cannot happen today (the IPC listener lives inside the server,
        // which hardcodes its own state to running) — but the wire type
        // allows it, and the IPC start endpoint deterministically 409s,
        // so the SCM path must win here too, gated on the SCM snapshot.
        var plan = ServerControl.Decide(Status(ProcessStates.Stopped), new ScmSnapshot(true, ScmStates.Stopped));
        Assert.Equal("Start server", plan.Text);
        Assert.True(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.StartViaScm, plan.Action);
    }

    [Theory]
    [InlineData(ProcessStates.Starting)]
    [InlineData(ProcessStates.Stopping)]
    public void Reachable_transitional_server_disables_the_item(string serverState)
    {
        var plan = ServerControl.Decide(Status(serverState), scm: null);
        Assert.False(plan.Enabled);
        Assert.Equal(ServerLifecycleAction.None, plan.Action);
    }
}
