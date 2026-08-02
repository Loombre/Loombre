# Admin Guide

*This guide is for whoever runs the household Loombre server — comfortable with settings screens, not expected to touch code or a terminal.*

This guide covers everything you'll manage from Loombre's admin screens:
running the first-time setup wizard, adding and organizing libraries,
managing who can see what, reading the hardware capability report, and
watching background jobs (like scanning your library) as they run.

Anything that needs a terminal, a config file, or a repository path is
**out of scope here on purpose** — that's the
[Operator Guide](../ops/index.md)'s job. If a page in this guide tells you to "ask
whoever installed Loombre," that's what it means: some things (like setting
up a reverse proxy, or restoring from a backup file) happen outside the
admin screens, one level below where this guide operates.

## What's in this guide

- **[The setup wizard](wizard.md)** — what happens the first time Loombre starts.
- **[Libraries & scanning](libraries.md)** — adding your media folders and what scanning does.
- **[Users & permissions](users-permissions.md)** — adding people, controlling what each of them can see, and resetting a forgotten password.
- **[Inviting people](inviting-users.md)** — a one-time link that lets someone join themselves, no email required.
- **[Mail](mail.md)** — the optional, provider-neutral setup that lets Loombre send those links and password resets by email.
- **[Connecting Stash](connecting-stash.md)** — reading metadata from a Stash database into a restricted library, without ever writing back to it.
- **[Capability report](capability-report.md)** — what Loombre knows about your hardware.
- **[Jobs dashboard](jobs-dashboard.md)** — watching background work as it happens.
- **[Plugins](plugins.md)** — connecting outside programs that look up media information or watch your server's activity feed, and exactly what each one can see.
- **[Settings reference](settings-reference.md)** — every setting, what it does, and how to change it. Generated automatically from Loombre's own settings list, every time this site is built — so it can't drift from what the settings screen actually offers.
