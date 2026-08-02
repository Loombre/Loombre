# The loombre command-line tool

Loombre ships a small, server-local command-line tool (`loombre`) for
read-only environment checks and a small set of privileged recovery
operations. It does not talk to your instance over the network — it runs
directly on the machine your server runs on, against the same
`DATABASE_URL` your server uses. Running it at all requires filesystem
access to that machine; that access **is** the privilege boundary for the
commands that change data (`admin reset-pin` and `admin reset-password`,
below) — there is no equivalent over HTTP for `admin reset-pin`, and none
is planned for it (`admin reset-password`'s own admin-UI equivalent does
exist over HTTP, for a signed-in admin — see the admin guide's
[Users & permissions](../admin-guide/users-permissions.md) page).

## Running it

**In a source checkout** (a clone you're developing against, or building
from):

```bash
node apps/server/bin/loombre.mjs --help
```

**In a Linux tarball install** (`docs/install/linux.md`), `install.sh`
places a `loombre` shim on `PATH` (`/usr/local/bin/loombre`, a symlink into
the install root — `installers/linux/LAYOUT.md`), so once installed it's
just:

```bash
loombre --help
```

**Channel availability:** as of this writing the `loombre` CLI ships in
source checkouts and the Linux tarball only — the macOS `.pkg` and Windows
installer do not currently include it (their server payloads are pruned to
runtime files). On those platforms, commands documented here (including
the PIN reset below) need a source checkout pointed at the same database.

If the shim couldn't be placed (a foreign, non-symlink file already sat at
`/usr/local/bin/loombre`, or `/usr/local/bin` wasn't writable — `install.sh`
warns and prints the exact `ln -s` command to create it yourself when this
happens), fall back to the tarball's own bundled Node runtime, from the
install root:

```bash
runtime/node/bin/node lib/server/bin/loombre.mjs --help
```

Either way, the tool needs `DATABASE_URL` set (same connection string
your server uses) for the `admin` command family below — every other
command works without it.

## Commands

- `loombre` / `loombre --help` — usage.
- `loombre --version` — the running version string.
- `loombre paths` — the resolved app-data/config directories for this
  platform (honors `LOOMBRE_DATA_DIR`/`LOOMBRE_CONFIG_DIR`).
- `loombre doctor` — read-only sanity checks: is `DATABASE_URL` set and
  well-formed, are `ffmpeg`/`ffprobe` resolvable and runnable, is the data
  directory writable. Nothing here writes to disk or the database; it
  only reports.
- `loombre admin reset-pin <username>` — the PIN-reset recovery procedure
  below.
- `loombre admin reset-password <username>` — sets a random temporary
  password for a user (recovery for a forgotten account password), shown
  once; the user must change it on next login and every existing session
  for that account is signed out immediately. Same interactive-confirmation
  posture as `admin reset-pin` (no `--yes` flag, needs `DATABASE_URL`).

## Forgot a PIN?

If someone using your Loombre forgets their restricted-content PIN, there
is no self-service recovery for that by design — nobody, including an
admin, can see or choose that PIN for them (see the admin guide's
[Users & permissions](../admin-guide/users-permissions.md) page). The
recovery is this command, run on the server itself:

```bash
DATABASE_URL=<your server's connection string> \
  loombre admin reset-pin <username>
```

(substitute the source-checkout or full-path invocation from "Running it"
above if that's your install type). It will:

1. Look up the user, and print a clean error and exit if the username
   doesn't exist — nothing changes.
2. Print exactly what it's about to do and ask you to confirm **by
   typing `y` or `yes`** — anything else (including just pressing enter)
   aborts with nothing changed. There is no flag to skip this prompt;
   the interactive confirmation is the point.
3. On confirmation, clear that user's PIN, turn off their
   restricted-content opt-in, and end any currently-active unlock for
   them, all together. Their existing library access grants and every
   other account setting are untouched.
4. Print a one-line summary of what was cleared.

A user who has never opted in to restricted content at all has nothing to
clear — the command says so and changes nothing.

Afterward, the person just opts back in to restricted content from their
own account settings and picks a brand-new 4-digit PIN, exactly like the
first time. This action is recorded in the admin event feed (a
`user.restricted-pin-reset` entry, visible to admins only) so there's an
audit trail of who reset what and when — the entry never contains the
PIN itself, old or new.

## Forgot a password?

If someone using your Loombre forgets their account password, an admin
can reset it for them from the Users screen (see the admin guide's
[Users & permissions](../admin-guide/users-permissions.md#resetting-a-password)
page) — or, without a browser at all, this command, run on the server
itself:

```bash
DATABASE_URL=<your server's connection string> \
  loombre admin reset-password <username>
```

(substitute the source-checkout or full-path invocation from "Running it"
above if that's your install type). It will:

1. Look up the user, and print a clean error and exit if the username
   doesn't exist — nothing changes.
2. Print exactly what it's about to do and ask you to confirm **by
   typing `y` or `yes`** — anything else (including just pressing enter)
   aborts with nothing changed. There is no flag to skip this prompt;
   the interactive confirmation is the point.
3. On confirmation, generate a random temporary password, hash and store
   it, and require the user to choose their own real password the next
   time they sign in. Every device that user was signed in on is signed
   out immediately, all together. Their existing library access grants
   and every other account setting are untouched.
4. Print the temporary password and a one-line summary of what changed.

Write the temporary password down before you close the terminal — it is
shown exactly once, and Loombre only ever stores its hash, never the
password itself.

A user who doesn't exist has nothing to reset — the command says so and
changes nothing.

Afterward, the person signs in with the temporary password and picks a
real one of their own immediately — Loombre requires it before letting
them do anything else. This action is recorded in the admin event feed (a
`user.password-reset` entry, actor `cli`, visible to admins only) so
there's an audit trail of who reset what and when — the entry never
contains the password itself, temporary or new.

## See also

- [`loombre doctor`](#commands) and [`loombre paths`](#commands) above,
  for pre-flight and troubleshooting checks.
- [Environment variable reference](env-reference.md) for every variable
  the server itself reads, including `DATABASE_URL`.
