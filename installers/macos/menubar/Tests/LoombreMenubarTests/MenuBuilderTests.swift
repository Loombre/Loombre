// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreMenubarTests/MenuBuilderTests.swift
//
// AppKit-side menu wiring, previously the one untested layer — and
// exactly where the shipped "the whole menu bar isn't wired" field report
// lived: NSMenu's DEFAULT autoenablement force-enables any item that has
// a target+action, silently overriding every manual isEnabled assignment,
// so items designed to be grayed out without an IPC connection were
// clickable and hit their guard-returns with zero feedback. These tests
// build the real NSMenu (headless — NSMenu needs no NSApplication) and
// pin autoenablesItems=false plus each item's action routing and
// enablement per state.

import AppKit
import XCTest
import LoombreIPCKit
@testable import LoombreMenubar

final class MenuBuilderTests: XCTestCase {
    /// Inert MenuActions conformer — these tests assert wiring (selector +
    /// target + enablement), never behavior.
    private final class RecordingActions: NSObject, MenuActions {
        func openLoombre() {}
        func startLoombre() {}
        func stopServer() {}
        func shutdownLoombre() {}
        func revealCrashFiles() {}
    }

    private let actions = RecordingActions()

    private func build(
        state: MenuIconState,
        webUrl: String? = nil,
        isConnected: Bool = false,
        launchdStartInFlight: Bool = false,
        shutdownInFlight: Bool = false
    ) -> NSMenu {
        MenuBuilder.build(
            context: MenuBuilder.Context(
                state: state,
                webUrl: webUrl,
                isConnected: isConnected,
                launchdStartInFlight: launchdStartInFlight,
                shutdownInFlight: shutdownInFlight,
                buildVersion: "0.0.0-test"
            ),
            target: actions
        )
    }

    private func item(_ menu: NSMenu, titled prefix: String) -> NSMenuItem {
        guard let found = menu.items.first(where: { $0.title.hasPrefix(prefix) }) else {
            XCTFail("no menu item titled \"\(prefix)…\" — items: \(menu.items.map(\.title))")
            return NSMenuItem()
        }
        return found
    }

    // THE regression pin. Without this line, AppKit's default
    // autoenablement overrides every isEnabled assertion below at
    // display time, however green they look in a unit test.
    func testAutoenablementIsOff() {
        XCTAssertFalse(build(state: .running, isConnected: true).autoenablesItems)
    }

    func testDisconnectedNotRunning_ipcItemsDisabledButStartWorks() {
        let menu = build(state: .notRunning)

        // No web URL, no connection: both IPC-backed items must read as
        // dead BEFORE the click, not silently swallow it after.
        XCTAssertFalse(item(menu, titled: "Open Loombre").isEnabled)
        XCTAssertFalse(item(menu, titled: "Reveal Crash Files").isEnabled)

        // The launchd Start path needs no connection — the rc "always
        // grayed out" lesson, preserved.
        let start = item(menu, titled: "Start Loombre")
        XCTAssertTrue(start.isEnabled)
        XCTAssertEqual(start.action, #selector(MenuActions.startLoombre))
        XCTAssertTrue(start.target === actions)

        // The kill switch must never depend on the thing it kills.
        XCTAssertTrue(item(menu, titled: "Shut Down Loombre").isEnabled)
    }

    func testConnectedRunning_everyActionRoutesToItsSelector() {
        let menu = build(state: .running, webUrl: "http://localhost:3000", isConnected: true)

        let open = item(menu, titled: "Open Loombre")
        XCTAssertTrue(open.isEnabled)
        XCTAssertEqual(open.action, #selector(MenuActions.openLoombre))
        XCTAssertTrue(open.target === actions)

        let stop = item(menu, titled: "Stop Server")
        XCTAssertTrue(stop.isEnabled)
        XCTAssertEqual(stop.action, #selector(MenuActions.stopServer))

        let reveal = item(menu, titled: "Reveal Crash Files")
        XCTAssertTrue(reveal.isEnabled)
        XCTAssertEqual(reveal.action, #selector(MenuActions.revealCrashFiles))
        XCTAssertTrue(reveal.target === actions)

        let shutdown = item(menu, titled: "Shut Down Loombre")
        XCTAssertEqual(shutdown.action, #selector(MenuActions.shutdownLoombre))
    }

    // The old builder assigned #selector(startLoombre) even when the plan
    // said action == .none — combined with autoenablement, a "Stop
    // Server"-titled item in a transitional state could trigger the
    // admin-prompt launchd start. A no-action plan must yield NO selector.
    func testTransitionalState_lifecycleItemHasNoAction() {
        let menu = build(state: .starting, isConnected: true)
        let lifecycle = item(menu, titled: "Stop Server")
        XCTAssertFalse(lifecycle.isEnabled)
        XCTAssertNil(lifecycle.action)
    }

    func testInfoRowsStayInert() {
        let menu = build(state: .running, isConnected: true)
        let status = item(menu, titled: MenuState.statusLabel(for: .running))
        XCTAssertFalse(status.isEnabled)
        XCTAssertNil(status.action)

        let version = item(menu, titled: "Loombre Controller v0.0.0-test")
        XCTAssertFalse(version.isEnabled)
        XCTAssertNil(version.action)
    }

    func testInFlightGuards_titlesAndDisablement() {
        let starting = build(state: .notRunning, launchdStartInFlight: true)
        XCTAssertFalse(item(starting, titled: "Starting…").isEnabled)

        let shuttingDown = build(state: .running, isConnected: true, shutdownInFlight: true)
        XCTAssertFalse(item(shuttingDown, titled: "Shutting Down…").isEnabled)
    }

    func testQuitIsAlwaysAvailable() {
        let quit = item(build(state: .notRunning), titled: "Quit")
        XCTAssertTrue(quit.isEnabled)
        XCTAssertEqual(quit.action, #selector(NSApplication.terminate(_:)))
        XCTAssertEqual(quit.keyEquivalent, "q")
    }
}
