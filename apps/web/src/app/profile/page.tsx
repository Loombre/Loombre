// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/profile/page.tsx
//
// D-6 (Wave 2, this run — IA restructure): the new home for every
// user-scoped self-service setting (Profile, Password, Restricted
// opt-in/PIN, per-user Playback preferences) — moved OUT of the now
// admin-only /settings surface (components/settings/SettingsShell.tsx's
// header) into its own standalone route, reached from the avatar menu's
// "Profile settings" row (components/shell/UserMenu.tsx), not the sidebar.
// Every user gets here the same way, admin or not — there is no adminOnly
// gate on this route at all (every field ProfileSettings renders is
// already scoped server-side to the caller's OWN user id: GET/PATCH
// /users/me, GET/PUT /users/me/settings, PUT /users/me/restricted — none of
// these endpoints accept a target user id, so there is nothing here for a
// client-side gate to protect).
//
// Standalone AppShell + SettingsPageLayout chrome, same pattern
// app/settings/data/page.tsx and app/settings/devices/page.tsx already use
// for a /settings*-adjacent route that isn't one of SettingsShell's own
// tabs — see SettingsPageLayout.tsx's header for the shared readable-width
// contract. `heading` is null on phone width because mobile-header.ts's new
// `/profile` case already renders a large "Profile" title in the shell
// chrome there — rendering it a second time in-page would be the exact
// duplicate-title bug ProfileSettings.tsx's own header already guards
// against for its other callers.

import { AppShell } from "../../components/shell/AppShell.js";
import { SettingsPageLayout } from "../../components/settings/SettingsPageLayout.js";
import { ProfileSettings } from "../../components/profile/ProfileSettings.js";
import { useMediaQuery } from "../../components/ui/use-media-query.js";

const PHONE_QUERY = "(max-width: 767.98px)";

export default function ProfilePage(): React.JSX.Element {
  const isPhone = useMediaQuery(PHONE_QUERY);

  return (
    <AppShell>
      <SettingsPageLayout>
        <ProfileSettings heading={isPhone ? null : "Profile"} />
      </SettingsPageLayout>
    </AppShell>
  );
}
