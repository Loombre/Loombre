# @loombre/release-manifest

The release manifest format (P4.3) and the release-manager blessing-signature
decision it depends on.

## DECISION

**minisign**, standard (non-prehashed `Ed`) variant only, verified
server-side using `node:crypto` with **zero new runtime dependencies**.
Sigstore is rejected for this specific use — the *release-manager's blessing
signature on `manifest.json`* — not because it is a bad technology, but
because its offline/keyless trust model is a poor fit for a self-hosted,
zero-telemetry, solo-maintained product where the verifying party is a
Tier-0 server with no persistent trust-root infrastructure of its own.
GitHub artifact attestations (`attest-build-provenance`) land separately in
the release-pipeline lane regardless of this decision — Sigstore-based
provenance exists in the pipeline either way; this decision is *only* about
the signature the server checks during the notify-only update check (P4.3).

The zero-dep spike is proven, not assumed: `test/minisign-verify.spec.ts`
generates a real ed25519 keypair with `node:crypto`, hand-encodes it into
the actual minisign wire format (byte-for-byte, per the spec cited below),
signs a fixture manifest, and verifies it back using nothing but
`node:crypto`'s `createPublicKey`/`sign`/`verify`. Tamper fixtures (bit-flip,
wrong key, truncated signature) all fail closed.

---

## The minisign format, and which variant this package supports

