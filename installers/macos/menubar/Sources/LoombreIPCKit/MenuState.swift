// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/MenuState.swift
//
// Pure derivation of "what should the menu bar icon/menu look like" from
// an IPCStatusResponse (or the absence of one). Kept free of AppKit so it
// is unit-testable with plain values — AppDelegate.swift is the only place
// that turns a MenuIconState into an actual NSStatusItem update.

import Foundation

public enum MenuIconState: Equatable {
    /// No discovery/token file, a stale pid, or the connection failed
    /// outright — from the menubar's point of view these all mean the
    /// same thing: "nothing to control."
    case notRunning
    case starting
    case running
    case stopping
    /// Server or worker reported crashed.
    case crashed
    /// Everything is up but something is off-nominal (worker down while
    /// server's up, provisioning corrupt, etc.) — `detail` is a short,
    /// human-readable reason for the menu item, not a typed enum, because
    /// this is a UI-only aggregation with no wire representation of its
    /// own (unlike every other type in this package).
    case degraded(detail: String)
    /// The connected server's ipcContractVersion doesn't match this
    /// client build's controllerIpcContractVersion (mission: "version +
    /// contract-version mismatch notice").
    case contractMismatch(serverVersion: Int, clientVersion: Int)

    public var isActionable: Bool {
        switch self {
        case .notRunning, .running, .degraded, .crashed: return true
        case .starting, .stopping, .contractMismatch: return false
        }
    }
}

/// What the Start/Stop Server menu item should DO when clicked.
public enum LifecycleAction: Equatable {
    /// POST /ipc/v1/server/stop over the live IPC connection.
    case stopViaIpc
    /// Start the stopped LaunchDaemon via launchctl (admin-privileged) —
    /// the IPC_SERVER_START_SEMANTICS-sanctioned path; the IPC start
    /// endpoint can never start a stopped server (it lives inside it).
    case startViaLaunchd
    case none
}

/// What double-clicking Loombre.app in /Applications (or a Dock/Launchpad
/// reopen) should do — the field report's "opening the app while the
/// menubar agent is already running does NOTHING" gap: LaunchServices just
/// activates the running LSUIElement instance, which has no window to
/// show, so nothing visibly happens. With a live IPC connection we can
/// resolve the operator's ACTUAL configured web URL through the existing
/// open flow; without one, IPC can't be asked anything, so the fallback is
/// the installed default rather than silence.
public enum ReopenAction: Equatable {
    /// Route through the existing "Open Loombre" IPC flow (openWebTarget)
    /// rather than guessing a URL.
    case resolveViaIPC
    /// No IPC connection to ask — open this URL directly.
    case openFallback(url: String)
}

/// Title + enablement + action for the Start/Stop Server menu item —
/// pure data, derived in one place so the "Start Server is grayed out
/// exactly when you need it" failure mode can never be reintroduced by
/// UI-side condition drift.
public struct LifecyclePlan: Equatable {
    public let title: String
    public let isEnabled: Bool
    public let action: LifecycleAction

    public init(title: String, isEnabled: Bool, action: LifecycleAction) {
        self.title = title
        self.isEnabled = isEnabled
        self.action = action
    }
}

/// Constants for the launchd fallback — kept in lockstep with the three
/// plists in installers/macos/pkg/launchd/ and the postinstall bootstrap
/// loop (LifecyclePlanTests pins all of them).
public enum LaunchdFallback {
    public static let serverLabel = "com.loombre.server"
    public static let workerLabel = "com.loombre.worker"
    public static let webLabel = "com.loombre.web"
    public static let serverPlistPath = "/Library/LaunchDaemons/com.loombre.server.plist"
    public static let workerPlistPath = "/Library/LaunchDaemons/com.loombre.worker.plist"
    public static let webPlistPath = "/Library/LaunchDaemons/com.loombre.web.plist"

    /// Per-service start recovery pair. kickstart handles the common cases
    /// (empirically verified: exits 0 for a running service — harmless
    /// no-op — AND for a loaded-but-stopped one, e.g. after the menubar's
    /// own Stop, since the plists set KeepAlive.SuccessfulExit=false);
    /// bootstrap recovers the booted-out case (a prior Shut Down, manual
    /// bootout, failed install step — kickstart exits 113 "could not find
    /// service" there).
    private static func startGroup(_ label: String, _ plistPath: String) -> String {
        "( /bin/launchctl kickstart system/\(label) || /bin/launchctl bootstrap system \(plistPath) )"
    }

