// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/InstallStamp.swift
//
// The per-install identity behind MenuState.shouldAutoOpenWeb: the rc.6
// field report found the conclusion pane's "Your browser will open to the
// Loombre setup screen automatically" promise broken on every
// reinstall/upgrade after the very first install ever performed on a Mac,
// because the old gate was a UserDefaults bool that, once set, stayed set
// forever. /opt/loombre/current (installers/macos/LAYOUT.md §1) is the
// installer's atomic upgrade swap point, but the symlink itself is laid
// down as PART OF THE PKG PAYLOAD at build time (build-pkg.mjs) — its
// BOM-recorded mtime is the BUILD timestamp, and macOS's installer restores
// BOM mtimes on every run, so re-running the SAME pkg would otherwise stamp
// the identical mtime on every install and auto-open would fire once per
// pkg BUILD, not once per INSTALL. postinstall's `touch -h
// "$OPT_DIR/current"` (installers/macos/pkg/scripts/postinstall, step 4)
// is what actually refreshes the symlink's own mtime on every real
// install/upgrade — this reads that refreshed mtime as the "which install
// is this" stamp.
//
// That requires lstat semantics: FileManager.attributesOfItem(atPath:)
// does NOT follow symlinks, which is what we want here — reading through
// to the versioned directory it resolves to would give a stamp that stays
// stable across an upgrade whose target directory name happens to collide
// with mtime-insensitive comparisons, defeating the point of keying off
// the swap itself.
import Foundation

public enum InstallStamp {
    /// Epoch-milliseconds string of `path`'s own (symlink) modification
    /// date, or nil if nothing lives there (or the mtime is unrepresentable
    /// — see the guard below). A dev run outside an installed layout
    /// (`swift build`/`swift test`, or the app launched without the pkg's
    /// `/opt/loombre` tree) has no such path — nil is exactly the signal
    /// MenuState.shouldAutoOpenWeb needs to never auto-open in that case,
    /// since there is no install to key the decision off of.
    public static func read(atPath path: String = LoombreAppPaths.currentInstallPath) -> String? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let modificationDate = attributes[.modificationDate] as? Date
        else {
            return nil
        }
        let epochMs = (modificationDate.timeIntervalSince1970 * 1000).rounded()
        // Int64(_:) TRAPS on a Double outside Int64's range. A filesystem
        // returning an absurd mtime must never crash the menubar agent —
        // Int64(exactly:) yields nil instead, which callers already treat
        // the same as "no stamp at this path."
        guard let epochMsInt64 = Int64(exactly: epochMs) else { return nil }
        return String(epochMsInt64)
    }
}
