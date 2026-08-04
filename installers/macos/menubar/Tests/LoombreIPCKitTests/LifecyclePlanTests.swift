// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: Tests/LoombreIPCKitTests/LifecyclePlanTests.swift
//
// Pure logic tests for MenuState.lifecyclePlan(isConnected:state:) — the
// decision table behind the Start/Stop Server menu item. The load-bearing
// case is the first one: with NO live IPC connection (server stopped),
// the item must be an ENABLED "Start Server" that routes to launchd —
// the v0.9.0-rc field reports showed it permanently grayed out, because
// the old enable condition required a connection to the very process the
// user was trying to start (IPC_SERVER_START_SEMANTICS documents that the
// IPC start endpoint can never start a stopped server; launchctl is the
// sanctioned mechanism).

import XCTest
@testable import LoombreIPCKit

final class LifecyclePlanTests: XCTestCase {
    func test_unreachable_server_yields_enabled_start_via_launchd() {
        let plan = MenuState.lifecyclePlan(isConnected: false, state: .notRunning)
        XCTAssertEqual(plan.title, "Start Loombre")
        XCTAssertTrue(plan.isEnabled)
        XCTAssertEqual(plan.action, .startViaLaunchd)
    }

    /// A live connection reporting server "stopped" cannot happen today
    /// (the IPC listener lives inside the server), but the type allows it —
    /// and the IPC start endpoint deterministically 409s, so the launchd
    /// path must win here too, not a doomed IPC POST.
    func test_connected_but_notRunning_still_routes_start_to_launchd() {
        let plan = MenuState.lifecyclePlan(isConnected: true, state: .notRunning)
        XCTAssertEqual(plan.title, "Start Loombre")
        XCTAssertTrue(plan.isEnabled)
        XCTAssertEqual(plan.action, .startViaLaunchd)
    }

    func test_running_yields_enabled_stop_via_ipc() {
        let plan = MenuState.lifecyclePlan(isConnected: true, state: .running)
        XCTAssertEqual(plan.title, "Stop Server")
        XCTAssertTrue(plan.isEnabled)
        XCTAssertEqual(plan.action, .stopViaIpc)
    }

    func test_degraded_yields_enabled_stop_via_ipc() {
        let plan = MenuState.lifecyclePlan(isConnected: true, state: .degraded(detail: "worker stopped"))
        XCTAssertEqual(plan.title, "Stop Server")
        XCTAssertTrue(plan.isEnabled)
        XCTAssertEqual(plan.action, .stopViaIpc)
    }

    /// .crashed with a live connection means a sibling process (worker)
    /// crashed while the server itself is up — stopping the server is
    /// still a meaningful, safe action.
    func test_crashed_with_connection_yields_enabled_stop_via_ipc() {
        let plan = MenuState.lifecyclePlan(isConnected: true, state: .crashed)
        XCTAssertEqual(plan.title, "Stop Server")
        XCTAssertTrue(plan.isEnabled)
        XCTAssertEqual(plan.action, .stopViaIpc)
    }

    /// .crashed derived WITHOUT a connection would mean stale state; with
    /// nothing to talk to, an IPC stop is impossible — but a launchd start
    /// is exactly what recovers a dead server, so it behaves as notRunning.
    func test_crashed_without_connection_routes_start_to_launchd() {
        let plan = MenuState.lifecyclePlan(isConnected: false, state: .crashed)
        XCTAssertEqual(plan.title, "Start Loombre")
        XCTAssertTrue(plan.isEnabled)
        XCTAssertEqual(plan.action, .startViaLaunchd)
    }

    func test_transitional_and_mismatch_states_disable_the_item() {
        for state: MenuIconState in [
            .starting, .stopping, .contractMismatch(serverVersion: 2, clientVersion: 1),
        ] {
            let plan = MenuState.lifecyclePlan(isConnected: true, state: state)
            XCTAssertFalse(plan.isEnabled, "expected disabled for \(state)")
            XCTAssertEqual(plan.action, .none, "expected no action for \(state)")
        }
    }

    // MARK: - launchd fallback constants

