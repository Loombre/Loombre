// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreMenubar/MenuBuilder.swift
//
// Builds the status-item menu from a plain-value Context — split out of
// AppDelegate so the AppKit wiring itself is unit-testable
// (Tests/LoombreMenubarTests), which is the layer the "menu items
// silently no-op" field report shipped through: enablement/action logic
// existed and looked right, but NSMenu's DEFAULT autoenablement
// force-enables any item with a target+action, overriding every manual
// isEnabled assignment at display time. Nothing in here performs an
// action; AppDelegate stays the only place that talks to IPC, launchd,
// and NSWorkspace.

import AppKit
import LoombreIPCKit

/// The clickable actions the menu can route, as an @objc protocol so
/// MenuBuilder references selectors through the protocol (compile-checked)
/// rather than through AppDelegate (untestable without an app).
@objc protocol MenuActions: AnyObject {
    func openLoombre()
    func startLoombre()
    func stopServer()
    func shutdownLoombre()
    func revealCrashFiles()
}

enum MenuBuilder {
    /// Everything the menu's appearance depends on, as plain values.
    struct Context {
        let state: MenuIconState
        let webUrl: String?
        let isConnected: Bool
        let launchdStartInFlight: Bool
        let shutdownInFlight: Bool
        let buildVersion: String
    }

    static func build(context: Context, target: MenuActions?) -> NSMenu {
        let menu = NSMenu()
        // THE load-bearing line (test-pinned): manual enablement only.
        // Without it, AppKit re-enables every item below that has an
        // action, and "grayed out without a connection" silently becomes
        // "clickable, hits a guard-return, does nothing".
        menu.autoenablesItems = false

        let statusMenuItem = NSMenuItem(title: MenuState.statusLabel(for: context.state), action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        let openItem = NSMenuItem(title: "Open Loombre", action: #selector(MenuActions.openLoombre), keyEquivalent: "o")
        openItem.target = target
        openItem.isEnabled = context.webUrl != nil
        menu.addItem(openItem)

        // Decision table in LoombreIPCKit (LifecyclePlanTests) — the old
        // inline condition here required a live IPC connection to enable
        // "Start Server", i.e. required the server to be running in order
        // to offer starting it (the rc "always grayed out" field report).
        let plan = MenuState.lifecyclePlan(isConnected: context.isConnected, state: context.state)
        let lifecycleAction: Selector?
        switch plan.action {
        case .stopViaIpc: lifecycleAction = #selector(MenuActions.stopServer)
        case .startViaLaunchd: lifecycleAction = #selector(MenuActions.startLoombre)
        // No action, no selector — the old builder assigned startLoombre
        // here, which autoenablement could turn into an admin-prompt
        // launchd start from a "Stop Server"-titled item mid-transition.
        case .none: lifecycleAction = nil
        }
        let lifecycleItem = NSMenuItem(
            title: context.launchdStartInFlight && plan.action == .startViaLaunchd ? "Starting…" : plan.title,
            action: lifecycleAction,
            keyEquivalent: ""
        )
        lifecycleItem.target = lifecycleAction == nil ? nil : target
        lifecycleItem.isEnabled = plan.isEnabled && !(context.launchdStartInFlight && plan.action == .startViaLaunchd)
        menu.addItem(lifecycleItem)

        // A kill switch must never depend on the thing it kills: this item
        // is enabled regardless of MenuIconState or IPC reachability — the
        // daemons may well be up while IPC is broken, which is exactly when
        // the operator most needs a way to stop everything (the same lesson
        // as the rc "Start Server permanently grayed out" report, applied
        // in the opposite direction).
        let shutdownItem = NSMenuItem(
            title: context.shutdownInFlight ? "Shutting Down…" : "Shut Down Loombre…",
            action: #selector(MenuActions.shutdownLoombre),
            keyEquivalent: ""
        )
        shutdownItem.target = target
        shutdownItem.isEnabled = !context.shutdownInFlight && !context.launchdStartInFlight
        menu.addItem(shutdownItem)

        menu.addItem(.separator())

        let crashFilesItem = NSMenuItem(
            title: "Reveal Crash Files",
            action: #selector(MenuActions.revealCrashFiles),
            keyEquivalent: ""
        )
        crashFilesItem.target = target
        crashFilesItem.isEnabled = context.isConnected
        menu.addItem(crashFilesItem)

        menu.addItem(.separator())

        let versionTitle: String
        if case .contractMismatch(let serverVersion, let clientVersion) = context.state {
            versionTitle = "Loombre Controller v\(context.buildVersion) — contract v\(clientVersion) ≠ server v\(serverVersion)"
        } else {
            versionTitle = "Loombre Controller v\(context.buildVersion) — contract v\(controllerIpcContractVersion)"
        }
        let versionItem = NSMenuItem(title: versionTitle, action: nil, keyEquivalent: "")
        versionItem.isEnabled = false
        menu.addItem(versionItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        return menu
    }
}
