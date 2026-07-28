# Loombre :: installers/macos/homebrew/loombre.rb
#
# Homebrew cask wrapping the SAME unsigned .pkg described in
# docs/install/macos.md — this is a convenience install path, not a
# different build. `--no-quarantine` is REQUIRED at install time (see the
# `caveats` block below and docs/install/macos.md's "Homebrew cask"
# section) because Homebrew otherwise quarantines the extracted .pkg
# before running it, hitting the identical Gatekeeper block a direct
# double-click would (P4.1: unsigned posture, P4.9: documented honestly).
#
# SUBSTITUTION TOKENS (coordinate shape with lane I's release pipeline —
# this is this lane's proposed convention, not yet wired to a real
# publisher):
#   :RELEASE_VERSION:      e.g. "1.2.0" — substituted into `version` below.
#   :RELEASE_SHA256_ARM64:  sha256 of loombre-<version>-macos-arm64.pkg
#   :RELEASE_SHA256_X64:    sha256 of loombre-<version>-macos-x64.pkg
# Matches @loombre/release-manifest's ReleaseArtifact shape exactly
# (packages/release-manifest/src/manifest.ts: platform "macos-arm64" |
# "macos-x64", kind "pkg", sha256, url) — the release pipeline's own
# manifest.json already carries every value these tokens need; this file
# just needs lane I to decide HOW it templates them in (a simple
# find/replace against this file at release-build time is enough, no
# templating engine required).

cask "loombre" do
  arch arm: "arm64", intel: "x64"

  version ":RELEASE_VERSION:"
  sha256 arm:   ":RELEASE_SHA256_ARM64:",
         intel: ":RELEASE_SHA256_X64:"

  url "https://github.com/Loombre/Loombre/releases/download/v#{version}/loombre-#{version}-macos-#{arch}.pkg"
  name "Loombre"
  desc "Self-hosted, ground-up media streaming server (movies, TV, music) — not a Jellyfin/Plex fork"
  homepage "https://github.com/Loombre/Loombre"

  # Unsigned, undocumented in Homebrew's own auto-detected livecheck —
  # skip rather than guess at a strategy that doesn't apply to a
  # hand-published GitHub release without a predictable versioning API.
  livecheck do
    skip "release pipeline not yet landed — no strategy to check against"
  end

  pkg "loombre-#{version}-macos-#{arch}.pkg"

  # Every label the pkg bootstraps must appear here, or `brew uninstall`
  # leaves a live process behind whose files it then deletes out from
  # under it. This list drifted behind the payload once already (the web
  # daemon shipped without ever being added), so: FOUR labels — the three
  # LaunchDaemons plus the com.loombre.menubar LaunchAgent, which runs in
  # the logged-in user's GUI domain rather than the system domain.
  uninstall launchctl: [
              "com.loombre.server",
              "com.loombre.worker",
              "com.loombre.web",
              "com.loombre.menubar",
            ],
            delete: [
              "/opt/loombre",
              "/Applications/Loombre.app",
              "/Library/LaunchDaemons/com.loombre.server.plist",
              "/Library/LaunchDaemons/com.loombre.worker.plist",
              "/Library/LaunchDaemons/com.loombre.web.plist",
              "/Library/LaunchAgents/com.loombre.menubar.plist",
              "/Library/Logs/Loombre",
            ]

  # App-data ("/Library/Application Support/Loombre" — DB config, secrets)
  # is deliberately NOT in `uninstall delete` above, matching
  # docs/install/macos.md's manual-uninstall section: removing a user's
  # data should never be a side effect of an ordinary `brew uninstall`.
  zap trash: [
        "/Library/Application Support/Loombre",
      ]

  caveats do
    <<~EOS
      Loombre is UNSIGNED (no Apple Developer ID — see docs/install/macos.md
      "Why unsigned?" for the full rationale: this project takes no
      revenue and reports no telemetry, so it doesn't carry a $99/year
      signing cost). You MUST install with:

        brew install --cask --no-quarantine loombre

      Without --no-quarantine, Homebrew applies the quarantine attribute
      to the extracted .pkg before running it, and installation will hit
      the same Gatekeeper "could not verify" block a direct download
      would — inside brew's own install step, with a less legible error.

      This installs system LaunchDaemons (com.loombre.server,
      com.loombre.worker) that start at boot, independent of any login
      session, running as a dedicated, unprivileged _loombre service
      account — see installers/macos/LAYOUT.md for the full layout and
      privilege rationale.

      Verify what you're installing yourself — Homebrew's own sha256
      check (above) is the checksum half of the trust ritual; see
      docs/install/macos.md's minisign section for the signature half,
      which `brew install` does not perform for you.

      Configure: /Library/Application Support/Loombre/config/loombre.env
      (created once at install, never overwritten by upgrades).
    EOS
  end
end
