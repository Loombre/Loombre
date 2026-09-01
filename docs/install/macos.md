# Installing Loombre on macOS (.pkg + menubar)

Loombre ships as a native `.pkg` installer: a bundled Node runtime, bundled
ffmpeg, and a menubar controller app — no system Node, no system ffmpeg
required. The install path is the `.pkg` directly. (A Homebrew cask
wrapping the same `.pkg` is prepared in the repository but not yet wired
to a publisher — no tap exists yet; see [Homebrew cask](#homebrew-cask)
below.)

## Why macOS will warn you before you can open this

Loombre is **not notarized and not signed with an Apple Developer ID**.
Gatekeeper — macOS's built-in "is this from a known, vetted developer"
check — blocks unsigned/unnotarized software from opening with a single
click by default, regardless of whether the software is actually safe.

Loombre doesn't pay Apple's $99/year Developer Program fee for one honest
reason, the same one behind every other unsigned-install page in this repo:
**the project takes no revenue and reports no telemetry of any kind** — no
phone-home, ever; an architecture invariant, not a setting. A Developer ID
is an annual cost with no funding source behind it. Instead, Loombre's trust
model is the open-source standard: **you verify a cryptographic checksum
and signature yourself** — see [Verify what you downloaded](#verify-what-you-downloaded)
below, and treat that step, not Gatekeeper's silence, as your actual trust
boundary.

## Downloading

Get `loombre-<version>-macos-<arch>.pkg` for your Mac (`arch` is `arm64` for
Apple Silicon, `x64` for Intel) plus the release's shared verification
files, from the [releases page] (or your own mirror).

**Apple Silicon (`arm64`) only for now** — the release pipeline builds and
publishes only the `arm64` `.pkg` today; an Intel (`x64`) build is not yet
published (the build script already supports `--arch=x64` — the gap is the
pipeline, a known pending item). The downloads:

- `loombre-<version>-macos-<arch>.pkg` — the installer
- `SHA256SUMS` — checksums for every artifact in the release
- `SHA256SUMS.minisig` — the minisign signature over that checksum list

(There is no per-artifact `<file>.sha256`/`<file>.minisig` — one signed
checksum list covers the whole release, same as on Linux.)

[releases page]: #

## Verify what you downloaded

This is the primary trust ritual for an unsigned build — treat it as
mandatory, not optional, especially the first time you install a given
release.

### 1. GitHub artifact attestation (no key handling required)

```sh
gh attestation verify loombre-<version>-macos-<arch>.pkg --repo Loombre/Loombre
```

Proves this exact file was built by Loombre's own CI, from this exact
repository, at this exact commit. Needs the `gh` CLI, signed in
(`gh auth login`).

### 2. Checksum (integrity — did the download complete correctly?)

```sh
grep "loombre-<version>-macos-<arch>.pkg" SHA256SUMS | shasum -a 256 -c -
```

`SHA256SUMS` lists every artifact in the release, not just this `.pkg` —
the `grep` selects the line for the file you actually downloaded. A
mismatch means a corrupted or tampered download — **do not open the
installer**; re-download from a different network path and check again.

A checksum alone only proves the file wasn't corrupted in transit; it does
**not** prove the file came from the Loombre project, since anyone can
compute a checksum for a file they tampered with. That's what the next step
is for.

### 3. minisign signature (authenticity — did this actually come from Loombre?)

The signature covers `SHA256SUMS` itself — not each individual artifact —
so verifying it, combined with the checksum match above, transitively
proves the `.pkg` is authentic too. Install [minisign]
(`brew install minisign`), then:

```sh
minisign -Vm SHA256SUMS -P <public key — see below>
```

The public key is published, byte-identical, in multiple
independently-maintained places — `keys/minisign.pub` in the repository,
`docs/install/linux.md`'s "Verify what you downloaded" section (which
embeds it inline), `docs/ops/updating.md`'s "Verifying releases" section,
and every release's notes — so substituting all of them simultaneously
would be required to defeat verification.

If those don't agree, or the signature does not verify, **stop and do
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
   `/opt/loombre/<version>` + `/Applications/Loombre.app`, and loads three
   LaunchDaemons (**com.loombre.server**, **com.loombre.web**,
   **com.loombre.worker**) that start immediately and on every future boot
   — no login required (this is a media server; it needs to serve while
   nobody is signed in, see LAYOUT.md §3). It also loads the
   **com.loombre.menubar** LaunchAgent into your login session, so the
   menu bar icon appears without you having to go find the app.
8. The final installer pane names the address (`http://localhost:3000`),
   and **your browser opens to it automatically** a few seconds later —
   the menubar app opens the web UI once, the first time the server
   reports ready (once per user account, ever; upgrades don't re-open
   it). The database is provisioned, migrated and serving by then — the
   first page you see is the account-setup wizard. Nothing else to
   configure. If the browser doesn't open, go to `http://localhost:3000`
   yourself.

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

**Not yet installable** — the cask file ships in this repository
(`installers/macos/homebrew/loombre.rb`) but is not yet wired to a
publisher: no tap exists and no tagged release has been published yet
(the same caveat the Docker page gives its published-image path), so
`brew install` has nothing to resolve today. Once a tap and a published
release exist, the invocation will be:

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
  **Start Loombre** / **Stop Server**, **Shut Down Loombre…** (stops
  *everything* — see [Shutting Loombre down completely](#shutting-loombre-down-completely)),
  **Reveal Crash Files**, and the installed + contract version. Starting
  the stopped services and shutting everything down both ask for
  administrator authorization (password or Touch ID) — the services run as
  system daemons, so managing them is a privileged operation; stopping the
  server alone is not prompted.
  [SCREENSHOT: macOS menubar showing Loombre icon and context menu with Open Loombre, Start/Stop, Shut Down Loombre, Reveal Crash Files, version info]
- The menubar app starts **automatically at every login**, via the
  `com.loombre.menubar` LaunchAgent the installer places in
  `/Library/LaunchAgents` (system-wide, so every account on the Mac gets
  it — not one user's Login Items). If you choose **Quit** from its menu it
  stays closed until your next login; nothing else depends on it. The
  server, web UI and worker are LaunchDaemons and keep serving with the
  menubar closed, logged out, or never launched at all.
- First launch of the menubar app may **also** trigger the same Gatekeeper
  block described above (it's a separate executable) — click through the
  same **Open Anyway** flow if so.

## Configure

**Database: nothing to do by default.** Leave `DATABASE_URL` unset and the
server provisions and supervises its own bundled PostgreSQL automatically
at boot (data under
`/Library/Application Support/Loombre/postgres/`), including running
migrations — this is the default a fresh install is already using by the
time the setup wizard appears.

To use your own PostgreSQL 17+ instead, edit
`/Library/Application Support/Loombre/config/loombre.env` and set
`DATABASE_URL` (see `docs/ops/external-postgres.md`). Also consider
setting `LOOMBRE_JWT_SECRET` explicitly (`openssl rand -base64 48`) — not
because restarts would log anyone out (an unset secret is generated once
and persisted automatically since P4.7/P4.17, so sessions survive
restarts either way), but because an explicit value in this file survives
a wiped data directory and gets backed up with the rest of your
configuration. This file is created once at install time and **never**
overwritten by a later upgrade — your edits survive.

Restart the services after editing:

```sh
sudo launchctl kickstart -k system/com.loombre.server
sudo launchctl kickstart -k system/com.loombre.worker
sudo launchctl kickstart -k system/com.loombre.web
```

In external-Postgres mode only, run migrations against that database
yourself (embedded mode migrates automatically; external mode **never**
auto-migrates):

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
empty, which is what the first-run setup wizard needs: with the services
already running (see above), open `http://<this host>:3000` in a browser
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

The server's log path above (`/Library/Logs/Loombre/server.out.log`) is
also set as `LOOMBRE_LOG_FILE` automatically, so the admin Dashboard's
log-tail card shows the same content in the browser — no terminal needed
there either. `/Library/Logs/Loombre/worker.out.log` and `web.out.log`
cover the other two services. See [Environment variable
reference](/ops/env-reference) if you want to point it somewhere else.

## Shutting Loombre down completely

The menubar's **Shut Down Loombre…** item stops all three services — the
worker, the web UI, then the server (which takes its embedded PostgreSQL
down with it) — after a confirmation and a single administrator prompt,
and then quits the menu bar controller itself. Nothing of Loombre is left
running.

Two things it deliberately does **not** do:

- It does not disable Loombre permanently: the services start again the
  next time the Mac boots (`RunAtLoad`), and the menu bar app returns at
  your next login. To bring everything back sooner, open **Loombre** from
  `/Applications` and choose **Start Loombre**.
- It does not uninstall anything — see the next section for that.

The equivalent from a terminal:

```sh
sudo launchctl bootout system/com.loombre.worker
sudo launchctl bootout system/com.loombre.web
sudo launchctl bootout system/com.loombre.server
```

(**Stop Server**, by contrast, stops only the API server process over
local IPC — no admin prompt — and leaves the worker and web daemons
running; it is a quick, reversible pause rather than a full shutdown.)

## Uninstalling

macOS has no built-in `.pkg` uninstaller (Apple's own long-standing
limitation, not a Loombre omission). The installer ships its own uninstall
script for exactly this reason — use it:

```sh
sudo /opt/loombre/current/bin/uninstall.sh
```

It stops all four launchd jobs the installer created (the three
LaunchDaemons — server, worker, web — plus the `com.loombre.menubar`
LaunchAgent), removes the plists, removes `/Applications/Loombre.app` (and,
per the pkgutil receipt, any copy relocated by an rc.6-and-earlier install —
see the manual fallback below for how to check for one by hand) and
`/Library/Logs/Loombre`, deletes the `_loombre` service
account, removes `/opt/loombre`, and — deliberately last, so an interrupted
run still has it available — forgets the package receipt (`pkgutil
--forget com.loombre.pkg`). It's **idempotent** — safe to re-run, and
tolerant of a machine already in a partially-uninstalled state (daemons
already stopped, some files already removed by hand) — it works through
whatever subset of the above actually exists instead of dying partway
through on the first already-absent item.

A few things worth knowing before running it:

- **Your data is kept by default.** `/Library/Application Support/Loombre`
  (database, config, secrets) is left alone unless you pass `--purge`:
  ```sh
  sudo /opt/loombre/current/bin/uninstall.sh --purge
  ```
- **Deleting the `_loombre` account opens a GUI authorization prompt.**
  On macOS 26, the older `dscl . -delete` command — and even
  `sysadminctl -deleteUser` run as plain root — fails outright with a
  permission error; the only path that actually works is
  `sysadminctl -deleteUser _loombre interactive`, which the script runs
  for you and which asks you to authorize with an administrator account
  (password or Touch ID) when it runs. For unattended/scripted removal,
  pass admin credentials directly instead of hitting that prompt:
  ```sh
  sudo /opt/loombre/current/bin/uninstall.sh --adminUser <admin-username> --adminPassword <admin-password>
  ```
  **Caution:** passing `--adminPassword` puts it in argv, which is visible
  to other users on the machine via `ps`/the process table and lands in
  shell history — prefer the interactive prompt (omit both flags) on any
  multi-user machine.
- **Preview first, if you like.** `--dry-run` prints every action the
  script would take without changing anything, and needs no `sudo`:
  ```sh
  /opt/loombre/current/bin/uninstall.sh --dry-run
  ```

Run `/opt/loombre/current/bin/uninstall.sh --help` for the full flag list.

### Manual fallback

If `/opt/loombre` is already gone (so the script above isn't reachable) or
you'd simply rather do it by hand, here is the complete equivalent:

```sh
sudo launchctl bootout system/com.loombre.server
sudo launchctl bootout system/com.loombre.worker
sudo launchctl bootout system/com.loombre.web
sudo launchctl bootout gui/$(id -u)/com.loombre.menubar
sudo rm /Library/LaunchDaemons/com.loombre.server.plist
sudo rm /Library/LaunchDaemons/com.loombre.worker.plist
sudo rm /Library/LaunchDaemons/com.loombre.web.plist
sudo rm /Library/LaunchAgents/com.loombre.menubar.plist
sudo rm -rf /Applications/Loombre.app
sudo rm -rf "/Library/Logs/Loombre"
# Your data (DB config, secrets) lives here — remove only if you want it gone:
sudo rm -rf "/Library/Application Support/Loombre"
# Remove the service account — NOT `dscl . -delete`: on macOS 26 that (and
# even a plain root `sysadminctl -deleteUser`, without `interactive`) fails
# with a permission error (eDSPermissionError, -14120). This is the command
# that actually works — it opens a GUI prompt asking you to authorize with
# an administrator account:
sudo sysadminctl -deleteUser _loombre interactive
sudo rm -rf /opt/loombre
# Before forgetting the receipt, check it for a STRAY copy of the app: an
# rc.6-and-earlier install (see commit b935a2c) could have relocated
# Applications/Loombre.app elsewhere on the volume instead of installing it
# at the standard path — this lists every file the receipt actually tracks
# so you can spot (and remove) a relocated bundle before the receipt that
# would otherwise help you find it is gone:
pkgutil --files com.loombre.pkg | grep Loombre.app
sudo pkgutil --forget com.loombre.pkg
```

`sysadminctl` will report that `_loombre`'s home (`/var/empty`) "WILL NOT BE
DELETED" — that's expected and harmless: `/var/empty` is a shared, empty
system path, not anywhere Loombre ever wrote real data. (`-keepHome` is not
a valid `sysadminctl` flag on macOS 26, hence not used above.)

(`brew uninstall --cask loombre` runs the same `.pkg`-uninstall gap Homebrew
itself can't fully close for any `pkg`-based cask — it removes what it
tracked installing, which for a `.pkg` payload is limited; the steps above
(script or manual) are the complete removal either way.)

## Why unsigned?

Code-signing certificates (Apple Developer ID + notarization) cost $99/year.
This project has no revenue and reports no telemetry. Checksum + minisign-signature
verification is the open-source trust model instead — see `docs/PLAN.md` §11
and STATE.md P4.9. This is a deliberate, disclosed tradeoff, not an oversight.

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
  installer creates this directory owned by `_loombre`, with the **root
  directory's group set to `admin`** so the menubar app (running as your
  console user) can traverse it to the server's IPC files. If you copied
  it or changed permissions, restore the installer's layout (the full
  recipe, including per-subdirectory modes, is on
  [the install troubleshooting page](/install/troubleshooting)):
  ```sh
  sudo chown -R _loombre:_loombre "/Library/Application Support/Loombre/"
  sudo chown _loombre:admin "/Library/Application Support/Loombre/"
  sudo chmod 750 "/Library/Application Support/Loombre/"
  ```
- **PostgreSQL won't start** — Embedded PostgreSQL data directory needs to be
  writable by `_loombre`:
  ```sh
  sudo chown -R _loombre:_loombre "/Library/Application Support/Loombre/postgres"
  sudo chmod 700 "/Library/Application Support/Loombre/postgres/data"
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

### Media in your home folder ("No access" in the folder picker / "cannot read this folder")

Loombre's services run as the dedicated `_loombre` system account — never as
you, and never as root — so the server keeps serving while you're logged out
and holds the least privilege possible. The flip side: macOS keeps personal
home folders private (`/Users/you` is mode 700/750), so `_loombre` cannot see
them. The folder picker marks such folders **No access**, and browsing into
one reports that the service account cannot read it. That's the system
working as designed, not a broken install.

**The easy fixes** — no permission surgery at all:

- Keep media on an **external drive or network share** (they mount under
  `/Volumes`, which is where the picker starts looking on a Mac), or
- use **`/Users/Shared`**, which every account on the machine can read.

**If your media must stay in your home folder**, grant `_loombre` access to
just that subtree with targeted ACLs — nothing else in your home folder
becomes readable. The folder picker walks you through this in two steps,
each with the exact command pre-filled for the folder you clicked: copy it,
run it in Terminal, then click **Check again**.

1. **Click your home folder** (marked **No access**). The picker offers a
   names-only grant so that it can list what's in your home. It reveals only
   the *names* of the folders directly inside — nothing inside them, nothing
   inherited; `Library`, `.ssh`, `Documents` and the other private folders
   stay closed:

   ```sh
   chmod +a "user:_loombre allow list,search" ~
   ```

2. **Click your media folder** (now listed, still **No access**). The picker
   offers the read grant on just that folder, inherited by everything added
   to it later (the two inherit flags):

   ```sh
   chmod +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" ~/Media
   ```

Doing it by hand instead? Adjust `~/Media` to your actual folder. If you
don't need the picker to list your home, step 1 can be traversal-only —
`chmod +a "user:_loombre allow search" ~` — which lets the service walk
*through* your home without seeing even the names in it. Either way, `chmod
+a` never adds a duplicate of an entry that's already there, so re-running a
step is harmless. Verify with `sudo -u _loombre ls ~/Media`, and inspect or
undo at any time:

```sh
ls -le ~ ~/Media                              # view the ACL entries
chmod -a "user:_loombre allow list,search" ~  # revoke step 1
chmod -a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" ~/Media   # revoke step 2
```

**A note on Full Disk Access**: it is *not* the fix for the above — Full Disk
Access lifts macOS's privacy protection (TCC), never POSIX permissions. It
only matters if your media lives inside a TCC-protected folder (`Desktop`,
`Documents`, `Downloads`), which daemons cannot read even after an ACL grant —
which is why the picker deliberately offers no command for those three.
Simplest is to keep media out of those three folders (a `~/Media` folder is
not TCC-protected, so the ACL above is all it needs). If you genuinely need
one of them, additionally add Loombre's runtime binary
(`/opt/loombre/current/runtime/node/bin/node`) under System Settings →
Privacy & Security → Full Disk Access — and expect to re-check that grant
after an upgrade, since it's tied to the binary on disk.

### Menubar app won't open (Gatekeeper blocks it again)

The menubar app (`Loombre.app`) is a separate executable and may also trigger
Gatekeeper on first launch. Click through the same **Open Anyway** flow as you
did for the installer.

### Menu bar icon missing (services running, nothing in the menu bar)

Occasionally macOS's own menu bar host — Control Center, on macOS 26 and
later — gets into a state where newly started menu bar apps aren't
displayed at all, even though they're running normally. This has been
observed in the field when Control Center crash-restarts, for example
during heavy installer activity right after a `.pkg` install. It isn't
specific to Loombre, and no third-party app can reliably work around it
from the outside — the fix has to happen at the menu bar host itself.

Try these in order:

```sh
killall ControlCenter   # it relaunches immediately and re-adopts every icon
```

If that doesn't bring the icon back, log out and back in; if it still
doesn't, a reboot is the definitive fix.

Loombre itself keeps working the whole time — the server, worker, and web
UI are LaunchDaemons independent of the menu bar, so streaming is
unaffected. You can reach the web UI directly at `http://localhost:3000`
regardless, and while it's running, double-clicking `Loombre.app` in
`/Applications` also opens the web UI even while its menu bar icon is
invisible. (This is the menu bar app just relaunching, not a cold start —
if you've quit it or fully shut Loombre down, double-clicking the app
starts it fresh instead, without opening a browser; see "Shutting Loombre
down completely" above for bringing everything back.)

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
