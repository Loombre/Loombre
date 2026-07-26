// SPDX-License-Identifier: AGPL-3.0-only
import { QuickSearch } from "./QuickSearch.js";
import { RestrictedLockControl } from "./RestrictedLockControl.js";
import { UserMenu } from "./UserMenu.js";
import styles from "./AppShell.module.css";

// Dark-only (STATE.md "Phosphor retheme + responsive rebuild" — README
// "Light theme — removed"): ThemeToggle is deleted, not hidden — there is
// exactly one theme, so a toggle with nothing to toggle to is dead UI, not
// a restyle target. Breadcrumb: the README's shell spec names one, but
// ground truth is that no breadcrumb exists anywhere in this Topbar today
// (nothing to "restyle only") — building one is new UI, logged as a
// conflict in this lane's freeze report rather than added here.
export function Topbar({ username, isAdmin }: { username: string | null; isAdmin: boolean }): React.JSX.Element {
  return (
    <header className={styles.topbar}>
      <QuickSearch isAdmin={isAdmin} />
      <RestrictedLockControl />
      <UserMenu username={username} />
    </header>
  );
}
