# Installing Loombre on Windows (installer + tray controller)

Loombre ships as a single unsigned Windows installer. That is a deliberate
choice, not an oversight — read on for why, and for exactly how to verify what you are
installing is genuinely what the Loombre project built.

## Why Windows will warn you before you can run this

Loombre has **no Authenticode code-signing certificate**. Windows SmartScreen
uses code-signing + a reputation service to decide whether to warn you
before running a downloaded executable; an unsigned, low-download-count
installer will always trigger that warning, regardless of whether the
software is safe.

Loombre does not buy a signing certificate for one honest reason: **the
project takes no revenue and reports no telemetry of any kind** (not even
anonymous usage counts — see the project's architecture invariants). A
code-signing certificate is an annual cost with no funding source behind
it, and Windows' reputation system itself is a form of telemetry-driven
trust that a zero-phone-home project structurally cannot build up quickly
even if it did sign.

Instead, Loombre's trust model is the open-source standard: **you verify a
cryptographic checksum and signature yourself**, rather than delegating that
judgment to a certificate authority and Microsoft's reputation graph. See
[Verify what you downloaded](#verify-what-you-downloaded) below — treat that
step, not the absence of a SmartScreen warning, as your actual trust
boundary.

## Downloading

One file, from the [releases page]:

- `loombre-<version>-windows-x64.exe`

That's the whole Windows download. It installs everything Loombre needs,
including the Microsoft Visual C++ runtime if your machine doesn't already
have it (most do, in which case you won't notice). Checksums and
signatures are in the release's `SHA256SUMS` and `manifest.json`, each
with a `.minisig`.

[releases page]: #

## Verify what you downloaded

This is the primary trust ritual for an unsigned build — treat it as
mandatory, not optional, especially the first time you install a given
release.

### 1. Checksum (integrity — did the download complete correctly?)

PowerShell:

```powershell
Get-FileHash .\loombre-<version>-windows-x64.exe -Algorithm SHA256
```

Compare the printed hash, byte-for-byte, against the contents of
`loombre-<version>-windows-x64.exe.sha256`. A mismatch means a corrupted or
tampered download — **do not run the installer**; re-download from a
different network path and check again.

A checksum alone only proves the file wasn't corrupted in transit; it does
**not** prove the file came from the Loombre project, since anyone can
compute a checksum for a file they tampered with. That's what the next step
is for.

### 2. minisign signature (authenticity — did this actually come from Loombre?)

Loombre signs every release artifact with [minisign], a small, auditable,
ed25519-based signing tool. Install it once (`scoop install minisign`, or
download a release binary from the minisign project), then:

```powershell
minisign -V -p loombre-minisign.pub -m loombre-<version>-windows-x64.exe -x loombre-<version>-windows-x64.exe.minisig
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
not run the installer** — that is exactly the scenario minisign verification
exists to catch. This project reports no telemetry, so nobody except you
will ever know you hit this — verify anyway.

[minisign]: https://jedisct1.github.io/minisign/

## About the Visual C++ runtime (you don't need to do anything)

The installer handles this — it's documented only so nothing about the
install is a mystery.

Two of Loombre's bundled native components import `VCRUNTIME140.dll`: the
PostgreSQL binaries behind Loombre's built-in database, and the addon that
stores credentials in Windows Credential Manager. That DLL comes from the
Microsoft Visual C++ 2015-2022 Redistributable and is **not** part of
Windows (the Universal CRT half of the runtime is; this piece isn't).
Plenty of software installs it, so most machines already have it — but a
freshly imaged Windows does not, which is exactly how v0.9.0-rc.1 shipped
an installer whose services registered successfully and then died on every
start.

The installer now detects it and installs it if absent. If you'd rather
install it yourself first:

```powershell
winget install --id Microsoft.VCRedist.2015+.x64 -e
```

and to check whether you already have it:

```powershell
Test-Path "$env:SystemRoot\System32\vcruntime140.dll"
```

Uninstalling Loombre deliberately leaves the runtime in place — other
software on your machine may have come to depend on it.

## Installing

1. Double-click `loombre-<version>-windows-x64.exe`.
2. Windows shows **"Windows protected your PC"** (SmartScreen).
   [SCREENSHOT: SmartScreen blocked-app dialog, showing blocked message and More info button]
3. Click **More info**.
   [SCREENSHOT: SmartScreen dialog after clicking More info, showing the Run anyway button]
4. Click **Run anyway**.
5. Follow the installer. It installs per-machine, with no custom pages
   in v1 (a first-run web setup wizard, not this installer, is where you
   create the admin account and pick library folders — see
   `docs/admin-guide/wizard.md` for the full walkthrough).
6. The installer registers three Windows services (**Loombre Server**,
   **Loombre Web**, **Loombre Worker**), firewall exceptions for the server
   and web ports, and a tray application (**Loombre.Tray.exe**). All three
   services start immediately and on every boot; the tray starts at the end
   of the install and again at every logon.
7. When it finishes, open `http://localhost:3000`. The database provisions
   and migrates itself on first boot — give it a few seconds — and the
   first page you get is the account-setup wizard.

Nothing here is different in kind from any other unsigned, legitimately
open-source Windows installer (Notepad++, many others) — SmartScreen's
warning is a function of signing + download-reputation, not a safety
verdict on the software itself.

## After install

- The **Loombre** tray icon (system tray, bottom-right of the taskbar) shows
  server/worker status at a glance and gives you: **Open Loombre** (launches
  your browser to the web client), **Start/Stop server**, **Reveal crash
  files**, and the installed version.
  [SCREENSHOT: Loombre tray icon with context menu showing Open Loombre, Start/Stop, Reveal crash files, and version]
- First launch of the tray or the services may **also** trigger a
  SmartScreen prompt (same reasoning as above — click **More info → Run
  anyway** again if so).

## Managing the services

Loombre installs as three standard Windows services, manageable the same
way as any other:

- **services.msc** (Start menu → type `services.msc` → Enter): find
  **Loombre Server**, **Loombre Web** and **Loombre Worker**, right-click for Start/Stop/
  Restart/Properties (startup type, recovery actions).
  [SCREENSHOT: services.msc with Loombre Server and Loombre Worker services visible]
- Or PowerShell (run as Administrator):

  ```powershell
  Get-Service Loombre*
  Restart-Service LoombreServer
  Stop-Service LoombreWorker
  ```

- The tray's **Start/Stop server** menu item is the everyday equivalent of
  the above, without needing an elevated prompt (it talks to the services
  through Loombre's local control API, not through SCM directly — see
  `packages/controller-ipc` if you're curious about the mechanism).

## Data locations

| What | Where |
|---|---|
| Application files | `%ProgramFiles%\Loombre\` |
| Application data (embedded database, logs, crash files) | `%ProgramData%\Loombre\` |
| — embedded PostgreSQL data | `%ProgramData%\Loombre\pgdata\` |
| — logs | `%ProgramData%\Loombre\logs\` |

`%ProgramData%` is normally `C:\ProgramData` — a hidden folder by default;
type the path directly into File Explorer's address bar to open it.

## Crash reports

Loombre never sends crash data anywhere automatically (no telemetry, ever —
this is a hard architecture rule, not a setting). If something crashes, a
redacted crash file is written locally under `%ProgramData%\Loombre\logs\`.
Use the tray's **Reveal crash files** menu item to jump straight to the most
recent one in Explorer. Sharing it with anyone (a bug report, a forum post)
is entirely your call, every time.

## Uninstalling

**Settings → Apps → Installed apps → Loombre → Uninstall** (or
`appwiz.cpl` on older Windows). This removes the two services, the
firewall exception, the tray autostart entry, and everything under
`%ProgramFiles%\Loombre\`.

**`%ProgramData%\Loombre\` (your library metadata, embedded database, and
logs) is deliberately left behind** — an uninstall should never silently
destroy your data. Delete that folder yourself afterward if you want a
completely clean removal.

## Updating

Re-run a newer `loombre-<version>-windows-x64.exe` (after verifying it the
same way, every time — see [Verify what you downloaded](#verify-what-you-downloaded)).
Windows Installer's standard major-upgrade handling replaces the old
version cleanly; your data under `%ProgramData%\Loombre\` is untouched.
Loombre's own admin UI will notify you when a newer signed release manifest
is available — it never downloads or applies anything automatically (see
`packages/release-manifest`).

## Troubleshooting

- **"Windows protected your PC" every time you open the tray, not just on
  first install.** Expected while Loombre stays unsigned — see
  [Why Windows will warn you](#why-windows-will-warn-you-before-you-can-run-this).
- **Server won't reach the internet / other devices can't reach it.** Check
  Windows Defender Firewall → the installer adds an inbound rule named
  **Loombre Server** automatically; confirm it's enabled if you use a
  third-party firewall product instead of (or alongside) Windows Defender.
- **Services show "Starting" and never reach "Running."** Check
  `%ProgramData%\Loombre\logs\server.log` / `worker.log` for the underlying
  Node.js process's own output — the Windows Service wrapper forwards it
  there verbatim.

---

## Verify what you downloaded

Before running the installer, verify your download using the same three-layer
trust model as Linux:

### 1. Checksum (integrity)

```powershell
Get-FileHash .\loombre-<version>-windows-x64.exe -Algorithm SHA256
```

Compare the printed hash against the contents of `loombre-<version>-windows-x64.exe.sha256`.
A mismatch means a corrupted or tampered download — **do not run the installer**.

### 2. minisign signature (authenticity)

```powershell
# Install minisign first (if you don't have it):
# scoop install minisign
# or: choco install minisign

minisign -V -p <public key> -m loombre-<version>-windows-x64.exe -x loombre-<version>-windows-x64.exe.minisig
```

The minisign public key is published in three places (see `keys/minisign.pub` in
the repository, `docs/ops/updating.md`, and every GitHub Release's notes).

If verification fails, **do not install** — that is exactly what minisign verification
exists to catch.
