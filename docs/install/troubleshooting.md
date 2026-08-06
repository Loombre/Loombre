# Troubleshooting Loombre installation

This page covers real issues discovered during Phase 4 development and 
testing. All solutions have been verified against the actual codebase.

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
- Change the port: set `LOOMBRE_PORT` to a different port (e.g., 3002) and restart

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
   - Verify the `DATABASE_URL` connection string is correct
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

**Fix:**
```bash
sudo chown -R _loombre:_loombre "/Library/Application Support/Loombre/"
sudo chown -R _loombre:_loombre "/Library/Logs/Loombre/"
sudo chmod 750 "/Library/Application Support/Loombre/"
```

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

**Workaround:** If this becomes too annoying before the release pipeline signs the
tray binary, you can manage the server/worker directly via services.msc instead of
the tray UI.

#### Services show "Starting" and never reach "Running"

**Check logs:**
```powershell
Get-Content -Tail 100 "$env:ProgramData\Loombre\logs\server.log"
```

**Common issues:**
- Database not ready yet — wait a moment and check status again
- `DATABASE_URL` or `LOOMBRE_JWT_SECRET` not set in the environment
- Port 3001 in use by another process (see "Port already in use" above)

#### Firewall blocks the server

**Symptom:** Other devices on the network can't reach Loombre

The installer registers two inbound firewall rules, **Loombre Server** and
**Loombre Web**.
- Check: Windows Defender Firewall → Inbound Rules → Loombre Server and Loombre Web (both should be enabled)
- If using a third-party firewall, manually add rules allowing TCP ports 3001 and 3000 (or your custom `LOOMBRE_PORT`/`LOOMBRE_WEB_PORT`)

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
- Port in use: change `LOOMBRE_PORT` or stop the conflicting process
- Data directory permission denied: `sudo chown -R loombre:loombre /var/lib/loombre/`
- Missing `LOOMBRE_JWT_SECRET`: Set it in `/etc/loombre/loombre.env`

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

#### `server` container exits immediately

**Check logs:**
```bash
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env logs server
```

**Common issues:**
- `LOOMBRE_JWT_SECRET` not set
- `DATABASE_URL` (for external Postgres mode) is unreachable or malformed
- Port 3001 already bound on the host

#### `worker` container exits but `server` stays running

**Symptom:** Only the worker fails

**Check logs:**
```bash
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env logs worker
```

**Common issue:** `DATABASE_URL` is unreachable. If using external Postgres, verify
the connection string and network reachability from inside the Docker container:
```bash
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env exec server psql "$DATABASE_URL" -c "SELECT version();"
```

#### Bind-mounted library shows zero files after scan

**Common causes:**
- Path mismatch: you set `/media/movies` in Loombre, but mounted `/mnt/media`
- Container can't read the mount: permissions on the host folder
- Relative vs. absolute path: always use absolute paths in bind-mounts

**Verify the mount inside the container:**
```bash
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env exec server ls /media/movies
```

---

## Known limitations and workarounds

### Embedded PostgreSQL major-version upgrade

**Scenario:** You want to upgrade from embedded PG 17 to PG 18

**What happens:** Loombre detects the version mismatch and automatically runs a
`dump-restore` upgrade cycle the first time it boots against the new PG version.
This takes time proportional to your library size (see `docs/ops/backup.md`'s
"Pre-upgrade backup" section for details).

**What you don't need to do:** Nothing — Loombre handles it automatically.

**If the upgrade fails:** A backup of your old data directory was created
automatically before the upgrade attempted. Check the server logs for the exact
failure reason.

### HLS playback stutters or rebuffers

**Common cause:** Your reverse proxy is buffering HLS segments

**Fix:** See `docs/ops/remote-access/reverse-proxy.md` requirement #2 — add `proxy_buffering off`
(nginx) or ensure your proxy streams responses without buffering (Caddy/Traefik do
this by default).

### Resume doesn't work across devices

**Scenario:** You start watching on Device A, switch to Device B, expect to resume
at the same timestamp

**Current behavior:** Each device has its own progress tracking. Resume works within
the same device, but jumping between devices starts from the beginning.

**Workaround:** Continue-watching shows your recently-played items; the web client
displays last-watched timestamps.

**Timeline:** Post-v1 feature (multi-device resume state).

### macOS: `_loombre` user can't access networked home folder

**Symptom:** SMB/NFS mount at `~/Media/` isn't readable by Loombre

**Why:** The `_loombre` service account has `NFSHomeDirectory /var/empty` and no
login session, so `~` doesn't expand to a meaningful path.

**Workaround:** Mount the network share at a system-wide path (e.g., `/Volumes/Media`)
instead of a user folder, or enable SMB/NFS access for the `_loombre` user explicitly
via System Settings → Sharing.

---

## Reporting issues

If you hit a problem not listed here:

1. **Collect logs:**
   - All startup logs (the first 50–100 lines when you started the service)
   - The specific error message (not a paraphrase)
   - Your OS, CPU, RAM, and Loombre version
   - How you installed (Docker, tarball, MSI, .pkg, Homebrew)

2. **Paste the logs** (redact database passwords and secret tokens) on the GitHub
   Issues page — include enough context that the error is reproducible.

3. **Don't assume it's a bug:** permission issues, network issues, and disk-space
   issues account for the majority of real problems. Follow the checklist above
   for your platform first.
