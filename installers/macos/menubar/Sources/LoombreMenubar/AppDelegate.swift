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

/// UserDefaults key for the per-install post-install browser open — lives
/// in this app's own com.loombre.menubar defaults domain. Stores the LAST
/// install's stamp (InstallStamp.read()'s epoch-ms string for
/// /opt/loombre/current), not a bool: the installer recreates that symlink
/// on EVERY install/upgrade (LAYOUT.md §1's atomic swap point), so a stamp
/// that differs from what's stored here means "this is a different install
/// than the one we last auto-opened for." Replaces the old
/// once-per-USER-forever bool (`didAutoOpenWebOnFirstRun`), which left
/// every reinstall/upgrade after the very first one contradicting the
/// conclusion pane's "Your browser will open automatically" promise (rc.6
/// field report).
let autoOpenWebInstallStampKey = "lastAutoOpenedWebInstallStamp"

final class AppDelegate: NSObject, NSApplicationDelegate, MenuActions {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private var lastStatus: IPCStatusResponse?
    private var lastConnection: IPCConnection?
    /// True while the launchctl admin prompt is up or the daemon it just
    /// started hasn't been observed running yet — keeps a second click
    /// from stacking credential prompts.
    private var launchdStartInFlight = false
    /// Same stacking guard for the full-shutdown path ("Shut Down
    /// Loombre…"). On success the app terminates, so this only ever
    /// resets on cancel/failure.
    private var shutdownInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // No Dock icon, no Cmd-Tab entry — menu-bar-only utility. Works
        // even without a proper .app bundle's LSUIElement Info.plist key
        // (build-pkg.mjs's bundling step sets that too, belt-and-suspenders).
        NSApp.setActivationPolicy(.accessory)

        // One-line migration hygiene: the old once-per-user bool key is
        // dead now that the gate is per-install — drop it so it doesn't
        // linger forever in this domain. Runs once per PROCESS launch here
        // (this used to live in autoOpenWebOnFirstRunIfNeeded, called from
        // every successful poll — a UserDefaults mutation every
        // pollIntervalSeconds forever for no reason after the first call).
        UserDefaults.standard.removeObject(forKey: "didAutoOpenWebOnFirstRun")

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