[minisign](https://jedisct1.github.io/minisign/) (Frank Denis / jedisct1) is
a small, spec-stable, ed25519-based signing tool descended from OpenBSD's
`signify`. A detached signature file (`<file>.minisig`) is four text lines:

```
untrusted comment: <free text, NOT authenticated>
<base64: sig_alg(2) || key_id(8) || signature(64)>
trusted comment: <free text, AUTHENTICATED by the global signature>
<base64: global_signature — Ed25519 over (signature(64) || trusted_comment_bytes)>
```

`sig_alg` is the two ASCII bytes that select the signing mode:

- **`Ed`** (`0x45 0x64`) — the ed25519 signature is computed directly over
  the message bytes. This is the classic, "PureEdDSA" mode.
- **`ED`** (`0x45 0x44`) — the message is first hashed with BLAKE2b-512, and
  the ed25519 signature is computed over that 64-byte hash instead. minisign
  calls this the *prehashed* mode (its own docs also call it "hashed" mode);
  it exists so minisign can sign arbitrarily large files without holding the
  whole file in memory to feed a streaming ed25519 signer.

**This package verifies `Ed` (standard) only** and fails closed with a
distinct typed reason (`unsupported-prehashed-variant`) on `ED`. Rationale:

1. **We control both ends.** Unlike a general-purpose minisign *verifier*
   consuming arbitrary third-party `.minisig` files, this package only ever
   needs to verify signatures our *own* release-manager tooling produced.
   We choose the algorithm at signing time — nothing forces `ED` on us.
2. **The payload is small.** `manifest.json` is a small JSON document
   (kilobytes), not a multi-gigabyte installer artifact. Prehashing exists
   to avoid buffering large files for a streaming signer; it buys nothing
   here and the artifacts themselves are checksummed via the manifest's own
   `sha256` field, not signed individually.
3. **Smaller, more auditable surface.** Supporting `ED` would mean depending
   on BLAKE2b being available (`node:crypto`'s `createHash('blake2b512')`
   does exist on modern OpenSSL-backed Node builds, but adding a second
   algorithm path doubles the code this package's security properties rest
   on for a case we do not need).
4. **Fail closed, not silently wrong.** A `.minisig` declaring `ED` is
   recognized (so the failure reason is informative — "we don't support
   this", not "malformed file") and always rejected, never mis-verified as
   if it were `Ed`.

---

## Evaluation: minisign vs. sigstore for the release-manager blessing signature

### (a) Server-side verification weight on Tier-0 Node

**minisign:** Node's built-in `crypto.verify(null, data, keyObject, sig)`
implements ed25519 verification natively (OpenSSL's EVP interface). The only
non-builtin work is parsing minisign's two-line/four-line text format and
base64-decoding — trivial string/`Buffer` operations. Confirmed by spike:
zero new npm packages, two ed25519 verify calls (manifest signature + the
trusted-comment's global signature), sub-millisecond CPU cost. This is
exactly the kind of cheap, synchronous, dependency-free check Tier-0
(N100/4GB) work should be.

**sigstore:** verifying a Sigstore bundle offline (no live Rekor/Fulcio
calls) requires the `@sigstore/*` verification stack (bundle parsing,
certificate-chain validation against the Sigstore root, and — if you want a
*fully* offline verify with no periodic network sync — bundling and
refreshing the Sigstore TUF trust root). That is a real dependency tree
(`@sigstore/verify`, `@sigstore/protobuf-specs`, `tuf-js`, transitively
`make-fetch-happen` and friends historically) for a Tier-0 server to carry
and audit. Not disqualifying on its own, but strictly heavier than "call a
builtin".

**Verdict: minisign, clearly.**

### (b) Offline verification / D14 (zero identifying payload beyond the manifest fetch)

**minisign:** the entire trust root is one 32-byte ed25519 public key baked
into the binary (P4.9: published in three places). Verification is 100%
local against whatever `manifest.json` + `manifest.json.minisig` the update
check already fetched — no additional network call, no transparency-log
lookup, nothing to keep in sync.

**sigstore's classic (online) model** relies on Fulcio-issued short-lived
certificates bound to an OIDC identity, checked against the public Rekor
transparency log at verify time — exactly the kind of extra network
round-trip D14 forbids ("the update check must carry zero identifying
payload"; a Rekor lookup is an extra outbound call this product does not
want to make on every version check, full stop, regardless of what it would
or wouldn't identify). The offline-bundle variant avoids the live network
call but shifts the burden onto pinning and periodically rotating the
Sigstore TUF trust root — a small ongoing trust-root-freshness problem
minisign's one static key does not have.

**Verdict: minisign is a strictly better fit for D14 and for "no phone-home,
ever."**

### (c) Key management for a solo maintainer + P4.9's three-location consistency

**minisign:** one keypair, generated once (`minisign -G`), secret key
passphrase-protected on the maintainer's machine. The public key is a single
short base64 blob — trivial to paste into all three P4.9 locations (repo,
docs site, release notes) and trivial to eyeball-diff if ever in doubt.
Rotation, if ever needed, is "generate a new pair, update three places" —
an entirely manual, entirely offline process with no external dependency.

**sigstore's keyless model** removes long-term key custody, which is a
genuinely nice property for teams — but it replaces it with a dependency on
Sigstore's public-good Fulcio/Rekor infrastructure remaining available and
trustworthy indefinitely, and on the maintainer's OIDC identity provider.
For a solo maintainer building a self-hosted, phone-home-free product,
trading "one file I control" for "a third party's federated CT-log service I
don't" is a downgrade in the specific property this project optimizes for
(architecture invariant 7: no telemetry or phone-home *of any kind* — the
verifying **server**, not just the signing step, is the thing that must stay
fully self-contained).

**Verdict: minisign fits the solo-maintainer + self-hosted posture better.**

### (d) License compatibility

**minisign:** the format is openly published; this package's parser/verifier
is original code with zero new runtime dependencies, so there is nothing new
to clear against D12's allow-list.

**sigstore:** the JS packages are Apache-2.0, which *is* on the allow-list —
not a blocker — but adopting them would still mean adding several new
entries (and their transitive trees) to the license-checker surface for no
benefit over the builtin-only path.

**Verdict: minisign has strictly less license surface to carry; sigstore
would have cleared the gate too, this criterion alone is a wash favoring the
smaller footprint.**

### (e) CI signing ergonomics

**minisign:** the secret key (base64) plus its passphrase live as two
GitHub Actions encrypted secrets; the sign step is one `minisign -S` call
(or equivalently one call into this package's future signer counterpart —
not part of this lane). This also means the solo maintainer can sign a
release from their own machine without any CI dependency at all, useful for
a hotfix cut outside the normal pipeline.

**sigstore keyless (OIDC via `cosign sign --yes` in Actions):** arguably
*easier* in a pure-GitHub-Actions-only workflow — no secret to store, the
ambient `GITHUB_TOKEN`/OIDC token does the work. The catch is exactly that
"pure-GitHub-Actions-only" constraint: it does not extend to a manual,
off-CI signing path the way a portable secret key does.

Note (parenthetical, not part of this decision): GitHub artifact
attestations via `attest-build-provenance` land separately in the
release-pipeline lane **regardless of this choice** — that gives the
pipeline Sigstore-backed build provenance either way. This decision is only
about the *additional, independent* blessing signature the server checks
during its own update check.

**Verdict: roughly a wash; minisign's off-CI signing path tips it slightly
in favor for a solo maintainer.**

### Summary

| Criterion | Winner |
|---|---|
| (a) Server verification weight | minisign |
| (b) Offline / D14 zero-identifying-payload | minisign |
| (c) Solo-maintainer key management + P4.9 | minisign |
| (d) License compatibility | wash (both clear the gate; minisign smaller) |
| (e) CI ergonomics | wash (slight edge to minisign for off-CI signing) |

Three clear wins and two washes → **minisign**.

---

## Manifest format

`manifest.json` (see `src/manifest.ts` for the JSON Schema, `MANIFEST_SCHEMA`):

```jsonc
{
  "manifestVersion": 1,
  "channel": "stable",
  "releases": [
    {
      "version": "1.2.0",
      "releasedAtMs": 1753315200000,
      "notesUrl": "https://example.invalid/releases/1.2.0",
      "artifacts": [
        {
          "platform": "linux-x64",
          "kind": "tarball",
          "filename": "loombre-1.2.0-linux-x64.tar.gz",
          "sizeBytes": 123456789,
          "sha256": "…64 hex chars…",
          "url": "https://example.invalid/releases/1.2.0/loombre-1.2.0-linux-x64.tar.gz"
        }
      ]
    }
  ]
}
```

`channel` is a single-member closed literal (`"stable"`) in v1 — additive
contract evolution (docs/PLAN.md §4.1) is how a future channel gets added,
not a widened-to-`string` field today.

### Detached-signature convention

- `manifest.json` — the manifest itself, canonical UTF-8 JSON.
- `manifest.json.minisig` — the minisign detached signature over the exact
  bytes of `manifest.json` (see `src/filenames.ts`).

A future sigstore-bundle equivalent would live alongside as
`manifest.json.sigstore` — out of scope for this decision (see above), but
the filename convention leaves the additive slot open.

## What this package does NOT do

- No fetch, no filesystem access anywhere in `src/` — the update-check
  CLIENT lane (not this lane) is responsible for retrieving
  `manifest.json` + `manifest.json.minisig` + the pinned public key and
  handing their bytes to `verifyManifestSignature`.
- No signing. Producing a `.minisig` for a real release is the
  release-manager tool's job (a separate lane), not this package's —
  `test/helpers/minisign-fixtures.ts` implements signing ONLY as
  test-fixture infrastructure and is not exported from `src/`.