    func test_launchd_fallback_names_the_shipped_daemons() {
        // Labels + plist paths must match installers/macos/pkg/launchd's
        // three shipped plists and postinstall's bootstrap loop.
        XCTAssertEqual(LaunchdFallback.serverLabel, "com.loombre.server")
        XCTAssertEqual(LaunchdFallback.workerLabel, "com.loombre.worker")
        XCTAssertEqual(LaunchdFallback.webLabel, "com.loombre.web")
        XCTAssertEqual(LaunchdFallback.serverPlistPath, "/Library/LaunchDaemons/com.loombre.server.plist")
        XCTAssertEqual(LaunchdFallback.workerPlistPath, "/Library/LaunchDaemons/com.loombre.worker.plist")
        XCTAssertEqual(LaunchdFallback.webPlistPath, "/Library/LaunchDaemons/com.loombre.web.plist")
    }

    /// Start restores the WHOLE stack, not just the server: after a full
    /// shutdown (bootout of all three daemons) a server-only start would
    /// leave worker + web permanently down until the next reboot.
    func test_launchd_start_command_kickstarts_then_bootstraps_all_three_daemons() {
        let command = LaunchdFallback.startAllShellCommand
        for (label, plist) in [
            ("com.loombre.server", "/Library/LaunchDaemons/com.loombre.server.plist"),
            ("com.loombre.worker", "/Library/LaunchDaemons/com.loombre.worker.plist"),
            ("com.loombre.web", "/Library/LaunchDaemons/com.loombre.web.plist"),
        ] {
            // Per-service recovery pair, empirically verified semantics:
            // kickstart exits 0 for running OR loaded-but-stopped services
            // and fails for a booted-out one, where bootstrap recovers it.
            XCTAssertTrue(command.contains("/bin/launchctl kickstart system/\(label) || /bin/launchctl bootstrap system \(plist)"), "missing kickstart||bootstrap pair for \(label)")
        }
        // The server hosts the embedded PostgreSQL the worker depends on —
        // it must be started first, and a server-start failure must not be
        // masked by the later groups (&&-joined subshell groups).
        XCTAssertTrue(command.range(of: "kickstart system/com.loombre.server")!.lowerBound
            < command.range(of: "kickstart system/com.loombre.worker")!.lowerBound)
        XCTAssertTrue(command.contains(") && ("))
        assertAppleScriptEmbeddable(command)
    }

    /// The full-shutdown command behind "Shut Down Loombre…": boots out all
    /// three daemons. Consumers first (worker, web), the PostgreSQL-hosting
    /// server LAST, so nothing spends its shutdown window flailing against
    /// a dead database. A not-loaded daemon is SUCCESS (idempotent kill
    /// switch), which is why each group is guarded by a print-probe rather
    /// than blanket `|| true` — a genuine bootout failure must still fail.
    func test_shutdown_command_boots_out_all_three_daemons_server_last() {
        let command = LaunchdFallback.shutdownAllShellCommand
        for label in ["com.loombre.server", "com.loombre.worker", "com.loombre.web"] {
            XCTAssertTrue(command.contains("! /bin/launchctl print system/\(label)"), "missing not-loaded guard for \(label)")
            XCTAssertTrue(command.contains("/bin/launchctl bootout system/\(label)"), "missing bootout for \(label)")
        }
        XCTAssertTrue(command.range(of: "bootout system/com.loombre.worker")!.lowerBound
            < command.range(of: "bootout system/com.loombre.web")!.lowerBound)
        XCTAssertTrue(command.range(of: "bootout system/com.loombre.web")!.lowerBound
            < command.range(of: "bootout system/com.loombre.server")!.lowerBound)
        XCTAssertTrue(command.contains(") && ("))
        assertAppleScriptEmbeddable(command)
    }

    /// No characters that would need escaping inside an AppleScript
    /// `do shell script "..."` literal — the caller embeds these verbatim.
    private func assertAppleScriptEmbeddable(_ command: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(command.contains("\""), "command must not contain double quotes", file: file, line: line)
        XCTAssertFalse(command.contains("\\"), "command must not contain backslashes", file: file, line: line)
    }

    // MARK: - first-run auto-open decision

    func test_auto_open_fires_once_when_web_url_becomes_available() {
        XCTAssertTrue(MenuState.shouldAutoOpenWeb(alreadyOpened: false, webUrl: "http://localhost:3000"))
        XCTAssertFalse(MenuState.shouldAutoOpenWeb(alreadyOpened: true, webUrl: "http://localhost:3000"))
        XCTAssertFalse(MenuState.shouldAutoOpenWeb(alreadyOpened: false, webUrl: nil))
    }
}