    /// The user's escape hatch when the menu bar icon can't be found (field
    /// report, 2026-08-08): double-clicking Loombre.app in /Applications —
    /// or a Dock/Launchpad reopen — previously did NOTHING, because
    /// LaunchServices just activates this already-running LSUIElement
    /// instance, which has no window to bring forward, so no UI resulted.
    /// That specifically stranded users during the incident where macOS
    /// 26's Control Center scene host wedged and hid every
    /// newly-registered menu bar item system-wide: the icon was gone, and
    /// reopening the app was a dead end too. Now it opens the web UI
    /// directly — via the live IPC connection's actual openWebTarget()
    /// when one exists (reusing openLoombre()'s own flow, not duplicating
    /// it), or the installed default (:3000) when IPC is unreachable and
    /// the operator's configured URL can't be resolved. Returns false
    /// unconditionally: this is an LSUIElement app with no windows for
    /// AppKit to restore.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        switch MenuState.reopenAction(isConnected: lastConnection != nil) {
        case .resolveViaIPC:
            openLoombre()
        case .openFallback(let url):
            if let url = URL(string: url) {
                NSWorkspace.shared.open(url)
            }
        }
        return false
    }

    // MARK: - loombre://grant (folder-access consent flow)

    /// URL-scheme entry point (build-pkg.mjs's Info.plist registers
    /// `loombre`). The web folder picker's "Allow in Loombre" button opens
    /// `loombre://grant?v=1&scope=…&path=…` when the browser is on this
    /// Mac. The URL is a REQUEST, not authority — FolderGrant re-derives
    /// the grant under the server's own policy, preflight proves it can be
    /// made at all, and the user consents to the exact operations before
    /// FolderGrantApplier runs the documented chmod +a. Anything else the
    /// scheme is asked to do is ignored.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where FolderGrant.isGrantURL(url) {
            handleGrantRequest(url)
        }
    }

    @MainActor
    private func handleGrantRequest(_ url: URL) {
        // LSUIElement app: without this the dialog opens BEHIND the browser
        // that just handed us the URL.
        NSApp.activate(ignoringOtherApps: true)
        let home = FileManager.default.homeDirectoryForCurrentUser.path

        let plan: FolderGrantPlan
        switch FolderGrant.plan(url: url, consoleHome: home) {
        case .failure(let refusal):
            presentRefusal(refusal)
            return
        case .success(let planned):
            plan = planned
        }

        switch FolderGrantApplier.preflight(plan) {
        case .ok:
            break
        case .missing(let path):
            presentProblem(title: "That folder doesn\u{2019}t exist", detail: "\(path) was not found on this Mac. Nothing was changed.")
            return
        case .notADirectory(let path):
            presentProblem(title: "That isn\u{2019}t a folder", detail: "\(path) is a file, not a folder. Nothing was changed.")
            return
        case .notOwned(let path, _):
            presentProblem(
                title: "You don\u{2019}t own that folder",
                detail: "Only a folder\u{2019}s owner can grant access to it, and \(path) belongs to another account. Run the command from the install guide as that account (or with sudo). Nothing was changed."
            )
            return
        }

        let consent = NSAlert()
        consent.messageText = plan.consentTitle
        consent.informativeText = plan.consentDetail
        consent.alertStyle = .informational
        consent.addButton(withTitle: "Allow")
        consent.addButton(withTitle: "Cancel")
        guard consent.runModal() == .alertFirstButtonReturn else { return }

        switch FolderGrantApplier.apply(plan) {
        case .success:
            // No success dialog: the folder picker that sent us here
            // re-checks on its own and shows the listing.
            break
        case .failed(let operation, let message):
            presentProblem(
                title: "Could not grant access",
                detail: "\(message)\n\nYou can run it by hand in Terminal:\n\(operation.shellCommand)"
            )
        }
    }

    @MainActor
    private func presentRefusal(_ refusal: FolderGrantRefusal) {
        let explanation = FolderGrant.explain(refusal)
        let alert = NSAlert()
        alert.messageText = explanation.title
        alert.informativeText = explanation.detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        if case .tccProtected = refusal {
            // The one refusal with a next step this app can open directly:
            // Full Disk Access, the only thing that lifts TCC for a daemon.
            alert.addButton(withTitle: "Open Privacy & Security")
            if alert.runModal() == .alertSecondButtonReturn,
               let settings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
                NSWorkspace.shared.open(settings)
            }
            return
        }
        alert.runModal()
    }

    @MainActor
    private func presentProblem(title: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.runModal()
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
        // All construction (incl. the load-bearing autoenablesItems=false)
        // lives in MenuBuilder so Tests/LoombreMenubarTests can pin the
        // wiring — the layer the "menu items silently no-op" field report
        // shipped through.
        statusItem.menu = MenuBuilder.build(
            context: MenuBuilder.Context(
                state: state,
                webUrl: lastStatus?.webUrl,
                isConnected: lastConnection != nil,
                launchdStartInFlight: launchdStartInFlight,
                shutdownInFlight: shutdownInFlight,
                buildVersion: menubarBuildVersion
            ),
            target: self
        )
    }

    // MARK: - Actions

    @objc func openLoombre() {
        guard let connection = lastConnection else { return }
        Task {
            do {
                let response = try await IPCClient(connection: connection).openWebTarget()
                if let url = URL(string: response.url) {
                    await MainActor.run { NSWorkspace.shared.open(url) }
                }
            } catch {
                // lastConnection being non-nil only means the LAST poll (up
                // to pollIntervalSeconds ago) succeeded — the server can be
                // wedged or mid-restart by the time this actual IPC call
                // fires, and swallowing that silently reproduces the exact
                // "click Open Loombre, nothing happens" bug this menu item
                // exists to fix. A user-initiated "open the UI" action must
                // always open SOMETHING, so fall back to the same installed
                // default reopenAction uses when there's no connection at
                // all — one shared constant (MenuState.installedDefaultWebUrl),
                // one fallback everywhere IPC can't answer.
                if let url = URL(string: MenuState.installedDefaultWebUrl) {
                    await MainActor.run { NSWorkspace.shared.open(url) }
                }
            }
        }
    }

    @objc func startLoombre() {
        // The IPC start endpoint can never start a stopped server
        // (IPC_SERVER_START_SEMANTICS: it is hosted BY the server), so
        // Start always goes through launchd, connection or not — and it
        // starts all three daemons, so it also recovers from a full
        // Shut Down (which boots the worker and web daemons out too).
        guard !launchdStartInFlight, !shutdownInFlight else { return }
        launchdStartInFlight = true
        rebuildMenu(for: lastStatus.map(MenuState.derive(from:)) ?? MenuState.deriveFromUnreachable())
        Task { @MainActor in
            let outcome = PrivilegedLaunchctl.startAll()
            switch outcome {
            case .success:
                // Leave launchdStartInFlight set — poll() clears it when
                // the daemon is observed running, so the item shows
                // "Starting…" instead of a misleading enabled "Start".
                break
            case .cancelled:
                launchdStartInFlight = false
            case .failed(let message):
                launchdStartInFlight = false
                let alert = NSAlert()
                alert.messageText = "Could not start Loombre"
                alert.informativeText = "\(message)\n\nYou can start the services manually with:\nsudo launchctl kickstart system/\(LaunchdFallback.serverLabel)\nsudo launchctl kickstart system/\(LaunchdFallback.workerLabel)\nsudo launchctl kickstart system/\(LaunchdFallback.webLabel)"
                alert.alertStyle = .warning
                alert.runModal()
            }
            await poll()
        }
    }

    @objc func stopServer() {
        guard let connection = lastConnection else { return }
        Task {
            _ = try? await IPCClient(connection: connection).stopServer()
            await poll()
        }
    }

    /// The full kill switch: confirmation dialog → admin-privileged
    /// bootout of all three daemons → quit this controller too, so
    /// nothing of Loombre is left running ("shut down completely"). The
    /// daemons return at the next boot (RunAtLoad) or via Start Loombre;
    /// the menubar returns at next login or by opening Loombre.app.
    @objc func shutdownLoombre() {
        guard !shutdownInFlight, !launchdStartInFlight else { return }
        let confirm = NSAlert()
        confirm.messageText = "Shut down Loombre completely?"
        confirm.informativeText = "This stops the Loombre server, the background worker, and the web interface — streaming stops for every device using this server — and then quits this menu bar controller.\n\nmacOS will ask for administrator authorization. To use Loombre again, open Loombre from your Applications folder and choose \u{201C}Start Loombre\u{201D}, or restart your Mac (the services start automatically at boot)."
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: "Shut Down")
        confirm.addButton(withTitle: "Cancel")
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        shutdownInFlight = true
        rebuildMenu(for: lastStatus.map(MenuState.derive(from:)) ?? MenuState.deriveFromUnreachable())
        Task { @MainActor in
            let outcome = PrivilegedLaunchctl.shutdownAll()
            switch outcome {
            case .success:
                // Nothing left to control, and the point was "everything
                // off" — quit. The com.loombre.menubar LaunchAgent has no
                // KeepAlive, so this stays quit until the next login.
                NSApp.terminate(nil)
            case .cancelled:
                shutdownInFlight = false
                rebuildMenu(for: lastStatus.map(MenuState.derive(from:)) ?? MenuState.deriveFromUnreachable())
            case .failed(let message):
                shutdownInFlight = false
                let alert = NSAlert()
                alert.messageText = "Could not shut down Loombre"
                alert.informativeText = "\(message)\n\nYou can stop the services manually with:\nsudo launchctl bootout system/\(LaunchdFallback.workerLabel)\nsudo launchctl bootout system/\(LaunchdFallback.webLabel)\nsudo launchctl bootout system/\(LaunchdFallback.serverLabel)"
                alert.alertStyle = .warning
                alert.runModal()
                await poll()
            }
        }
    }

    /// Installer completion flow (see pkg/resources/conclusion.txt): the
    /// pkg's postinstall bootstraps this agent while the Installer window
    /// is still open; the first time the server advertises a web URL for
    /// THIS install, we open the browser — on a fresh install that lands on
    /// the /setup first-run wizard (the web root auto-routes there while no
    /// account exists). Once per INSTALL, not once per user ever: keyed to
    /// /opt/loombre/current's own mtime (InstallStamp), which every install
    /// AND upgrade refreshes, so the conclusion pane's promise holds on
    /// every install, not just the first one this Mac ever saw. A nil
    /// InstallStamp means this process isn't running from an installed
    /// layout (e.g. a dev `swift run` outside the pkg) — never auto-open in
    /// that case, since there's no install to key the decision off of.
    @MainActor
    private func autoOpenWebOnFirstRunIfNeeded(status: IPCStatusResponse) {
        let defaults = UserDefaults.standard
        let currentStamp = InstallStamp.read()
        guard MenuState.shouldAutoOpenWeb(
            lastOpenedStamp: defaults.string(forKey: autoOpenWebInstallStampKey),
            currentStamp: currentStamp,
            webUrl: status.webUrl
        ) else { return }
        guard let webUrl = status.webUrl, let url = URL(string: webUrl) else { return }
        defaults.set(currentStamp, forKey: autoOpenWebInstallStampKey)
        NSWorkspace.shared.open(url)
    }

    /// Every branch produces visible feedback (Windows-tray parity —
    /// OnRevealCrashClicked dialogs on both the empty list and errors).
    /// The old version had three silent returns, and the empty-list one
    /// fired on EVERY healthy install: zero crashes ever recorded is the
    /// steady state, so "Reveal Crash Files" clicked as a pure no-op —
    /// the macOS live-test "menu bar isn't wired" field report.
    @objc func revealCrashFiles() {
        // Backstop only: MenuBuilder disables the item when disconnected,
        // and with autoenablesItems=false that disablement actually holds.
        guard let connection = lastConnection else { return }
        Task { @MainActor in
            do {
                let response = try await IPCClient(connection: connection).crashFiles()
                switch response.revealPlan {
                case .reveal(let paths):
                    NSWorkspace.shared.activateFileViewerSelecting(paths.map { URL(fileURLWithPath: $0) })
                case .noneFound:
                    let alert = NSAlert()
                    alert.messageText = "No crash files found"
                    alert.informativeText = "Loombre hasn't recorded any crashes on this Mac — that's the healthy state. If one ever happens, its report will appear in \(LoombreAppPaths.crashesDir) and this menu item will reveal it."
                    alert.alertStyle = .informational
                    alert.runModal()
                }
            } catch {
                let alert = NSAlert()
                alert.messageText = "Could not list crash files"
                alert.informativeText = "The Loombre server didn't answer the crash-file query: \(error.localizedDescription)\n\nYou can look in \(LoombreAppPaths.crashesDir) directly."
                alert.alertStyle = .warning
                alert.runModal()
            }
        }
    }
}
