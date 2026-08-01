# Installing Loombre

Loombre is a self-hosted media server that runs on Windows, macOS, and Linux. 
This guide covers the key installation paths and what hardware you need.

## Quick overview: choose your platform

- **[Docker/Compose (recommended)](docker.md)** — Friction-free path if you have Docker. No OS-level signing checks, no Gatekeeper/SmartScreen prompts. Single environment file, `docker compose` commands.
- **[Linux (tarball + systemd)](linux.md)** — Bare-metal installs, containers without Docker-in-Docker. Bundled Node, ffmpeg, systemd units.
- **[Windows (.exe installer)](windows.md)** — Native installer, Windows services, system tray controller. Embedded PostgreSQL and bundled ffmpeg.
- **[macOS (.pkg + menubar)](macos.md)** — Native installer, LaunchDaemons, menubar controller. Runs while logged out (ideal for a shared Mac).

## System requirements

Pick the tier that matches your hardware. All tiers are first-class deployments
— Loombre makes no compromises on Tier-0 (the cheapest, slowest option).

### Tier-0 (budget hardware — fully supported)

**Reference:** Intel N100, ARM Pi-5 class, 4 GB RAM, HDD

**Commitment:** Full functionality; ≥ 2 simultaneous 1080p hw transcodes or 8+ direct-play streams

**What this means:** Your library will scan and serve correctly. You'll be able to transcode or direct-play; you won't hit performance walls until you push it deliberately hard. For a home library (thousands of titles, a handful of users), this is enough.

| Component | Minimum | Notes |
|-----------|---------|-------|
| CPU | 4-core @ 2 GHz | Intel N100, Raspberry Pi 5, entry ARM boards |
| RAM | 4 GB | Embedded PostgreSQL + server + worker |
| Disk | HDD | NAS, external drive, or internal — whatever holds your media |
| Network | 1 Gbps | LAN to LAN; remote access needs 50+ Mbps for 4K |

### Tier-1 (desktop or small server)

**Reference:** Quad-core desktop/laptop with iGPU or entry dGPU, 8–16 GB RAM

**Commitment:** 4+ simultaneous 4K→1080p hardware transcodes; sub-second library navigation at 50k items

### Tier-2 (dedicated server with discrete GPU)

**Reference:** Server with dedicated GPU (RTX 2060 Ti class or better), 16+ GB RAM

**Commitment:** Worker scale-out; 10+ simultaneous transcodes

---

## Why are the installers unsigned?

Every installer ships **unsigned** — no Apple notarization, no Windows Authenticode code-signing certificate. This is a **deliberate choice, not an oversight**.

Signing certificates cost $99–$299 per year, per platform. This project has no revenue and reports no telemetry (an architecture invariant; see CLAUDE.md). The fundamental choice: spend money we don't have on certificates, or use the open-source trust model instead.

**The open-source trust model:** you verify a cryptographic checksum and signature yourself, rather than delegating that judgment to a certificate authority. This is both more honest (you make the decision personally) and more verifiable (the release manager's signature is auditable; a certificate authority's reputation system is not).

Every Loombre release carries **three independent verification layers**:

1. **GitHub artifact attestation** (no key handling required) — proves the artifact was built by Loombre's own CI from this exact commit.
2. **minisign signature** (the release manager's personal blessing) — proves a human release manager deliberately published this exact file.
3. **SHA-256 checksums** (plain integrity, no key needed) — proves your download matches what was published.

See the **Verify what you downloaded** section in each platform's guide for the exact commands. Treat verification as part of every install, every time — not a one-time setup step.

---

## First run: onboarding wizard

The first time you open Loombre (after installation, on first boot), a web-based wizard walks you through:

1. **Admin account creation** — a username and password for yourself
2. **Library paths** — where your movies, TV shows, and music live (local folders, network mounts, or both)
3. **Hardware capability probe** — Loombre detects what your device can do (video decoding, transcoding hardware, audio formats)
4. **Restricted content** — an optional step to turn on restricted-content support for this server
5. **Restore from a backup** — optionally restore a data export from another Loombre install, if this is a fresh instance

The wizard saves these settings and opens the web client. From there, you can add more users, configure remote access, and start streaming. Full step-by-step detail (including a note on the restore step's ordering requirements): `docs/admin-guide/wizard.md`.

---

## After install: next steps

- **Local access only** — No extra configuration needed. Open `http://localhost:3000` and start streaming.
- **Remote access (inside your own network)** — Set up a reverse proxy (nginx, Caddy, Traefik) if Loombre isn't already on port 80/443; see `docs/ops/reverse-proxy.md`.
- **Remote access (from outside your network)** — Use built-in ACME (Let's Encrypt) for automatic TLS, or bring your own certificate behind a reverse proxy; see `docs/ops/acme.md`.

---

## Troubleshooting

- **The installer won't run** — Gatekeeper (macOS) / SmartScreen (Windows) are blocking it. See your platform's guide for the exact click-through steps.
- **Loombre starts but I can't access it** — Check `http://127.0.0.1:3000` first (localhost only). If that works, check your firewall. `docs/ops/reverse-proxy.md` has working reverse-proxy recipes for external access.
- **I'm getting permission errors** — On Linux/macOS, Loombre runs as a dedicated system user (`loombre` or `_loombre`). If you're bind-mounting library paths, make sure that user can read them: `sudo chown -R loombre:loombre /path/to/library` (Linux) or check File Sharing system settings (macOS).
- **The database won't start** — Embedded PostgreSQL needs the data directory to be writable and owned by the service user. See the platform-specific docs for exact paths and troubleshooting.

For platform-specific issues, see:
- [Linux troubleshooting](linux.md#troubleshooting)
- [Windows troubleshooting](windows.md#troubleshooting)
- [macOS troubleshooting](macos.md#troubleshooting)
- [Docker troubleshooting](docker.md#troubleshooting)

---

## Hardware not listed?

Loombre runs on any hardware that meets the Tier-0 minimum (4-core CPU, 4 GB RAM, network drive). If your hardware meets that, it works — the tiers above just describe what additional features you can run simultaneously.

File an issue with your hardware specs if you hit problems; Phase 4 includes a Tier-0 physical-hardware audit on an actual Intel N100 (a $100-ish fanless mini-PC).
