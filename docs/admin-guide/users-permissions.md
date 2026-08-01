# Users & permissions

<!-- Sourcing: user CRUD + per-library permission grants via a single
     library-scoped endpoint, restricted-grant note shown whenever a user's
     library list includes a restricted library ("gate 4 of 5") —
     apps/web/src/app/admin/users/page.tsx header comment. Five-gate model
     for restricted content — docs/PLAN.md §6.4 (linked in full from the
     User Guide's restricted-content page; summarized here from the admin
     side only). -->

## Adding people

From the Users screen, choose **+ Add user** to create an account for
someone else in your household. You'll set their name, username, email,
and an initial password; they can change their own password once signed
in.

[SCREENSHOT: Users list with + Add user button]
[SCREENSHOT: Create user modal]

## Library access

Nobody — not even another admin — can see a library until you explicitly
grant them access to it. Open a user's **Library access** to see every
library and toggle which ones they can see. The one exception: the admin
who *created* a **general** library is automatically granted access to it
at creation time. A **restricted** library is never auto-granted to
anyone — including its creator — so after creating one, grant yourself
access here the same way you'd grant anyone else.

[SCREENSHOT: Per-user library access editor]

## Restricted libraries — what a grant does, and doesn't, do

Granting someone access to a restricted library is **one of several
required steps**, not the whole story — full detail on all of them is in
the User Guide's [Restricted content](../user-guide/restricted-content.md)
page, written for the person using the account. From the admin side, your
part is:

1. Turning on restricted-content support for the server at all (a
   one-time, server-wide setting).
2. Granting the specific user access to the specific restricted library,
   from this screen.

Even with both of those done, the user still needs to be an adult (by
birth date on file) and choose to opt in themselves, with their own PIN
that you cannot see or set. When a user's library list includes a
restricted library, the permissions editor shows a reminder of this —
your grant is necessary but not sufficient by itself, by design.

[SCREENSHOT: Library access editor showing the restricted-grant reminder note]

## Removing access or an account

Toggle a library off in the same **Library access** editor to revoke it,
or delete a user's account entirely from the Users screen if they should
no longer have any access at all.

## Forgot PIN?

Nobody administering Loombre can see or set someone else's restricted-
content PIN — but whoever runs the server itself can reset it. Resetting
clears it completely and turns off that person's opt-in; they simply
choose a brand new PIN the next time they turn restricted content back on.
There's no screen for this here by design — see the Operator Guide's
[PIN-reset recovery steps](../ops/cli.md#forgot-a-pin) for exactly how.
