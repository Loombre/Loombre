// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Ipc/ServerControl.cs
//
// The Start/Stop-server decision table — pure data in, pure data out, so
// it lives in this headless project and is pinned by
// Loombre.Tray.Tests/ServerControlPlanTests.cs. Mirrors the macOS
// controller's MenuState.lifecyclePlan (LoombreIPCKit) — the two decision
// tables encode the same policy and should be edited together.
//
// WHY TWO CHANNELS: packages/controller-ipc's IPC_SERVER_START_SEMANTICS
// documents that POST /ipc/v1/server/start is served by the server
// process itself — reachable only while the server is already up, and a
// deterministic 409 when reached. Stopping goes over IPC (graceful, the
// server owns its own shutdown); STARTING a stopped server must go
// through the Service Control Manager, the platform's sanctioned
// mechanism. The old tray hard-disabled the item whenever the IPC poll
// failed — i.e. exactly when starting was the one action the user needed
// (the rc "Start server is always grayed out" field report).
//
// This file knows nothing about System.ServiceProcess — the WinForms app
// queries the SCM and passes a plain ScmSnapshot in, keeping this project
// buildable and testable on any OS.

namespace Loombre.Tray.Ipc;

/// <summary>What clicking the Start/Stop menu item should do.</summary>
public enum ServerLifecycleAction
{
    None,
    /// <summary>POST /ipc/v1/server/stop over the live IPC connection.</summary>
    StopViaIpc,
    /// <summary>Start the stopped LoombreServer service (and its downstream
    /// worker/web siblings, best-effort) via the Service Control Manager.</summary>
    StartViaScm,
}

/// <summary>Windows service states as this decision table distinguishes
/// them — a deliberately small projection of ServiceControllerStatus
/// (plain strings so this project needs no System.ServiceProcess).</summary>
public static class ScmStates
{
    public const string Running = "running";
    public const string Stopped = "stopped";
    public const string StartPending = "startPending";
    public const string StopPending = "stopPending";
    public const string Paused = "paused";
    public const string Other = "other";
}

/// <summary>What the WinForms side learned from the SCM about the
/// LoombreServer service. <c>ServiceExists=false</c> means the SCM
/// answered but no such service is installed (dev runs, broken installs).
/// A null snapshot at the Decide call site means the SCM query itself
/// failed.</summary>
public sealed record ScmSnapshot(bool ServiceExists, string State);

/// <summary>Title + enablement + action for the Start/Stop-server menu
/// item, derived in exactly one place.</summary>
public sealed record ServerControlPlan(string Text, bool Enabled, ServerLifecycleAction Action);

public static class ServerControl
{
    public static ServerControlPlan Decide(IpcStatusResponse? status, ScmSnapshot? scm)
    {
        if (status is not null)
        {
            return status.Server.State switch
            {
                ProcessStates.Running => new ServerControlPlan("Stop server", true, ServerLifecycleAction.StopViaIpc),
                ProcessStates.Starting => new ServerControlPlan("Starting server…", false, ServerLifecycleAction.None),
                ProcessStates.Stopping => new ServerControlPlan("Stopping server…", false, ServerLifecycleAction.None),
                // stopped/crashed over a LIVE connection cannot happen
                // today (the listener lives inside the server, which
                // reports itself running) — but the wire type allows it,
                // and the IPC start endpoint deterministically 409s, so
                // route these through the SCM exactly like unreachable.
                _ => DecideFromScm(scm),
            };
        }
        return DecideFromScm(scm);
    }

    private static ServerControlPlan DecideFromScm(ScmSnapshot? scm)
    {
        if (scm is null || !scm.ServiceExists)
        {
            // Nothing this tray could start: no SCM answer, or no
            // LoombreServer service installed at all.
            return new ServerControlPlan("Start server", false, ServerLifecycleAction.None);
        }
        return scm.State switch
        {
            ScmStates.Stopped or ScmStates.Paused =>
                new ServerControlPlan("Start server", true, ServerLifecycleAction.StartViaScm),
            // Service up but the IPC listener not reachable: the child is
            // still booting (first-start payload extraction, initdb,
            // migrations can take minutes) — say so instead of showing a
            // grayed-out "Start server" over a server that IS starting.
            ScmStates.Running or ScmStates.StartPending =>
                new ServerControlPlan("Starting server…", false, ServerLifecycleAction.None),
            ScmStates.StopPending =>
                new ServerControlPlan("Stopping server…", false, ServerLifecycleAction.None),
            _ => new ServerControlPlan("Start server", false, ServerLifecycleAction.None),
        };
    }
}
