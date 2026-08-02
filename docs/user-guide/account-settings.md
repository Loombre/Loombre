# Account settings

<!-- Sourcing: F1 re-auth surface (password, email set/change/remove,
     restricted PIN set/change, restricted opt-in/out) — apps/server/src/
     common/require-current-password.ts; PATCH /users/me + PUT /users/me/
     restricted as the two operations that ask for it — apps/server/src/
     catalog/users.controller.ts's updateMe, apps/server/src/session/
     users-me.controller.ts's putRestricted. F3 session revocation on
     password change — packages/db/src/query/identity.ts's
     revokeOtherRefreshTokensForUser, session.revoked-by-password-change
     event. F5 email-collision out-of-band signal, mail-configured
     installs only, at most one notice per address per day — apps/server/
     src/catalog/users.controller.ts's updateMe / apps/server/src/invites/
     invites.controller.ts's claimInvite (email-in-use-notice dispatch);
     STATE.md "Current-password re-auth on self-changes + the
     email-collision signal" F1/F3/F5/F6 for the plain-language framing. -->

This is where you change things about your own account — your name, your
password, your email address, and, if it's turned on for you, your
restricted-content PIN.

## Small changes and big changes

Some changes take effect right away with nothing extra to do — your
display name, for example. For a few bigger ones — your password, your
email address, or anything about restricted content — Loombre asks you to
type your current password again before it makes the change. That's not
about doubting you; it's there so that if someone else ever gets hold of a
device where you're already signed in, they still can't take over your
account without knowing your password.

[SCREENSHOT: Account settings screen, with the "enter your current password" field shown on a password change]

If you type your current password wrong, Loombre tells you and leaves
everything else you'd already filled in untouched, so you can just correct
it and try again. Too many wrong tries in a short time and Loombre asks
you to wait a bit before trying again — the same protection your sign-in
screen already has.

## Changing your password

Pick a new password and confirm your current one. Once it's changed, every
*other* device you were signed in on is signed out automatically — the
device you just used stays signed in. That's on purpose: if someone else
had gotten into your account from another device, this is what locks them
back out. If it happens to sign out a device of yours that you still want,
just sign back in there with your new password.

## Adding or removing your email address

Your email address is entirely optional — Loombre works completely fine
without one. Add it, change it, or remove it any time from your account
settings. It's used for one thing: getting back into your account if you
ever forget your password, and only once that's been turned on for your
household's Loombre (see [Joining Loombre](joining.md)).

If you ever try to add an email address that's already attached to a
different account here, Loombre doesn't tell you that — it just quietly
keeps your account as it was, with nothing changed. If that ever happens
to you the other way around — someone else tries to add your own address
to a different account — you may get a short notice about it, at most
once a day, so you know; there's nothing you need to do, and your account
is completely unaffected either way.

## Restricted content

Opting in to restricted content, and setting or changing your PIN, also
asks for your current password, on top of the PIN itself — see
[Restricted content](restricted-content.md) for everything about how the
PIN and the rest of that works.

## See also

- [Restricted content](restricted-content.md) — the PIN and the five
  steps that keep it private.
- [Joining Loombre](joining.md) — getting back in if you forget your
  password.
