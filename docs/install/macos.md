# Installing Loombre on macOS (.pkg + menubar)

Loombre ships as a native `.pkg` installer: a bundled Node runtime, bundled
ffmpeg, and a menubar controller app — no system Node, no system ffmpeg
required. Two install paths are first-class: the `.pkg` directly, or a
Homebrew cask that wraps the same `.pkg`.

## Why macOS will warn you before you can open this

Loombre is **not notarized and not signed with an Apple Developer ID**.
Gatekeeper — macOS's built-in "is this from a known, vetted developer"
check — blocks unsigned/unnotarized software from opening with a single
click by default, regardless of whether the software is actually safe.

Loombre doesn't pay Apple's $99/year Developer Program fee for one honest
reason, the same one behind every other unsigned-install page in this repo:
**the project takes no revenue and reports no telemetry of any kind** (see
CLAUDE.md's architecture invariants — no phone-home, ever). A Developer ID
is an annual cost with no funding source behind it. Instead, Loombre's trust
model is the open-source standard: **you verify a cryptographic checksum
and signature yourself** — see [Verify what you downloaded](#verify-what-you-downloaded)
below, and treat that step, not Gatekeeper's silence, as your actual trust
boundary.

## Downloading

Get `loombre-<version>-macos-<arch>.pkg` for your Mac (`arch` is `arm64` for
Apple Silicon, `x64` for Intel) plus its two companion files, from the
[releases page] (or your own mirror):

- `loombre-<version>-macos-<arch>.pkg` — the installer
- `loombre-<version>-macos-<arch>.pkg.sha256` — the checksum
- `loombre-<version>-macos-<arch>.pkg.minisig` — the minisign signature

[releases page]: #

## Verify what you downloaded

This is the primary trust ritual for an unsigned build — treat it as
mandatory, not optional, especially the first time you install a given
release.

### 1. Checksum (integrity — did the download complete correctly?)

```sh
shasum -a 256 -c loombre-<version>-macos-<arch>.pkg.sha256
```

Compare the printed result against the contents of
`loombre-<version>-macos-<arch>.pkg.sha256`. A mismatch means a corrupted or
tampered download — **do not open the installer**; re-download from a
different network path and check again.

A checksum alone only proves the file wasn't corrupted in transit; it does
**not** prove the file came from the Loombre project, since anyone can
compute a checksum for a file they tampered with. That's what the next step
is for.

### 2. minisign signature (authenticity — did this actually come from Loombre?)

Loombre signs every release artifact with [minisign], a small, auditable,
ed25519-based signing tool (`brew install minisign`), then:

```sh
minisign -V -p loombre-minisign.pub \
  -m loombre-<version>-macos-<arch>.pkg \
  -x loombre-<version>-macos-<arch>.pkg.minisig
```

`loombre-minisign.pub` is Loombre's public signing key, published in **three
independent places** so that forging a match would require compromising all
three at once, not just one:

1. **In this repository** — `SECURITY.md` / a pinned file in `docs/` (see
   the repo root for the exact path once the release-signing lane lands).
2. **On the docs site**, on a page that is itself covered by the site's own
   HTTPS/domain trust — not just this repo.
3. **In every release's notes**, pasted as plain text alongside the
   checksums.

If those three don't agree, or the signature does not verify, **stop and do
not open the installer** — that is exactly the scenario minisign
verification exists to catch. This project reports no telemetry, so
nobody except you will ever know you hit this — verify anyway.

[minisign]: https://jedisct1.github.io/minisign/

## Installing — the Gatekeeper walk

1. Double-click `loombre-<version>-macos-<arch>.pkg`.
2. macOS blocks it immediately: **"'loombre-\<version\>-macos-\<arch\>.pkg'
   Not Opened — Apple could not verify..."**, with only a **Done** button.
   [SCREENSHOT: macOS Gatekeeper dialog showing "loombre-*.pkg" Not Opened — Apple could not verify]

   This is expected — click **Done**, then continue below. This is *not*
   the same as the "right-click → Open" bypass that used to work for
   unnotarized software; modern macOS (Ventura and later) removed that
   shortcut for `.pkg` installers specifically. You need System Settings.
3. Open **System Settings → Privacy & Security**, scroll down to the
   **Security** section. You'll see: *"'loombre-\<version\>-macos-\<arch\>.pkg'
   was blocked to protect your Mac."* with an **Open Anyway** button.
   [SCREENSHOT: macOS System Settings, Privacy & Security pane, showing blocked pkg and Open Anyway button]
4. Click **Open Anyway**. macOS asks for your password or Touch ID to
   confirm — this is a real authorization step (you're vouching for
   software Apple hasn't vetted), not a formality.
5. **Re-open the installer** (double-click it again, or it may reopen
   automatically) — this second attempt shows the normal Apple Installer
   flow: welcome screen → license (if any) → **Install**.
   [SCREENSHOT: macOS Installer app showing Welcome, License, and Install screens]
6. Enter your administrator password when prompted (the installer needs
   root to write `/opt/loombre`, `/Library/LaunchDaemons`, and create the
   `_loombre` service account — see `installers/macos/LAYOUT.md` for exactly
   what and why).
7. The installer creates the `_loombre` service account, lays down
   `/opt/loombre/<version>` + `/Applications/Loombre.app`, and loads two
   LaunchDaemons (**com.loombre.server**, **com.loombre.worker**) that start
   immediately and on every future boot — no login required (this is a
   media server; it needs to serve while nobody is signed in, see
   LAYOUT.md §3).

### The CLI path (no GUI clicks)

If you're comfortable on the command line, `xattr` gets you there in one
step instead of four — this removes exactly the quarantine flag Gatekeeper
checks, nothing else:

```sh
xattr -d com.apple.quarantine loombre-<version>-macos-<arch>.pkg
sudo installer -pkg loombre-<version>-macos-<arch>.pkg -target /
```

This is not "bypassing security" in any meaningful sense beyond what
clicking through step 3 above already does — both paths end at the same
place: you, personally, decided to trust a specific file you already
checksum+signature-verified.

### Homebrew cask

```sh
brew install --cask --no-quarantine loombre
```

**`--no-quarantine` is required**, not optional — without it, Homebrew
still applies the quarantine attribute to the extracted `.pkg` before
running it, and you'll hit the same Gatekeeper block described above
*inside* `brew`'s own install step, with a less legible error. Homebrew
casks that wrap unsigned installers are a well-established pattern (this
flag exists in Homebrew precisely for projects like this one); it does not
weaken checksum verification — the cask's own `sha256` stanza still
verifies the download before `--no-quarantine` ever comes into play.

## After install

- The **Loombre** menubar icon appears in the menu bar (no Dock icon — it's
  a background-only utility, `LSUIElement`). It polls server/worker status
  and gives you: **Open Loombre** (launches your browser to the web client),
  **Start/Stop Server**, **Reveal Crash Files**, and the installed +
  contract version.
  [SCREENSHOT: macOS menubar showing Loombre icon and context menu with Open Loombre, Start/Stop, Reveal Crash Files, version info]
- The menubar app is **not** added to your Login Items automatically in
  v1 — add it yourself (System Settings → General → Login Items) if you
  want it to reappear after you log out/in; the server/worker themselves
  don't need it running (they're LaunchDaemons, independent of any login
  session or menubar app).
- First launch of the menubar app may **also** trigger the same Gatekeeper
  block described above (it's a separate executable) — click through the
  same **Open Anyway** flow if so.

## Configure

Edit `/Library/Application Support/Loombre/config/loombre.env` — at minimum,
point `DATABASE_URL` at a real PostgreSQL 17+ instance (external-PG path;
embedded PostgreSQL is vendored into the payload but not yet wired into the
service lifecycle — see `installers/macos/LAYOUT.md` §8) and set
`LOOMBRE_JWT_SECRET` (`openssl rand -base64 48`) so restarts don't log
everyone out. This file is created once at install time and **never**
overwritten by a later upgrade — your edits survive.

Restart both services after editing:

```sh
sudo launchctl kickstart -k system/com.loombre.server
sudo launchctl kickstart -k system/com.loombre.worker
```

Run migrations against that database (until the `loombre` CLI gains a
first-class subcommand for this):

```sh
# from a repo checkout with the same DATABASE_URL, or an equivalent tool
# once one ships in the payload itself
pnpm db:migrate
```

**Do not run `pnpm db:seed` (or `db:seed-large`) against a real instance.**
Those scripts exist to populate throwaway dev/test/CI databases with fixture
data — including an `admin` account whose password is a fixed, publicly
documented string committed in `packages/db/seed/seed.mjs`. Running either
against your real database would give a LAN- or internet-reachable instance
an admin account with a published password; treat that as a security
mistake, not a shortcut. `pnpm db:migrate` alone leaves the `users` table
empty, which is what the first-run setup wizard needs: with both services
already running (see above), open `http://<this host>:3001` in a browser
and it walks you through creating the real admin account.

## Checking status

```sh
sudo launchctl print system/com.loombre.server
sudo launchctl print system/com.loombre.worker
curl http://127.0.0.1:3001/healthz
tail -f "/Library/Logs/Loombre/server.out.log"
```

Or just use the menubar app's status indicator — same information, no
terminal required.

## Uninstalling

macOS has no built-in `.pkg` uninstaller (Apple's own long-standing
limitation, not a Loombre omission). Remove by hand:

```sh
sudo launchctl bootout system/com.loombre.server
sudo launchctl bootout system/com.loombre.worker
sudo rm /Library/LaunchDaemons/com.loombre.server.plist
sudo rm /Library/LaunchDaemons/com.loombre.worker.plist
sudo rm -rf /opt/loombre
sudo rm -rf /Applications/Loombre.app
sudo rm -rf "/Library/Logs/Loombre"
# Your data (DB config, secrets) lives here — remove only if you want it gone:
sudo rm -rf "/Library/Application Support/Loombre"
# Remove the service account:
sudo dscl . -delete /Users/_loombre
sudo dscl . -delete /Groups/_loombre
```

(`brew uninstall --cask loombre` runs the same `.pkg`-uninstall gap Homebrew
itself can't fully close for any `pkg`-based cask — it removes what it
tracked installing, which for a `.pkg` payload is limited; the manual steps
above are the complete removal either way.)

## Verify what you downloaded

Before opening the installer, verify your download:

### 1. Checksum (integrity)

```sh
shasum -a 256 -c loombre-<version>-macos-<arch>.pkg.sha256
```

Compare the printed result against the contents of
`loombre-<version>-macos-<arch>.pkg.sha256`. A mismatch means corruption —
**do not open the installer**.

### 2. minisign signature (authenticity)

```sh
minisign -V -p <public key> \
  -m loombre-<version>-macos-<arch>.pkg \
  -x loombre-<version>-macos-<arch>.pkg.minisig
```

The minisign public key is published in three places (see `keys/minisign.pub`
in the repository, `docs/ops/updating.md`, and every GitHub Release's notes).

If verification fails, **do not open the installer**.

## Why unsigned?

Code-signing certificates (Apple Developer ID + notarization) cost $99/year.
This project has no revenue and reports no telemetry. Checksum + minisign-signature
verification is the open-source trust model instead — see `docs/PLAN.md` P4.9.
This is a deliberate, disclosed tradeoff, not an oversight.

---

## Troubleshooting

### Server won't start (LaunchDaemon not running)

Check the LaunchDaemon status:

```sh
sudo launchctl print system/com.loombre.server
```

If the status shows error or crashes, check the logs:

```sh
tail -f "/Library/Logs/Loombre/server.out.log"
# or use the Console app: CMD+SPACE → Console → search "loombre"
```

Common issues:

- **`bind EADDRINUSE`** — port 3001 (or another port) is already in use.
  Check `lsof -i :3001` to see what process is using it.
- **Permission denied on `/Library/Application Support/Loombre/`** — the
  installer creates this directory and makes it owned by `_loombre`. If you
  copied it or changed permissions, restore them:
  ```sh
  sudo chown -R _loombre:_loombre "/Library/Application Support/Loombre/"
  sudo chmod 750 "/Library/Application Support/Loombre/"
  ```
- **PostgreSQL won't start** — Embedded PostgreSQL data directory needs to be
  writable by `_loombre`:
  ```sh
  sudo chown -R _loombre:_loombre "/Library/Application Support/Loombre/db"
  sudo chmod 700 "/Library/Application Support/Loombre/db"
  ```

### Permission errors scanning library paths

If library folders are on a network mount or custom location, the `_loombre`
user must be able to read them. Check:

```sh
sudo -u _loombre ls /path/to/your/library
```

If this fails, you need to grant the `_loombre` user read access. For a network
mount, check File Sharing (System Settings → General → Sharing) — confirm your
user has read access, then Loombre can mount it in the same way.

### Menubar app won't open (Gatekeeper blocks it again)

The menubar app (`Loombre.app`) is a separate executable and may also trigger
Gatekeeper on first launch. Click through the same **Open Anyway** flow as you
did for the installer.

### Getting logs from LaunchDaemon without `tail`

If you prefer the Console app or `log` command:

```sh
# Live stream of Loombre logs (Control+C to stop)
log stream --predicate 'eventMessage contains[cd] "loombre"'

# Or open Console.app (Spotlight: CMD+SPACE → Console) and search "loombre"
```

### Uninstalling (custom data directory removal)

If you used a custom data directory (changed `DATABASE_URL` or LOOMBRE data dir
location), you'll need to delete it manually after uninstalling — the installer
removal only deletes the application files, not your data (by design, so you
never accidentally destroy your library).
