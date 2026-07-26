# The setup wizard

<!-- Sourcing: exact step order (welcome -> admin -> libraries -> hardware
     -> restricted -> restore -> done) and the restore-step ordering
     behavior — apps/web/src/app/setup/wizard-state.ts (STEP_ORDER,
     canOfferRestore, and that file's own header comment explaining why the
     restore step is shown-but-disabled rather than reordered when a
     library was already created earlier in the same wizard session).
     Step components — apps/web/src/app/setup/_components/*.tsx. -->

The first time Loombre starts, it opens a setup wizard instead of the
regular sign-in screen. You'll only see this once — after it finishes,
Loombre behaves like a normal, already-set-up server.

The wizard has seven steps, always in this order:

1. **Welcome** — an introduction to what's about to happen.
2. **Admin account** — you create the first account, which is an
   administrator account (that's you). This is the account you'll sign
   in with from now on.
3. **Libraries** — you can add your media folders now, or skip this and
   add them later from the [Libraries](libraries.md) screen.
4. **Hardware capability check** — Loombre checks what your machine can do
   (what video it can play back directly, whether hardware-accelerated
   conversion is available). See the
   [Capability report](capability-report.md) page for what this
   means in more detail.
5. **Restricted content** — an opportunity to turn on restricted-content
   support for this server, if you want it. You can also do this later;
   see [Users & permissions](users-permissions.md).
6. **Restore from a backup** — if you have a data export from another
   Loombre install, you can restore it here.
7. **Done** — the wizard finishes and takes you into Loombre.

[SCREENSHOT: Setup wizard, Welcome step]

[SCREENSHOT: Setup wizard, Admin account creation step]

[SCREENSHOT: Setup wizard, Library paths step]

[SCREENSHOT: Setup wizard, Hardware capability check step]

## A note about the restore step

The restore step only works against a completely empty Loombre — one with
no libraries created yet. If you added a library earlier in the same
wizard run (step 3), the restore step will still appear, but it will be
disabled with an explanation, rather than attempting a restore that can't
succeed. If you're planning to restore from a backup, the simplest path
is to skip the Libraries step and let the restore step recreate your
libraries for you.

[SCREENSHOT: Setup wizard, Restore step (both the enabled and disabled states)]

## Changing your mind later

Nothing in the wizard is permanent in a way you can't revisit — libraries,
users, restricted-content settings, and permissions can all be changed
afterward from the regular admin screens covered elsewhere in this guide.
