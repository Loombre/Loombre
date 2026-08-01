// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreMenubar/PrivilegedLaunchdStart.swift
//
// Runs LaunchdFallback.startServerShellCommand with administrator
// privileges via an in-process AppleScript `do shell script ... with
// administrator privileges`. The server is a SYSTEM LaunchDaemon (it runs
// as _loombre, owns the embedded PostgreSQL), so starting it genuinely
// requires admin — this shows macOS's standard "Loombre wants to make
// changes" credential prompt, the same UX as any preference-pane unlock.
//
// NSAppleScript over `Process("/usr/bin/osascript")` deliberately: the
// in-process form attributes the credential prompt to Loombre by name
// rather than to "osascript", and avoids shipping a second launch path.
// NSAppleScript is main-thread-only (documented), so the caller invokes
// this on the main thread and accepts the block-while-prompting tradeoff —
// this app has no windows to freeze, and the 3s poll timer simply resumes
// after the dialog closes.
//
// No SMJobBless/XPC privileged helper: that machinery exists to make
// REPEATED privileged operations promptless. Starting a deliberately
// stopped server is rare enough that a per-click prompt is the honest,
// smaller-attack-surface choice for an unsigned .pkg distribution
// (P4.1's no-Authenticode/no-notarization posture).

import Foundation
import LoombreIPCKit

enum PrivilegedLaunchdStart {
    enum Outcome: Equatable {
        case started
        /// -128 from AppleScript: the user dismissed the credential
        /// prompt. Not an error worth a dialog — they changed their mind.
        case cancelled
        case failed(message: String)
    }

    private static let userCancelledErrorCode = -128

    @MainActor
    static func startServer() -> Outcome {
        // LaunchdFallback.startServerShellCommand is test-pinned to contain
        // no quotes/backslashes, so verbatim embedding cannot break out of
        // the AppleScript string literal.
        let source = "do shell script \"\(LaunchdFallback.startServerShellCommand)\" with administrator privileges"
        guard let script = NSAppleScript(source: source) else {
            return .failed(message: "could not build AppleScript")
        }
        var errorInfo: NSDictionary?
        script.executeAndReturnError(&errorInfo)
        guard let errorInfo else {
            return .started
        }
        if let code = errorInfo[NSAppleScript.errorNumber] as? Int, code == userCancelledErrorCode {
            return .cancelled
        }
        let message = (errorInfo[NSAppleScript.errorMessage] as? String) ?? "unknown AppleScript error"
        return .failed(message: message)
    }
}
