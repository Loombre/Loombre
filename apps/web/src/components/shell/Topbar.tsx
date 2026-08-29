// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/Topbar.tsx
//
// Dark-only (STATE.md "Phosphor retheme + responsive rebuild" — README
// "Light theme — removed"): ThemeToggle is deleted, not hidden — there is
// exactly one theme, so a toggle with nothing to toggle to is dead UI, not
// a restyle target.
//
// A1 (run UIFIX-2026-08-29, HIGH — "the topbar is 658px of nothing"): this
// header used to be one right-aligned cluster (search field + lock + avatar)
// with the entire left three-quarters of the bar empty. It is now the
// three-zone shape PlayerControls.module.css already uses for its transport
// cluster — two `flex: 1` flanks around the search field, which centres the
// field whatever either flank holds (AppShell.module.css .topbarLeft/
// .topbarRight). The left flank is what fills the void, and it is filled
// ONLY with facts the shell already owns:
//
//   - the route label, from usePathname() through resolveMobileHeader()
//     (mobile-header.ts) — the shell's EXISTING route -> human-label
//     resolver, whose own header already reserved `title` for "callers that
//     want it". No second mapping table to drift: /home -> "Home",
//     /settings/advanced -> "Advanced Server", /items/movie/<id> -> "Movie",
//     and an unmapped route resolves to "" and renders nothing rather than
//     inventing a label (U9). Unlike MobileHeader, which suppresses that
//     title on detail routes because the page underneath repeats it as a
//     large title, chrome up here is naming a LOCATION, not titling the
//     page, so the generic kind label is drawn.
//   - the live scan status, from the shared use-scan-status.ts store — the
//     same one Sidebar's Dashboard pill reads, so the two can never
//     disagree (see that file for the single-subscription rule).
//
// This supersedes the "no breadcrumb exists here, building one is new UI"
// note that stood at the top of this file. It stays true as written — this
// is still not a breadcrumb: a breadcrumb is a TRAIL of ancestor links, and
// what A1 asks for (and what ships here) is one non-interactive label naming
// where you are, which the shell can answer from the pathname alone.
//
// Mobile: this whole header is CSS-hidden at <= 767.98px (AppShell.module.css)
// — MobileHeader owns phones and is untouched by A1.

import { usePathname } from "next/navigation";
import { QuickSearch } from "./QuickSearch.js";
import { RestrictedLockControl } from "./RestrictedLockControl.js";
import { UserMenu } from "./UserMenu.js";
import { resolveMobileHeader } from "./mobile-header.js";
import { useScanStatus } from "./use-scan-status.js";
import styles from "./AppShell.module.css";

/** The library-shortcut ids resolveMobileHeader() uses to read `/browse` as
 *  "Movies"/"TV Shows" are deliberately passed as null here: they come with
 *  the active `?library=` query, and useSearchParams() would need this
 *  header wrapped in its own Suspense boundary (AppShell.tsx wraps ShellNav
 *  for exactly that reason). Without them `/browse` resolves to "Browse" —
 *  the route's own honest name — rather than a wrong one; noted for the
 *  wave rather than solved by widening AppShell's tree from this lane. */
export function routeLabel(pathname: string): string {
  return resolveMobileHeader(pathname, null, null, null).title;
}

export function Topbar({ username, isAdmin }: { username: string | null; isAdmin: boolean }): React.JSX.Element {
  const pathname = usePathname();
  const label = routeLabel(pathname ?? "");
  const scanning = useScanStatus(isAdmin);

  return (
    <header className={styles.topbar}>
      <div className={styles.topbarLeft}>
        {label !== "" && <span className={styles.topbarRoute}>{label}</span>}
        {scanning && (
          <span className={styles.topbarScan}>
            <span className={styles.topbarScanDot} aria-hidden="true" />
            Scan
          </span>
        )}
      </div>
      <QuickSearch isAdmin={isAdmin} />
      <div className={styles.topbarRight}>
        <RestrictedLockControl />
        <UserMenu username={username} />
      </div>
    </header>
  );
}
