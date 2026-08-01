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
/// P4.11 single-source version stamping, landed: build-pkg.mjs's
/// buildMenubar() regenerates Sources/LoombreMenubar/GeneratedVersion.swift
/// from root package.json before every `swift build`, so this is never a
/// hand-synced literal again. The checked-in GeneratedVersion.swift holds
/// a dev placeholder for bare `swift build` runs outside the pkg pipeline.
let menubarBuildVersion = loombreGeneratedVersion

let pollIntervalSeconds: TimeInterval = 3.0

/// UserDefaults key for the once-per-user post-install browser open —
/// lives in this app's own com.loombre.menubar defaults domain.
let autoOpenWebDefaultsKey = "didAutoOpenWebOnFirstRun"

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private var lastStatus: IPCStatusResponse?
    private var lastConnection: IPCConnection?
    /// True while the launchctl admin prompt is up or the daemon it just
    /// started hasn't been observed running yet — keeps a second click
    /// from stacking credential prompts.
    private var launchdStartInFlight = false

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
            if state == .running {
                launchdStartInFlight = false
            }
            applyState(state)
            rebuildMenu(for: state)
            autoOpenWebOnFirstRunIfNeeded(status: status)
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

        // Decision table in LoombreIPCKit (LifecyclePlanTests) — the old
        // inline condition here required a live IPC connection to enable
        // "Start Server", i.e. required the server to be running in order
        // to offer starting it (the rc "always grayed out" field report).
        let plan = MenuState.lifecyclePlan(isConnected: lastConnection != nil, state: state)
        let lifecycleItem = NSMenuItem(
            title: launchdStartInFlight && plan.action == .startViaLaunchd ? "Starting…" : plan.title,
            action: plan.action == .stopViaIpc ? #selector(stopServer) : #selector(startServer),
            keyEquivalent: ""
        )
        lifecycleItem.target = self
        lifecycleItem.isEnabled = plan.isEnabled && !(launchdStartInFlight && plan.action == .startViaLaunchd)
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
        // The IPC start endpoint can never start a stopped server
        // (IPC_SERVER_START_SEMANTICS: it is hosted BY the server), so
        // Start always goes through launchd, connection or not.
        guard !launchdStartInFlight else { return }
        launchdStartInFlight = true
        rebuildMenu(for: lastStatus.map(MenuState.derive(from:)) ?? MenuState.deriveFromUnreachable())
        Task { @MainActor in
            let outcome = PrivilegedLaunchdStart.startServer()
            switch outcome {
            case .started:
                // Leave launchdStartInFlight set — poll() clears it when
                // the daemon is observed running, so the item shows
                // "Starting…" instead of a misleading enabled "Start".
                break
            case .cancelled:
                launchdStartInFlight = false
            case .failed(let message):
                launchdStartInFlight = false
                let alert = NSAlert()
                alert.messageText = "Could not start the Loombre server"
                alert.informativeText = "\(message)\n\nYou can start it manually with:\nsudo launchctl kickstart system/\(LaunchdFallback.serverLabel)"
                alert.alertStyle = .warning
                alert.runModal()
            }
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

    /// Installer completion flow (see pkg/resources/conclusion.txt): the
    /// pkg's postinstall bootstraps this agent while the Installer window
    /// is still open; the first time the server advertises a web URL we
    /// open the browser — on a fresh install that lands on the /setup
    /// first-run wizard (the web root auto-routes there while no account
    /// exists). Once per user, ever — UserDefaults-guarded, so upgrades
    /// and later logins never spawn surprise tabs.
    @MainActor
    private func autoOpenWebOnFirstRunIfNeeded(status: IPCStatusResponse) {
        let defaults = UserDefaults.standard
        guard MenuState.shouldAutoOpenWeb(
            alreadyOpened: defaults.bool(forKey: autoOpenWebDefaultsKey),
            webUrl: status.webUrl
        ) else { return }
        guard let webUrl = status.webUrl, let url = URL(string: webUrl) else { return }
        defaults.set(true, forKey: autoOpenWebDefaultsKey)
        NSWorkspace.shared.open(url)
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
