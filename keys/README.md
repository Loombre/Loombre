# keys/ — the minisign trust root

`keys/minisign.pub` is **one of the three P4.9 locations** the release
manifest's minisign public key must be published, byte-identical, in:

1. **This file** (`keys/minisign.pub`, committed to the repo — what the
   server itself reads to verify a fetched update manifest, see
   `scripts/release/embed-public-key.mjs` and
   `apps/server/src/session/update-check/`).
2. **The docs site** (`docs/ops/updating.md`'s "Verifying releases"
   section).
3. **Every GitHub Release's notes** (`scripts/release/release-notes-
   template.md`, rendered by `scripts/release/render-release-notes.mjs`
   and attached to each GitHub Release by `.github/workflows/release.yml`
   — the template embeds the same key text so a release is independently
   verifiable even without cloning the repo).

`scripts/release/check-pubkey-consistency.mjs` is the CI-runnable proof
that all three agree — see its header for exactly what it diffs. **A
key-substitution attack requires compromising all three simultaneously**;
that's the whole point of publishing it in three independently-controlled
places (P4.9).

## The file currently committed is a PLACEHOLDER

`keys/minisign.pub` right now is a structurally-valid-but-cryptographically-
inert all-zero key (see the file's own `untrusted comment:` line) — it
parses correctly (so tooling that reads it doesn't crash), but it can never
verify a real signature. **Do not ship a release signed against this key.**
`check-pubkey-consistency.mjs` deliberately does NOT check "is this the
placeholder" — it only checks "do the three locations agree with each
other" — so replacing the placeholder in all three places at once keeps
that check green throughout.

## Generating the real keypair (owner, offline, once)

This is entirely a **local, offline, manual** step — no CI job generates
signing key material, ever (P4.18: standard `Ed` mode, never `-x`
pre-hashed).

```bash
# Requires the minisign binary (https://jedisct1.github.io/minisign/):
#   macOS:   brew install minisign
#   Linux:   apt/dnf/pacman package `minisign`, or build from source
#   Windows: scoop/choco package `minisign`, or WSL

minisign -G -p keys/minisign.pub -s ~/.loombre-release-signing.key

# -p: the PUBLIC key output path — point it straight at keys/minisign.pub
#     so the file this repo tracks IS the real public key from the start
#     (no separate copy step to forget).
# -s: the SECRET key output path — NEVER inside the repo, NEVER committed.
#     minisign prompts for (and requires) a passphrase protecting it.
```

You will be prompted for a passphrase — pick a strong one; it's the only
thing standing between "a leaked secret-key file" and "a leaked signing
key". Store the secret key file (`~/.loombre-release-signing.key` above, or
wherever you chose) somewhere durable and backed up — losing it means every
future release needs a new keypair, which means updating all three P4.9
locations again and every existing install's pinned key goes stale (still
recoverable — `LOOMBRE_UPDATE_PUBLIC_KEY_PATH`/a new install picks up the
new key — but it's a real operational event, not a shrug).

## Wiring the real key into the three locations

1. **This repo**: commit the real `keys/minisign.pub` in place of the
   placeholder (this is the file `minisign -G -p` wrote above). Run
   `pnpm embed-public-key` (regenerates
   `packages/shared/src/update-public-key.ts` — the server's compiled-in
   copy) and commit that too.
2. **Docs site**: paste the same file's contents into
   `docs/ops/updating.md`'s "Verifying releases" section (between the
   `LOOMBRE_MINISIGN_PUBLIC_KEY_BEGIN`/`_END` markers).
3. **Release notes template**: paste the same file's contents into
   `scripts/release/release-notes-template.md` (between the same markers).

Then run `node scripts/release/check-pubkey-consistency.mjs` locally (also
wired into `.github/workflows/release.yml`) to confirm all three — plus the
generated `update-public-key.ts` — are byte-identical.

## GitHub Actions secret (CI signing)

The **secret** key (never this directory) needs to reach the release
workflow as an encrypted GitHub Actions secret:

```bash
# minisign secret key files are already encrypted-at-rest by minisign
# itself (passphrase-protected) — base64 it as a transport encoding only,
# the passphrase is what GitHub Secrets actually protects:
base64 -i ~/.loombre-release-signing.key | pbcopy   # macOS
```

Repo → **Settings → Secrets and variables → Actions** → New repository
secret:

| Secret name | Value |
|---|---|
| `LOOMBRE_MINISIGN_SECKEY` | the base64'd secret-key file contents (above) |
| `LOOMBRE_MINISIGN_SECKEY_PASSWORD` | the passphrase you chose at `minisign -G` time |

`.github/workflows/release.yml` decodes `LOOMBRE_MINISIGN_SECKEY` back to
the secret-key file and pipes `LOOMBRE_MINISIGN_SECKEY_PASSWORD` to
`minisign -S` non-interactively — see that workflow's `release` job. Both
secrets are consumed only inside that one job, never logged (GitHub
Actions redacts registered secret values from logs automatically, but the
workflow additionally never echoes either one).

## Local (off-CI) signing

`scripts/release/sign-manifest.mjs` shells out to a **locally-installed**
`minisign` binary if present (same offline capability the CI job has, for
a hotfix cut outside the normal pipeline) and skips with a clear message
if `minisign` isn't on PATH — it never installs anything itself (no new
deps, ever, per this package's whole reason for existing).