    /// Starts ALL THREE daemons, server first (it hosts the embedded
    /// PostgreSQL the worker and web UI depend on). &&-joined so a
    /// server-start failure is reported instead of masked by the later
    /// groups. Composed so it can be embedded verbatim in an AppleScript
    /// `do shell script` literal — no quotes or backslashes
    /// (test-enforced).
    public static var startAllShellCommand: String {
        [
            startGroup(serverLabel, serverPlistPath),
            startGroup(workerLabel, workerPlistPath),
            startGroup(webLabel, webPlistPath),
        ].joined(separator: " && ")
    }

    /// Per-service full-stop group: a daemon that is not loaded counts as
    /// already shut down (the `! print` guard, mirroring preinstall's own
    /// probe-then-bootout loop), while a loaded daemon must actually boot
    /// out — a genuine bootout failure still fails the command, unlike a
    /// blanket `|| true`.
    private static func shutdownGroup(_ label: String) -> String {
        "( ! /bin/launchctl print system/\(label) >/dev/null 2>&1 || /bin/launchctl bootout system/\(label) )"
    }

    /// The full-shutdown command behind "Shut Down Loombre…": boots out
    /// all three daemons — until the next boot (RunAtLoad brings them back
    /// when the Mac restarts) or the next Start from this menu. Consumers
    /// first (worker, then web), the PostgreSQL-hosting server LAST, so
    /// neither spends its shutdown window flailing against a database that
    /// died before it did. AppleScript-embeddable, same rules as
    /// startAllShellCommand (test-enforced).
    public static var shutdownAllShellCommand: String {
        [
            shutdownGroup(workerLabel),
            shutdownGroup(webLabel),
            shutdownGroup(serverLabel),
        ].joined(separator: " && ")
    }
}

public enum MenuState {
    /// The installed default web UI URL — installers/macos/LAYOUT.md §11:
    /// bin/loombre-web serves :3000. The SINGLE shared fallback for every
    /// "IPC can't answer, open SOMETHING anyway" path: reopenAction (no
    /// live connection at all) and AppDelegate.openLoombre()'s catch
    /// (a connection existed but the IPC call itself failed) both resolve
    /// here, so there is exactly one URL to update if the default port
    /// ever changes, not two that can drift apart.
    public static let installedDefaultWebUrl = "http://localhost:3000"

    public static func derive(from status: IPCStatusResponse) -> MenuIconState {
        guard status.matchesClientContractVersion else {
            return .contractMismatch(
                serverVersion: status.ipcContractVersion,
                clientVersion: controllerIpcContractVersion
            )
        }

        // Priority order (most urgent/actionable first): a crashed process
        // needs a restart NOW, so it wins over a merely-degraded database —
        // an operator staring at the menu bar should see "crashed," not a
        // softer "degraded" label, when the daemon itself is down.
        if status.server.state == .crashed || status.worker.state == .crashed {
            return .crashed
        }

        if status.provisioning.state == .corrupt {
            return .degraded(detail: "database: \(status.provisioning.detail ?? "corrupt")")
        }

        switch status.server.state {
        case .crashed:
            // Unreachable — already handled above — kept for switch
            // exhaustiveness so a future ProcessState case can't silently
            // fall through this function without a compiler error.
            return .crashed
        case .starting:
            return .starting
        case .stopping:
            return .stopping
        case .stopped:
            return .notRunning
        case .running:
            // worker == .crashed already returned above; anything else
            // non-running (stopped/starting/stopping) is a real mismatch
            // worth surfacing distinctly from a fully healthy .running.
            if status.worker.state != .running {
                return .degraded(detail: "worker \(status.worker.state.rawValue)")
            }
            return .running
        }
    }

    /// Any transport-level failure (no discovery file, stale pid, HTTP
    /// error) collapses to the same UI state: there is no live server to
    /// report anything more specific about.
    public static func deriveFromUnreachable() -> MenuIconState {
        .notRunning
    }

