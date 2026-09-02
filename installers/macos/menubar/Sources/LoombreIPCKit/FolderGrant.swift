// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/FolderGrant.swift
//
// The loombre://grant URL scheme — the no-Terminal half of the folder
// picker's media-permissions flow. A browser (which may not even be on
// this Mac) cannot change permissions, and the _loombre daemon must never
// be able to change permissions on the user's home — that isolation is the
// point of the service account. This app runs AS the signed-in user, and
// macOS lets a folder's owner add ACL entries with no password, so it can
// apply the exact grant the server's FilesystemPermissionRemediation
// recipe describes, behind a native consent dialog.
//
// TRUST MODEL. Any web page can open a custom-scheme URL, so the URL is a
// REQUEST, never authority. This file re-derives the grant from the request
// under the same policy the server applies (never a whole-home read, never
// a TCC-protected folder, traversal only on the signed-in user's own home),
// and AppDelegate shows the resulting operations in a consent dialog before
// FolderGrantApplier runs anything. The worst a hostile page can achieve is
// a dialog asking the user to let their own Loombre server read a folder
// they own — with a Cancel button.
//
// Pure: no filesystem, no AppKit — every decision is testable from a URL
// plus a console-home path (Tests/LoombreIPCKitTests/FolderGrantTests).

import Foundation

public enum FolderGrantScope: String, Equatable, Sendable {
    /// Step 1 for a home folder: the names of its direct children only,
    /// nothing inherited (the `list,search` ACE).
    case namesOnly = "names-only"
    /// Step 2, or any other folder: read now, inherited by everything added
    /// later.
    case read
}

/// One `chmod +a "<ace>" <path>` — the exact argv, no shell involved.
public struct FolderGrantOperation: Equatable, Sendable {
    public let path: String
    public let ace: String
    /// `chmod -R`: applies the entry to files and subfolders that already
    /// exist, not only the named folder. True for the media-folder read
    /// grant (whose inherit flags otherwise cover only what is added
    /// later); false for the single-directory traverse and names-only
    /// grants, which must never recurse into a home folder.
    public let recursive: Bool

    public init(path: String, ace: String, recursive: Bool = false) {
        self.path = path
        self.ace = ace
        self.recursive = recursive
    }

    private var flag: [String] { recursive ? ["-R"] : [] }

    public var chmodArguments: [String] { flag + ["+a", ace, path] }

    /// The documented equivalent (docs/install/macos.md), for the failure
    /// dialog's "run this by hand" line.
    public var shellCommand: String {
        "chmod \(recursive ? "-R " : "")+a \"\(ace)\" \(FolderGrant.shellQuote(path))"
    }

    /// The matching revoke, so the consent dialog can say how to undo.
    public var undoShellCommand: String {
        "chmod \(recursive ? "-R " : "")-a \"\(ace)\" \(FolderGrant.shellQuote(path))"
    }
}

public struct FolderGrantPlan: Equatable, Sendable {
    public let scope: FolderGrantScope
    public let path: String
    public let operations: [FolderGrantOperation]
    public let consentTitle: String
    public let consentDetail: String

    public init(scope: FolderGrantScope, path: String, operations: [FolderGrantOperation], consentTitle: String, consentDetail: String) {
        self.scope = scope
        self.path = path
        self.operations = operations
        self.consentTitle = consentTitle
        self.consentDetail = consentDetail
    }
}

public enum FolderGrantRefusal: Equatable, Error, Sendable {
    /// Not a loombre://grant?v=1 URL with a usable path and scope.
    case malformed(reason: String)
    case notAbsolute(path: String)
    /// scope=read on the signed-in user's home itself — the one grant this
    /// app will never make: it would hand ~/.ssh and ~/Library to the
    /// service in a single click.
    case wholeHomeRead(home: String)
    /// scope=names-only anywhere but the signed-in user's own home.
    case namesOnlyOutsideHome(home: String)
    /// Desktop / Documents / Downloads are TCC, not permissions — an ACL
    /// cannot help; only Full Disk Access for the service can.
    case tccProtected(folder: String)
    /// `traverse` naming anything but the signed-in user's own home, or
    /// present for a path outside it.
    case traversalNotHome(home: String)
}

