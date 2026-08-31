# Troubleshooting Loombre installation

This page covers real issues discovered during Phase 4 development and
testing.

## General issues

### Loombre won't start — "Module not found" or import errors

**Common with:** Linux tarball, Docker, any platform  
**Root cause:** Packaging issue during build or extraction

**Fix:**
- **Linux tarball:** Confirm complete extraction: `tar -tzf loombre-*.tar.gz | wc -l` should show thousands of files. Re-extract if needed.
- **Docker:** Ensure you've built the image (from the repo root): `docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env build --no-cache` then try again.
- **All platforms:** Check the startup logs for the exact missing module name — report it if it's from the Loombre project itself.

### Port 3001 already in use

**Symptom:** "EADDRINUSE: Address already in use :::3001"

**Check what's using it:**
```bash
# Linux/macOS:
lsof -i :3001

# Windows (PowerShell):
Get-NetTCPConnection -LocalPort 3001 | Select-Object -Property State, OwningProcess
```

**Fix:**
- Stop the process using port 3001, or
- Change the port — the mechanism depends on your install path:
  - **Docker:** set `LOOMBRE_PORT` in `installers/docker/loombre.env`
    (the compose file maps it through to the container's `PORT`) and restart.
  - **Linux / macOS:** set `PORT` in the env file
    (`/etc/loombre/loombre.env` on Linux;
    `/Library/Application Support/Loombre/config/loombre.env` on macOS)
    and restart the services.
  - **Windows:** there is no port variable to set after the fact — the
    ports are written into each service's registry `Environment` value at
    install time; see [the Windows page's Configure
    section](/install/windows#configure).

### Database connection refused

**Symptom:** "connect ECONNREFUSED" on startup, or "database connection failed"

**Fix depends on your setup:**

1. **Embedded PostgreSQL (Linux, Windows, macOS):**
   - Check the data directory exists and is writable:
     - Linux: `ls -ld /var/lib/loombre/` should show `loombre` ownership
     - macOS: `ls -ld "/Library/Application Support/Loombre/postgres/data/"`
     - Windows: Check `%ProgramData%\Loombre\postgres\data\`
   - If missing, the server should auto-provision it on first start. If it doesn't, check startup logs.

2. **External PostgreSQL:**
   - Verify the `DATABASE_URL` connection string is correct (on Windows it
     lives in each service's registry `Environment` value — see [the
     Windows page's Configure section](/install/windows#configure))
   - Test connectivity: `psql "$DATABASE_URL"` (or use `pg_isready` on Linux)
   - Ensure PostgreSQL 17+ is running
   - Check firewall rules allow connection from the Loombre host to the database host

### Logs not appearing / can't debug startup

**Linux (systemd):**
```bash
journalctl -u loombre-server -n 100   # last 100 lines
journalctl -u loombre-server -f       # live follow
```

**macOS (LaunchDaemon):**
```bash
tail -f "/Library/Logs/Loombre/server.out.log"
# or: log stream --predicate 'eventMessage contains[cd] "loombre"'
```

**Windows (Services):**
Check `%ProgramData%\Loombre\logs\server.log` via Explorer, or PowerShell:
```powershell
Get-Content -Tail 50 "$env:ProgramData\Loombre\logs\server.log"
```

**Docker** (from the repo root, like every Compose command in
[docs/install/docker.md](/install/docker)):
```bash
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env logs server -f
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env logs worker -f
```

---

## Platform-specific issues

### macOS

#### Gatekeeper blocks the app even after "Open Anyway"

**Symptom:** You clicked Open Anyway, but Gatekeeper blocks it again

**Cause:** macOS caches the Gatekeeper decision. The quarantine attribute (`com.apple.quarantine`) may need to be explicitly removed.

**Fix:**
```bash
xattr -d com.apple.quarantine loombre-*.pkg
sudo installer -pkg loombre-*.pkg -target /
```

#### `_loombre` service account has wrong permissions

**Symptom:** Permission denied on `/Library/Application Support/Loombre/`

**Fix** — restore exactly what the installer sets
(`installers/macos/pkg/scripts/postinstall`). The app-support **root**
directory must end up group `admin` (not group `_loombre`): the menubar
app runs as your console user, not `_loombre`, and needs to traverse the
root to reach the server's IPC discovery/token files — a recursive
`_loombre:_loombre` chown alone breaks the menubar app:

```bash
sudo chown -R _loombre:_loombre "/Library/Application Support/Loombre/"
sudo chown _loombre:admin "/Library/Application Support/Loombre/"
sudo chmod 750 "/Library/Application Support/Loombre/"
sudo chmod 750 "/Library/Application Support/Loombre/db" \
              "/Library/Application Support/Loombre/ipc" \
              "/Library/Application Support/Loombre/config"
sudo chmod 700 "/Library/Application Support/Loombre/secrets"
sudo chown -R _loombre:_loombre "/Library/Logs/Loombre/"
sudo chmod 755 "/Library/Logs/Loombre/"
```

(The server re-chowns the IPC *files*' group itself on every boot; the
root directory's group is the part only you can fix here.)

#### LaunchDaemon doesn't start on boot

**Symptom:** Services don't run after restart

**Check:**
```bash
sudo launchctl print system/com.loombre.server
sudo launchctl print system/com.loombre.worker
sudo launchctl print system/com.loombre.web
```

**If missing, re-enable:**
```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/com.loombre.server.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.loombre.worker.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.loombre.web.plist
```

### Windows

#### Tray icon won't open (SmartScreen blocks it every time)

**This is expected:** SmartScreen blocks any unsigned, low-download-count executable. 
Click **More info → Run anyway** every time.

**Workaround:** If this becomes too annoying, you can manage the server/worker
directly via services.msc instead of the tray UI. (Expected while Loombre stays
unsigned — a deliberate, unfunded posture with no scheduled end, not a temporary
gap; see [windows.md's "Why Windows will warn
you"](/install/windows#why-windows-will-warn-you-before-you-can-run-this).)

#### Services show "Starting" and never reach "Running"

**Check logs:**
```powershell
Get-Content -Tail 100 "$env:ProgramData\Loombre\logs\server.log"
```

**Common issues:**
- Embedded PostgreSQL still provisioning — the very first boot does a real
  `initdb` + migration run; give it a minute and check again
- A bad `DATABASE_URL` in the service's registry `Environment` value
  (external-Postgres installs only — the default install sets none and runs
  embedded PostgreSQL; see [the Windows page's Configure
  section](/install/windows#configure))
- Port 3001 in use by another process (see "Port already in use" above)

#### Firewall blocks the server

**Symptom:** Other devices on the network can't reach Loombre

The installer registers two inbound firewall rules, **Loombre Server** and
**Loombre Web**.
- Check: Windows Defender Firewall → Inbound Rules → Loombre Server and Loombre Web (both should be enabled)
- If using a third-party firewall, manually add rules allowing TCP ports 3001 and 3000 (or your custom ports — on Windows these are written into each service's registry `Environment` value at install time; see [the Windows page's Configure section](/install/windows#configure))

### Linux

#### Permission errors reading library folders

**Symptom:** Scan finds zero items despite correct folder paths

**Cause:** The `loombre` system user can't read the library folder

**Fix:**
```bash
sudo chown -R loombre:loombre /path/to/library   # if owned by a different user
sudo chmod o+rx /path/to/library               # if using NFO sidecars
```

Test it:
```bash
sudo -u loombre ls /path/to/library
```

#### systemd service won't start

**Check status:**
```bash
systemctl status loombre-server
```

**Common issues (from journalctl output):**
- Port in use: change `PORT` in `/etc/loombre/loombre.env` or stop the
  conflicting process
- Data directory permission denied: `sudo chown -R loombre:loombre /var/lib/loombre/`

#### Tarball extraction failed

**Symptom:** Extract command hangs or gives a partial directory

**Fix:**
```bash
# Verify the tarball itself
tar -tzf loombre-*.tar.gz > /dev/null && echo "Tarball OK"

# Re-extract to a fresh directory
mkdir ~/loombre-tmp
cd ~/loombre-tmp
tar xzf ~/loombre-*.tar.gz
cd loombre-*/
sudo ./install.sh
```

### Docker

Run every command below from the repo root, with the same
`-f docker-compose.prod.yml --env-file installers/docker/loombre.env` pair
used throughout [docs/install/docker.md](/install/docker) — the repo ships
no default-named compose file, and `docker-compose.prod.yml` requires the
variables in `loombre.env`, so bare `docker compose` invocations fail.

#### `postgres` service never becomes healthy

**Check logs:**
```bash
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env logs postgres
```

**Common issues:**
- `POSTGRES_PASSWORD` not set or empty
- Docker volume permissions (rare): `docker volume ls` then inspect the volume

#### First `docker compose ... up -d` hangs building the image

**This is normal:** Building from source for the first time can take 5–10 minutes,
depending on your Docker cache and network speed. Wait for it to finish, or check
progress with:
```bash
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env build --progress=plain
```

#### Everything else

The remaining Docker issues are covered, next to the commands they belong
to, in [docker.md's own Troubleshooting
section](/install/docker#troubleshooting): missing env-file/secret errors,
a `server` that never reports healthy (usually an unmigrated schema), a
`worker` that exits immediately (usually `DATABASE_URL` unreachable),
bind-mounted libraries scanning zero files, NAS media never noticing new
files, and login/CORS/CSP failures.

---

## Known limitations and workarounds

### Embedded PostgreSQL major-version upgrade

**Scenario:** A Loombre release moves the embedded PostgreSQL to a new
major version (for example 17 → 18).

**What happens:** Nothing automatic. At boot, Loombre compares the data
directory's `PG_VERSION` against the release's pinned major; a mismatch is
reported as an unusable data directory (`pg-version-mismatch`) and **the
server refuses to start** rather than touch your data. No automatic
upgrade runs and no automatic backup is taken. (An upgrade routine exists
in the codebase — `EmbeddedPostgres.upgrade()` — but nothing invokes it at
boot today.)

**What you do:** A manual dump-and-restore. **Before** installing the new
release, while the old version still runs, take a `pg_dumpall` backup —
`docs/ops/backup.md`'s "Embedded PostgreSQL" section has the exact
command. Then install the new release, move the old
`<app-data>/postgres` directory aside so a fresh cluster provisions on
first boot, and restore the dump into it per the same page's restore
guidance.

**Docker installs** have no embedded PostgreSQL at all — the catalog lives
in the separate `postgres` container. The equivalent situation there is
the container image moving to a new Postgres major: the same
dump-before-upgrade, restore-after ritual applies to that container's
volume (`docker-compose.prod.yml`'s own comments link here for exactly
that case).

### HLS playback stutters or rebuffers

**Common cause:** Your reverse proxy is buffering HLS segments

**Fix:** See `docs/ops/remote-access/reverse-proxy.md` requirement #2 — add `proxy_buffering off`
(nginx) or ensure your proxy streams responses without buffering (Caddy/Traefik do
this by default).

### macOS: `_loombre` can't read media in your home folder

**Symptom:** The folder picker marks a home-folder path **No access**, or a
mount under `~` isn't readable by Loombre.

**Why:** macOS keeps personal home folders private (`/Users/you` is mode
700/750), so the `_loombre` service account cannot traverse them. That is
the system working as designed, not a broken install.

**Fix:** See the "Media in your home folder" section of
[docs/install/macos.md](/install/macos) — it covers the easy placements
(`/Volumes`, `/Users/Shared`), the targeted ACL grant for media that must
stay in your home folder, and when Full Disk Access does (and does not)
matter.

---

## Reporting issues

If you hit a problem not listed here:

1. **Collect logs:**
   - All startup logs (the first 50–100 lines when you started the service)
   - The specific error message (not a paraphrase)
   - Your OS, CPU, RAM, and Loombre version
   - How you installed (Docker, tarball, .exe installer, .pkg, Homebrew)

2. **Paste the logs** (redact database passwords and secret tokens) on the GitHub
   Issues page — include enough context that the error is reproducible.

3. **Don't assume it's a bug:** permission issues, network issues, and disk-space
   issues account for the majority of real problems. Follow the checklist above
   for your platform first.
