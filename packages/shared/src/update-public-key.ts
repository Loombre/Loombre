// GENERATED — do not edit (node scripts/release/embed-public-key.mjs)
//
// The pinned minisign public key (P4.9 location #1: keys/minisign.pub —
// this file is a direct, byte-faithful embed of it). The server's
// update-check verifier (apps/server/src/session/update-check) imports
// ONLY this constant, never reads keys/minisign.pub off disk at runtime —
// see scripts/release/lib/embed-public-key.mjs's header for why.
// Regenerate with `pnpm embed-public-key` after replacing the placeholder
// key (keys/README.md has the full three-location rollout checklist).

export const LOOMBRE_UPDATE_PUBLIC_KEY_TEXT = "untrusted comment: PLACEHOLDER — NOT a real key. Generate a real keypair per keys/README.md before any real release; this all-zero key never verifies anything (it is structurally valid minisign-format so tooling can parse it, but every real signature will correctly fail against it).\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