public enum FolderGrant {
    public static let scheme = "loombre"
    public static let host = "grant"
    public static let version = "1"
    public static let serviceAccount = "_loombre"

    // Byte-identical to the server's recipe (apps/server/src/catalog/
    // admin-directories.ts) and docs/install/macos.md's commands.
    public static let namesOnlyACE = "user:_loombre allow list,search"
    public static let traverseACE = "user:_loombre allow search"
    public static let readACE = "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit"

    static let tccProtectedHomeSubfolders: Set<String> = ["desktop", "documents", "downloads"]

    public static func isGrantURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme && url.host?.lowercased() == host
    }

    /// The whole policy, as data: a plan to consent to, or a refusal to
    /// explain. `consoleHome` is the signed-in user's home as the app sees
    /// it (FileManager.homeDirectoryForCurrentUser).
    public static func plan(url: URL, consoleHome: String) -> Result<FolderGrantPlan, FolderGrantRefusal> {
        guard isGrantURL(url) else {
            return .failure(.malformed(reason: "not a \(scheme)://\(host) URL"))
        }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return .failure(.malformed(reason: "unparseable URL"))
        }
        var query: [String: String] = [:]
        for item in components.queryItems ?? [] where query[item.name] == nil {
            query[item.name] = item.value ?? ""
        }
        guard query["v"] == version else {
            return .failure(.malformed(reason: "unsupported request version \(query["v"] ?? "(none)")"))
        }
        guard let rawPath = query["path"], !rawPath.isEmpty else {
            return .failure(.malformed(reason: "missing path"))
        }
        guard let rawScope = query["scope"], let scope = FolderGrantScope(rawValue: rawScope) else {
            return .failure(.malformed(reason: "missing or unknown scope"))
        }
        guard rawPath.hasPrefix("/") else {
            return .failure(.notAbsolute(path: rawPath))
        }

        let path = normalize(rawPath)
        let home = normalize(consoleHome)
        guard path != "/" else {
            return .failure(.malformed(reason: "the filesystem root is not a media folder"))
        }

        switch scope {
        case .namesOnly:
            guard isSamePath(path, home) else {
                return .failure(.namesOnlyOutsideHome(home: home))
            }
            guard query["traverse"] == nil else {
                return .failure(.malformed(reason: "traverse is not valid with scope=names-only"))
            }
            let operation = FolderGrantOperation(path: path, ace: namesOnlyACE)
            return .success(FolderGrantPlan(
                scope: .namesOnly,
                path: path,
                operations: [operation],
                consentTitle: "Let Loombre\u{2019}s service see what\u{2019}s in your home folder?",
                consentDetail:
                    "Loombre\u{2019}s service account (\(serviceAccount)) will be able to list the names of the folders directly inside \(path) \u{2014} nothing inside them, and nothing added later.\n\n"
                    + "Next, choose your media folder in Loombre; it will ask again, for that folder only.\n\n"
                    + "Undo at any time in Terminal:\n\(operation.undoShellCommand)"
            ))

        case .read:
            if isSamePath(path, home) {
                return .failure(.wholeHomeRead(home: home))
            }
            let insideHome = isDescendant(path, of: home)
            if insideHome, let first = firstSegment(of: path, below: home),
               tccProtectedHomeSubfolders.contains(first.lowercased()) {
                return .failure(.tccProtected(folder: first))
            }
            var operations: [FolderGrantOperation] = []
            if let rawTraverse = query["traverse"] {
                guard insideHome, isSamePath(normalize(rawTraverse), home) else {
                    return .failure(.traversalNotHome(home: home))
                }
                operations.append(FolderGrantOperation(path: home, ace: traverseACE))
            }
            let readOperation = FolderGrantOperation(path: path, ace: readACE, recursive: true)
            operations.append(readOperation)

            var detail = "Loombre\u{2019}s service account (\(serviceAccount)) will be able to read \(path), everything already in it, and everything added to it later."
            if operations.count == 2 {
                detail += "\n\nIt will also be allowed to pass through \(home) to reach it \u{2014} without seeing anything else there."
            }
            if insideHome {
                detail += "\n\nNothing else in your home folder becomes visible."
            }
            detail += "\n\nUndo at any time in Terminal:\n\(readOperation.undoShellCommand)"
            return .success(FolderGrantPlan(
                scope: .read,
                path: path,
                operations: operations,
                consentTitle: "Let Loombre\u{2019}s service read \u{201C}\(lastComponent(of: path))\u{201D}?",
                consentDetail: detail
            ))
        }
    }

    /// Title + detail for a refusal dialog. Pure so the wording is pinned.
    public static func explain(_ refusal: FolderGrantRefusal) -> (title: String, detail: String) {
        switch refusal {
        case .malformed(let reason):
            return ("Loombre couldn\u{2019}t understand this request", "The link that opened Loombre isn\u{2019}t a valid folder-access request (\(reason)). Nothing was changed.")
        case .notAbsolute(let path):
            return ("Loombre couldn\u{2019}t understand this request", "\u{201C}\(path)\u{201D} is not an absolute folder path. Nothing was changed.")
        case .wholeHomeRead(let home):
            return (
                "Loombre won\u{2019}t grant access to your whole home folder",
                "Granting read access on \(home) itself would expose everything in it, including private folders like Library and .ssh. Choose the media folder inside your home instead, or keep media on an external drive (/Volumes) or in /Users/Shared. Nothing was changed."
            )
        case .namesOnlyOutsideHome(let home):
            return ("Loombre couldn\u{2019}t understand this request", "A names-only grant applies only to your own home folder (\(home)). Nothing was changed.")
        case .tccProtected(let folder):
            return (
                "\(folder) is protected by macOS privacy settings",
                "Desktop, Documents and Downloads are guarded by macOS itself (Transparency, Consent and Control), which a permission grant cannot lift. Keep media in another folder \u{2014} a \u{201C}Media\u{201D} folder in your home works \u{2014} or give Loombre\u{2019}s runtime Full Disk Access in System Settings \u{203A} Privacy & Security. Nothing was changed."
            )
        case .traversalNotHome(let home):
            return ("Loombre couldn\u{2019}t understand this request", "The request asked to open a path other than your own home folder (\(home)) for traversal. Nothing was changed.")
        }
    }

    // MARK: - Path helpers (pure; mirror the server's posix normalize + strip)

    /// Collapses `.`/`..`/empty segments and trailing slashes of an
    /// absolute path WITHOUT touching the filesystem — no symlink
    /// resolution, so the folder the user consents to is the folder named.
    public static func normalize(_ path: String) -> String {
        var segments: [String] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            switch segment {
            case ".": continue
            case "..": _ = segments.popLast()
            default: segments.append(String(segment))
            }
        }
        return "/" + segments.joined(separator: "/")
    }

    /// The default macOS volume is case-insensitive: /users/ozzy and
    /// /Users/ozzy are the same folder.
    static func isSamePath(_ a: String, _ b: String) -> Bool {
        a.caseInsensitiveCompare(b) == .orderedSame
    }

    static func isDescendant(_ path: String, of ancestor: String) -> Bool {
        let prefix = ancestor == "/" ? "/" : ancestor + "/"
        return path.count > prefix.count && path.lowercased().hasPrefix(prefix.lowercased())
    }

    static func firstSegment(of path: String, below ancestor: String) -> String? {
        guard isDescendant(path, of: ancestor) else { return nil }
        let rest = path.dropFirst(ancestor == "/" ? 1 : ancestor.count + 1)
        return rest.split(separator: "/", omittingEmptySubsequences: true).first.map(String.init)
    }

    static func lastComponent(of path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? path
    }

    /// Same rule as the server's shellQuote: bare when made only of
    /// never-quoted characters, else single-quoted with the POSIX
    /// close-escape-reopen trick for embedded single quotes.
    public static func shellQuote(_ value: String) -> String {
        let bare = value.unicodeScalars.allSatisfy { scalar in
            ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
                || scalar == "_" || scalar == "." || scalar == "/" || scalar == "-"
        }
        if bare { return value }
        return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
