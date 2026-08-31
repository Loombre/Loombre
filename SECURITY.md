# Security Policy

Loombre is a self-hosted server that handles authentication, multi-user
access control, and (optionally) restricted content — security issues here
have real consequences for real households running real instances. Reports
are taken seriously and answered in good faith.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Report it privately using
[GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability):

1. Go to the **Security** tab of this repository.
2. Select **Report a vulnerability**.
3. Fill in as much detail as you can — see below.

This opens a private advisory visible only to the maintainer and you,
with no public disclosure until a fix is ready. It's the only reporting
channel this project commits to at this time — no dedicated security
email address is published, deliberately, rather than pointing you at
one that goes unmonitored.

## What to include

The more of this you can provide, the faster a report can be triaged:

- What you found and why it's a security issue (not just "unexpected
  behavior").
- Steps to reproduce, ideally against a local dev instance rather than
  anything running your own real data.
- The affected version/commit.
- Impact, as best you can assess it — what an attacker could actually do
  (read another user's data, bypass restricted-content gating, execute
  code, etc.).

## Scope

In scope: the server (`apps/server`), worker (`apps/worker`), web client
(`apps/web`), shared packages (`packages/*`), the installers
(`installers/*`), and the release/signing pipeline
(`.github/workflows/release.yml`, `scripts/release/*`).

Out of scope: vulnerabilities that require you to already have another
user's password or PIN, denial-of-service reports against your own local
instance with no broader implication, and issues in third-party
dependencies that should be reported upstream instead (though the
maintainer would still like to know if Loombre's own usage of them makes
an upstream issue worse).

## What to expect

This is a small, self-hosted project without a dedicated security team or
a bug-bounty program — there's no guaranteed response-time SLA. A
genuine, well-described report will be acknowledged and investigated as
promptly as the maintainer reasonably can, and credited (if you'd like) in
the eventual advisory and changelog once a fix ships.

## Why this matters here specifically

Two architecture commitments make security reports particularly
actionable in this codebase, worth knowing before you report:

- **All catalog reads go through one mandatory query-guard layer**
  (`packages/db`'s query functions, enforced by dependency-cruiser so no
  code path can bypass it) — if you find a way for a user to see data
  their `ViewerContext` shouldn't allow, that guard is exactly where to
  look, and exactly what a fix will touch.
- **No telemetry, analytics, or phone-home of any kind** is an
  architecture invariant enforced by CI (`grep-gates`), not a policy
  promise alone — if you find something sending data anywhere it
  shouldn't, that's treated as a serious finding regardless of intent.
