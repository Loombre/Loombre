# Joining Loombre

<!-- Sourcing: claim flow — apps/server/src/invites/invites.controller.ts
     (getClaimState/claimInvite: username required only when the invite has
     no preset, password required, optional email/displayName, real sign-in
     on success); contract ClaimState/ClaimInviteRequest schemas
     (packages/contract/openapi.yaml); forgot-password self-service —
     apps/server/src/session/auth.controller.ts (forgotPassword/
     resetPassword: identifier is a username or an email, always the same
     response either way, a 30-minute single-use link, only sent when the
     account has an email on file); GET /system/capabilities's
     passwordResetAvailable flag (apps/server/src/session/
     system.controller.ts) gating whether a sign-in screen shows a
     forgot-password option at all; STATE.md E1/E3b/E4/M8/M15 for the
     no-mail-required posture and the email-optional framing. -->

If whoever runs your household's Loombre invited you, they'll have given
you a link — sent as a message, read out loud, written down, however
suited them. Open it, and Loombre asks you to pick a password (and a
username too, unless they already chose one for you). That's it — as
soon as you've done that, you're signed in.

[SCREENSHOT: The claim-invite screen, asking for a username and password]

## Adding an email address

Along the way, or later from your own [account settings](account-settings.md),
you can add an email address if you want to. It's entirely optional — Loombre works
completely fine without one. The one thing it's used for is getting back
in if you ever forget your password, and only if whoever runs your
household's Loombre has turned that on. If they haven't, or you don't add
one, they can still help you get back in — see below.

If whoever invited you already filled in an email address for you, it'll
show up pre-filled on the invite screen — you're free to change it, or
clear the field entirely if you'd rather not use it at all.

[SCREENSHOT: Account settings showing the optional email field]

## Forgetting your password

If the sign-in screen has a "Forgot password?" option, email recovery
is turned on for your household's Loombre. Use it, and if you've added an
email address, a message with a link to choose a new password will
arrive — the link only works once, and only for half an hour, so use it
soon after it shows up.

[SCREENSHOT: Sign-in screen showing the forgot-password option, when available]

If there's no such option on the sign-in screen, don't worry — whoever
runs your household's Loombre can still get you back in. Ask them; they
can set a temporary password for you, and the first time you sign in with
it, Loombre asks you to choose a real one of your own right away.

## See also

- [Account settings](account-settings.md) — changing your name, password,
  and email once you're in.
- [Restricted content](restricted-content.md) — a PIN, separate from your
  password, if the person who runs your Loombre has turned it on for you.
