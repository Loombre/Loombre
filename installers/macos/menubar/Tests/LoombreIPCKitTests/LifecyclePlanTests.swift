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
        XCTAssertEqual(plan.title, "Start Server")
        XCTAssertTrue(plan.isEnabled)
        XCTAssertEqual(plan.action, .startViaLaunchd)
    }

    /// A live connection reporting server "stopped" cannot happen today
    /// (the IPC listener lives inside the server), but the type allows it —
    /// and the IPC start endpoint deterministically 409s, so the launchd
    /// path must win here too, not a doomed IPC POST.
    func test_connected_but_notRunning_still_routes_start_to_launchd() {
        let plan = MenuState.lifecyclePlan(isConnected: true, state: .notRunning)
        XCTAssertEqual(plan.title, "Start Server")
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
        XCTAssertEqual(plan.title, "Start Server")
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

    func test_launchd_fallback_names_the_shipped_daemon() {
        // Label + plist path must match installers/macos/pkg/launchd's
        // com.loombre.server.plist and postinstall's bootstrap loop.
        XCTAssertEqual(LaunchdFallback.serverLabel, "com.loombre.server")
        XCTAssertEqual(LaunchdFallback.serverPlistPath, "/Library/LaunchDaemons/com.loombre.server.plist")
    }

    func test_launchd_start_command_kickstarts_then_bootstraps() {
        let command = LaunchdFallback.startServerShellCommand
        XCTAssertTrue(command.contains("launchctl kickstart system/com.loombre.server"))
        XCTAssertTrue(command.contains("launchctl bootstrap system /Library/LaunchDaemons/com.loombre.server.plist"))
        // No characters that would need escaping inside an AppleScript
        // `do shell script "..."` literal — the caller embeds it verbatim.
        XCTAssertFalse(command.contains("\""))
        XCTAssertFalse(command.contains("\\"))
    }

    // MARK: - first-run auto-open decision

    func test_auto_open_fires_once_when_web_url_becomes_available() {
        XCTAssertTrue(MenuState.shouldAutoOpenWeb(alreadyOpened: false, webUrl: "http://localhost:3000"))
        XCTAssertFalse(MenuState.shouldAutoOpenWeb(alreadyOpened: true, webUrl: "http://localhost:3000"))
        XCTAssertFalse(MenuState.shouldAutoOpenWeb(alreadyOpened: false, webUrl: nil))
    }
}