    /// Decision table for the Start/Stop Server menu item. The one rule
    /// that fixes the rc field report ("Start Server is always grayed
    /// out"): a not-running server yields an ENABLED Start routed to
    /// launchd — it must never require the IPC connection whose absence
    /// is the very reason the user wants to start the server.
    public static func lifecyclePlan(isConnected: Bool, state: MenuIconState) -> LifecyclePlan {
        switch state {
        case .notRunning:
            return LifecyclePlan(title: "Start Loombre", isEnabled: true, action: .startViaLaunchd)
        case .running, .degraded:
            return LifecyclePlan(title: "Stop Server", isEnabled: isConnected, action: isConnected ? .stopViaIpc : .none)
        case .crashed:
            // With a live connection this means a SIBLING process crashed
            // while the server is up — an IPC stop is meaningful. Without
            // one the server itself is dead, and recovery is a launchd
            // start, exactly as for notRunning.
            return isConnected
                ? LifecyclePlan(title: "Stop Server", isEnabled: true, action: .stopViaIpc)
                : LifecyclePlan(title: "Start Loombre", isEnabled: true, action: .startViaLaunchd)
        case .starting, .stopping:
            return LifecyclePlan(title: "Stop Server", isEnabled: false, action: .none)
        case .contractMismatch:
            // A server we can reach but whose contract we don't share:
            // don't offer lifecycle actions we can't interpret replies to.
            return LifecyclePlan(title: "Stop Server", isEnabled: false, action: .none)
        }
    }

    /// Per-install auto-open decision (installer completion flow): open the
    /// browser to the web UI once per INSTALL, not once per user forever —
    /// the rc.6 field report found the conclusion pane's "Your browser will
    /// open automatically" promise going unfulfilled on every
    /// reinstall/upgrade after the very first one, because the old gate was
    /// a UserDefaults bool that, once set, stayed set across every later
    /// upgrade. `currentStamp` is InstallStamp.read()'s epoch-ms string for
    /// /opt/loombre/current, which the installer recreates on every
    /// install/upgrade — so a stamp that differs from what was last stored
    /// fires again even though SOME earlier install already got its
    /// auto-open. `currentStamp == nil` (dev runs outside an installed
    /// layout) NEVER fires, regardless of webUrl or lastOpenedStamp — there
    /// is no install to key an "already opened for this one" decision off
    /// of.
    public static func shouldAutoOpenWeb(lastOpenedStamp: String?, currentStamp: String?, webUrl: String?) -> Bool {
        guard webUrl != nil, let currentStamp else { return false }
        return currentStamp != lastOpenedStamp
    }

    /// Decision behind applicationShouldHandleReopen: with a live
    /// connection, resolve through IPC (reusing the existing "Open Loombre"
    /// flow); without one, fall back to installedDefaultWebUrl — with IPC
    /// unreachable there is no way to learn the operator's actual
    /// configured URL.
    public static func reopenAction(isConnected: Bool) -> ReopenAction {
        isConnected ? .resolveViaIPC : .openFallback(url: installedDefaultWebUrl)
    }

    /// SF Symbol name for the given state — pure lookup table, no AppKit.
    public static func symbolName(for state: MenuIconState) -> String {
        switch state {
        case .notRunning: return "circle.dashed"
        case .starting, .stopping: return "circle.dotted"
        case .running: return "flame.fill"
        case .crashed: return "exclamationmark.triangle.fill"
        case .degraded: return "exclamationmark.circle.fill"
        case .contractMismatch: return "questionmark.circle.fill"
        }
    }

    /// Short menu-item label describing the state — pure, testable.
    public static func statusLabel(for state: MenuIconState) -> String {
        switch state {
        case .notRunning: return "Loombre is not running"
        case .starting: return "Loombre is starting…"
        case .running: return "Loombre is running"
        case .stopping: return "Loombre is stopping…"
        case .crashed: return "Loombre has crashed"
        case .degraded(let detail): return "Loombre is degraded (\(detail))"
        case .contractMismatch(let serverVersion, let clientVersion):
            return "Contract version mismatch (server v\(serverVersion), controller v\(clientVersion))"
        }
    }
}
