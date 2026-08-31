# keys/ — the minisign trust root

`keys/minisign.pub` is **one of the three P4.9 trust roots** the release
manifest's minisign public key must be published, byte-identical, in:

1. **This file** (`keys/minisign.pub`, committed to the repo — the source
   of the server's compiled-in verification key:
   `scripts/release/embed-public-key.mjs` regenerates
   `packages/shared/src/update-public-key.ts` from it, and the
   update-check verifier at `apps/server/src/common/update-check/`
   imports only that constant).
2. **The docs site** (`docs/ops/updating.md`'s "Verifying releases"
   section).
3. **Every GitHub Release's notes** (`scripts/release/release-notes-
   template.md`, rendered by `scripts/release/render-release-notes.mjs`
   and attached to each GitHub Release by `.github/workflows/release.yml`
   — the template embeds the same key text so a release is independently
   verifiable even without cloning the repo).

`scripts/release/check-pubkey-consistency.mjs` is the CI-runnable proof
of consistency, and it checks **five locations**, not just the three
trust roots: those three PLUS the generated
`packages/shared/src/update-public-key.ts` (a
did-you-forget-to-regenerate freshness check, not an independent trust
root) PLUS `docs/install/linux.md`, which also displays the key for
downloaders (not a trust root either — added after an audit found it
still showing the all-zero placeholder once the real key had landed
everywhere else). See `scripts/release/lib/pubkey-consistency.mjs`'s
header for exactly what it diffs. **A key-substitution attack requires
compromising the three independently-controlled trust roots
simultaneously**; that's the whole point of P4.9. (The public download
page on loombre.com embeds a further copy of the key outside these five
checked locations — per CLAUDE.md's Documentation Sync rule it must be
updated in the same session whenever the key changes here.)

## The file currently committed is the REAL key

`keys/minisign.pub` is the real, in-use release-signing public key (key ID
`9EA9BD1D8785E084`, landed in 66ce28d — "real minisign trust root —
placeholder era over (P4.9)"). It verifies genuine releases signed with the
matching secret key held offline by the owner and mirrored into the
`LOOMBRE_MINISIGN_SECKEY` GitHub Actions secret. **Do not regenerate or
overwrite this file** — doing so desyncs it from the secret key that
actually signs releases in CI and orphans every install already pinned to
this key. `check-pubkey-consistency.mjs` only checks "do the five
locations agree with each other, and does none of them hold the
placeholder" — it does NOT detect a wrongful key rotation, so this file
being overwritten would go undetected by CI.

## Rotating the keypair (owner, offline — a real operational event)

Only do this to actually replace the live signing key (e.g. suspected
secret-key compromise) — never to "generate the real key for the first
time"; that step is already done. This is entirely a **local, offline,
manual** step — no CI job generates signing key material, ever (P4.18:
standard `Ed` mode, never `-x` pre-hashed).

```bash
# Requires the minisign binary (https://jedisct1.github.io/minisign/):
#   macOS:   brew install minisign
#   Linux:   apt/dnf/pacman package `minisign`, or build from source
#   Windows: scoop/choco package `minisign`, or WSL

minisign -G -p /tmp/minisign.pub -s ~/.loombre-release-signing.key

# -p: the PUBLIC key output path — write it to a SCRATCH path, not
#     keys/minisign.pub directly. keys/minisign.pub is the live trust
#     root; overwriting it in place before the new key is wired
#     everywhere (see "Wiring" below) breaks verification for every
#     install pinned to the old key with no warning.
# -s: the SECRET key output path — NEVER inside the repo, NEVER committed.
#     minisign prompts for (and requires) a passphrase protecting it.
```

You will be prompted for a passphrase — pick a strong one; it's the only
thing standing between "a leaked secret-key file" and "a leaked signing
key". Store the secret key file (`~/.loombre-release-signing.key` above, or
wherever you chose) somewhere durable and backed up — losing it means every
future release needs a new keypair, which means re-wiring every checked
location (below) and every existing install's pinned key going stale.

Be honest about what rotation costs: there is **no runtime override** for
the pinned key. It is a compile-time constant
(`packages/shared/src/update-public-key.ts`; see
`scripts/release/lib/embed-public-key.mjs`'s header for why the server
deliberately never reads a key file off disk). An install pinned to the
old key will keep failing update-manifest verification until it is
replaced by a build that embeds the new key — and it cannot get that
build through the now-unverifiable update channel; the operator must
fetch the new release out-of-band and verify it against the newly
published key. A rotation is a real operational event, not a shrug.

## Wiring the new key into every checked location

1. **This repo**: copy the scratch public key over `keys/minisign.pub`
   (this is the file `minisign -G -p` wrote above) and commit it. Run
   `pnpm embed-public-key` (regenerates
   `packages/shared/src/update-public-key.ts` — the server's compiled-in
   copy) and commit that too.
2. **Docs site**: paste the same file's contents into
   `docs/ops/updating.md`'s "Verifying releases" section (between the
   `LOOMBRE_MINISIGN_PUBLIC_KEY_BEGIN`/`_END` markers).
3. **Release notes template**: paste the same file's contents into
   `scripts/release/release-notes-template.md` (between the same markers).
4. **Install guide**: paste the same file's contents into
   `docs/install/linux.md`'s marker block. Not a P4.9 trust root, but a
   CI-checked location — a previous rotation that followed the
   then-three-location version of this runbook left that page on the
   all-zero placeholder (the H5 audit residue), which is exactly why the
   consistency gate now covers it.

Then run `node scripts/release/check-pubkey-consistency.mjs` locally (also
wired into `.github/workflows/release.yml`) to confirm all five locations
— the four above plus the regenerated `update-public-key.ts` from step 1 —
are byte-identical. Finally, remember the loombre.com download page's
embedded copy (outside the five checked locations): update it in the same
session, per CLAUDE.md's Documentation Sync rule.

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
