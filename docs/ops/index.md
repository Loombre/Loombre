# Operator Guide

*This guide is for the technical self-hoster — comfortable with a shell, environment variables, reverse proxies, and networking. Every recipe here is copy-pasteable and states its assumptions.*

This section folds in Loombre's operator-facing documentation as it already
exists — the pages below are implementation-verified and organized here,
not rewritten. If you're looking for the settings screens instead, see the
[Admin Guide](../admin-guide/index.md); if you're looking for how to *use* Loombre,
see the [User Guide](../user-guide/index.md).

## Installing

Installation itself lives in its own top-level section:
**[Install](../install/index.md)** — platform chooser, system requirements per
hardware tier, and the unsigned-install trust story (checksums, minisign,
GitHub attestation, cosign).

## Remote access & TLS

Three first-class, mutually-exclusive paths — pick the one matching your
situation:

- **[Reverse proxy](reverse-proxy.md)** (recommended if you already run
  one) — Caddy/nginx/Traefik recipes, the real requirements (WebSocket
  upgrade, no buffering on the streaming endpoints, `?token=` log
  redaction, upload body-size limits), and `LOOMBRE_TRUST_PROXY` /
  `LOOMBRE_CORS_ORIGINS`.
- **[Built-in ACME](acme.md)** (`LOOMBRE_TLS_MODE=acme`) — for
  direct-exposure installs with no reverse proxy: automatic Let's Encrypt
  certificates via HTTP-01 or DNS-01, the port 80/443 privilege story, and
  renewal mechanics.
- **LAN-only, no TLS** — no extra configuration beyond the defaults; see
  the final section of [Reverse proxy](reverse-proxy.md).

## Mail

- **[Mail deliverability notes](mail-notes.md)** — getting a message
  *sent* isn't the same as getting it *delivered*; what's the mail
  provider's job versus what's genuinely out of reach for a server on a
  home connection. Setting mail up in the first place is the Admin
  Guide's [Mail](../admin-guide/mail.md) page.

## Backups, restore & data export

- **[Backups & restore](backup.md)** — what to actually back up (and
  explicitly what not to), both for the embedded and an external
  PostgreSQL instance, plus a restore drill you should run before you
  need it for real.

<!-- Sourcing for the paragraph below only (not the linked backup.md page,
     which is folded in as-is): GET /export and POST /import are real,
     implemented endpoints — apps/server/src/catalog/data-freedom.
     controller.ts (POST /import explicitly gated to admin, per that
     file's own header comment: "POST /import (admin)"); the underlying
     archive-apply job is apps/worker/src/import/consumer.ts. This is
     docs/PLAN.md §8.4's "data freedom" feature, confirmed implemented via
     apps/server/test/import/round-trip.e2e.spec.ts, not just specced. -->

Separately from a database-level backup, Loombre has a built-in data
export/import feature (`GET /export`, `POST /import`) for moving your
catalog, libraries, and per-user watch progress between instances as an
open JSON archive — `POST /import` requires an administrator session. This
is also what the [setup wizard's restore step](../admin-guide/wizard.md) uses.
Full request/response detail is in the [API Reference](../api-reference/index.md).

## External PostgreSQL

- **[External PostgreSQL](external-postgres.md)** — running Loombre
  against a PostgreSQL instance you already operate, instead of the
  bundled embedded one.

## systemd

- **[systemd](systemd.md)** — unit files for the Linux tarball install
  (full walkthrough: [docs/install/linux.md](../install/linux.md)).

## The `loombre` command-line tool

- **[The loombre command-line tool](cli.md)** — read-only environment
  checks (`doctor`, `paths`) plus the two privileged operations it
  exposes: `admin reset-pin <username>` (a forgotten restricted-content
  PIN — server-local by design, no equivalent over HTTP) and
  `admin reset-password <username>` (a forgotten account password — the
  same recovery the Admin Guide's Users screen offers over HTTP, for when
  a browser isn't an option).

## Updating & verifying releases

- **[Updating Loombre](updating.md)** — exactly what the built-in update
  checker does and does not send over the network (nothing is downloaded
  or applied automatically), and how to verify a release you've downloaded
  (checksums, minisign, GitHub attestation).

## Environment variable reference

- **[Environment variable reference](env-reference.md)** — every
  bootstrap/lockout-boundary variable with no settings-screen equivalent,
  plus the environment-pin variable for every admin-editable setting that
  has one. Generated automatically from Loombre's own settings list, every
  time this site is built. Secrets and other pure-infrastructure variables
  outside the settings list itself (`POSTGRES_PASSWORD`,
  `LOOMBRE_JWT_SECRET`) stay documented in
  `installers/docker/loombre.env.example`, linked from that page.

<!-- Sourcing for the paragraph below:
     docs/developer-guide/architecture/performance-budgets.md
     (Tier-0 figures: server idle RSS <= 220 MB, scan throughput >=
     200 files/min) and docs/install/index.md's "System requirements"
     Tier-0 section (4-core @ 2GHz, 4GB RAM) — both already published;
     docs/ops/t0-audit-runbook.md is the owner-executed physical-hardware
     audit procedure against those same budgets. No new tuning behavior
     asserted here beyond linking/summarizing those two existing sources. -->

## Tier-0 hardware

Loombre is explicitly designed and performance-budgeted for Tier-0 hardware
(a 4-core, ~2GHz machine with 4GB RAM — an Intel N100 mini PC or a
Raspberry Pi 5 are the reference devices) — not a degraded experience, a
first-class one. The enforced budgets (server idle memory, endpoint
response time, scan throughput) are listed in
[Performance budgets](../developer-guide/architecture/performance-budgets.md),
and
**[docs/ops/t0-audit-runbook.md](t0-audit-runbook.md)** is the runbook
used to physically verify them against real hardware. If you're deploying
to Tier-0 hardware, that runbook and
[docs/install/index.md](../install/index.md#system-requirements)'s tier table are
the two documents worth reading before you start.
