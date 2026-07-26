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

public enum MenuState {
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
