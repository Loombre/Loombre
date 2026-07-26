// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreMenubar/AppDelegate.swift
//
// Plain AppKit menubar controller — NSStatusItem + NSMenu, no SwiftUI (per
// the lane brief). All IPC/menu-state logic lives in LoombreIPCKit and is
// unit tested there (Tests/LoombreIPCKitTests); this file is intentionally
// thin — it owns exactly the AppKit plumbing (status item, menu building,
// NSWorkspace calls) that LoombreIPCKit deliberately stays free of.

import AppKit
import LoombreIPCKit

/// Baked build version for the "version" half of the mission's "version +
/// contract-version mismatch notice" menu item. SYNC NOTE: no Info.plist
/// exists for a bare `swift build` SPM executable to read
/// CFBundleShortVersionString from, and build-pkg.mjs's app-bundling step
/// does not (yet) inject this at build time — mirrors root package.json's
/// "version" field by hand, same discipline as ContractVersion.swift.
/// STATE.md P4.11 assigns real single-source version stamping to lane I;
/// once it lands this becomes a build-time substitution instead of a
/// hand-synced literal.
let menubarBuildVersion = "0.0.1"

let pollIntervalSeconds: TimeInterval = 3.0

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private var lastStatus: IPCStatusResponse?
    private var lastConnection: IPCConnection?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // No Dock icon, no Cmd-Tab entry — menu-bar-only utility. Works
        // even without a proper .app bundle's LSUIElement Info.plist key
        // (build-pkg.mjs's bundling step sets that too, belt-and-suspenders).
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        applyState(.notRunning)
        rebuildMenu(for: .notRunning)

        pollTimer = Timer.scheduledTimer(withTimeInterval: pollIntervalSeconds, repeats: true) { [weak self] _ in
            Task { await self?.poll() }
        }
        Task { await poll() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
    }

    // MARK: - Polling

    @MainActor
    private func poll() async {
        do {
            let connection = try DiscoveryReader.load()
            lastConnection = connection
            let client = IPCClient(connection: connection)
            let status = try await client.fetchStatus()
            lastStatus = status
            let state = MenuState.derive(from: status)
            applyState(state)
            rebuildMenu(for: state)
        } catch {
            lastStatus = nil
            lastConnection = nil
            let state = MenuState.deriveFromUnreachable()
            applyState(state)
            rebuildMenu(for: state)
        }
    }

    // MARK: - UI

    private func applyState(_ state: MenuIconState) {
        guard let button = statusItem.button else { return }
        let symbolName = MenuState.symbolName(for: state)
        button.image = NSImage(
            systemSymbolName: symbolName,
            accessibilityDescription: MenuState.statusLabel(for: state)
        )
    }

    private func rebuildMenu(for state: MenuIconState) {
        let menu = NSMenu()

        let statusMenuItem = NSMenuItem(title: MenuState.statusLabel(for: state), action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        let openItem = NSMenuItem(title: "Open Loombre", action: #selector(openLoombre), keyEquivalent: "o")
        openItem.target = self
        openItem.isEnabled = lastStatus?.webUrl != nil
        menu.addItem(openItem)

        let isRunning = lastStatus?.server.state == .running || lastStatus?.server.state == .starting
        let lifecycleItem = isRunning
            ? NSMenuItem(title: "Stop Server", action: #selector(stopServer), keyEquivalent: "")
            : NSMenuItem(title: "Start Server", action: #selector(startServer), keyEquivalent: "")
        lifecycleItem.target = self
        lifecycleItem.isEnabled = lastConnection != nil && state.isActionable
        menu.addItem(lifecycleItem)

        menu.addItem(.separator())

        let crashFilesItem = NSMenuItem(title: "Reveal Crash Files", action: #selector(revealCrashFiles), keyEquivalent: "")
        crashFilesItem.target = self
        crashFilesItem.isEnabled = lastConnection != nil
        menu.addItem(crashFilesItem)

        menu.addItem(.separator())

        let versionTitle: String
        if case .contractMismatch(let serverVersion, let clientVersion) = state {
            versionTitle = "Loombre Controller v\(menubarBuildVersion) — contract v\(clientVersion) ≠ server v\(serverVersion)"
        } else {
            versionTitle = "Loombre Controller v\(menubarBuildVersion) — contract v\(controllerIpcContractVersion)"
        }
        let versionItem = NSMenuItem(title: versionTitle, action: nil, keyEquivalent: "")
        versionItem.isEnabled = false
        menu.addItem(versionItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    // MARK: - Actions

    @objc private func openLoombre() {
        guard let connection = lastConnection else { return }
        Task {
            do {
                let response = try await IPCClient(connection: connection).openWebTarget()
                if let url = URL(string: response.url) {
                    await MainActor.run { NSWorkspace.shared.open(url) }
                }
            } catch {
                // Best-effort UI action; nothing to escalate to beyond the
                // status label already shown, which the next poll refreshes.
            }
        }
    }

    @objc private func startServer() {
        guard let connection = lastConnection else { return }
        Task {
            _ = try? await IPCClient(connection: connection).startServer()
            await poll()
        }
    }

    @objc private func stopServer() {
        guard let connection = lastConnection else { return }
        Task {
            _ = try? await IPCClient(connection: connection).stopServer()
            await poll()
        }
    }

    @objc private func revealCrashFiles() {
        guard let connection = lastConnection else { return }
        Task {
            guard let response = try? await IPCClient(connection: connection).crashFiles() else { return }
            let urls = response.sortedByRecency.map { URL(fileURLWithPath: $0.path) }
            guard !urls.isEmpty else { return }
            await MainActor.run { NSWorkspace.shared.activateFileViewerSelecting(urls) }
        }
    }
}
