# Loombre {{LOOMBRE_VERSION}}

See [CHANGELOG.md](https://github.com/{{REPO}}/blob/main/CHANGELOG.md) for the full history.

## Verifying this release

Three independent layers of trust — pick whichever you're comfortable with (docs/ops/updating.md has the full explanation):

```bash
# 1. Attestation (no key handling) — proves this was built by this repo's own CI
gh attestation verify <downloaded-file> --repo {{REPO}}

# 2. minisign signature (the release manager's personal blessing)
minisign -Vm SHA256SUMS -P <public key below>

# 3. Checksum (plain integrity)
sha256sum -c SHA256SUMS
```

### minisign public key

<!-- LOOMBRE_MINISIGN_PUBLIC_KEY_BEGIN -->
```
untrusted comment: PLACEHOLDER — NOT a real key. Generate a real keypair per keys/README.md before any real release; this all-zero key never verifies anything (it is structurally valid minisign-format so tooling can parse it, but every real signature will correctly fail against it).
RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```
<!-- LOOMBRE_MINISIGN_PUBLIC_KEY_END -->
