// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Icon } from "../icon/Icon.js";
import { useRestricted } from "../restricted/RestrictedProvider.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../lib/restricted-zone-count.js";
import styles from "./RestrictedLockControl.module.css";

/**
 * P2.8: the shell's global visible lock control. Locked -> tap opens the
 * PIN modal (POST /restricted/unlock on submit); unlocked -> tap is the
 * "explicit lock button" (POST /restricted/lock immediately, no
 * confirmation — matches the task's explicit-lock requirement while
 * keeping one affordance instead of two separate buttons). State reflects
 * RestrictedProvider's context, which is itself kept live by the shared
 * websocket client (instant cross-tab/device relock) — see that file's
 * header for the full state-derivation rationale.
 *
 * Ownership note: this file is this lane's (the shell's placeholder slot);
 * it deliberately does NOT import AppShell.module.css (shell-owned,
 * read-only) — see RestrictedLockControl.module.css's header.
 *
 * Entitlement gate (Wave-3 exit-gate walk catch): a viewer with NO
 * restricted-zone entitlement (restricted-profile users — no opt-in, no
 * PIN, or the capability off) must see "no zone/PIN at all" (U10/README).
 * L8 gated every entry point it ADDED on hasRestrictedZoneEntitlement;
 * this pre-existing P2.8 control predated that discipline and kept
 * rendering its PIN affordance for everyone. Same predicate now — the
 * control renders nothing for the unentitled (affordance-only change;
 * the server-side guard was always the boundary).
 */
export function RestrictedLockControl(): React.JSX.Element | null {
  const { state, openUnlockModal, lock } = useRestricted();
  const { count } = useRestrictedZoneCount();

  if (!hasRestrictedZoneEntitlement(count)) return null;

  function handleClick(): void {
    if (state.locked) openUnlockModal();
    else void lock();
  }

  const label = state.locked ? "Restricted content locked — tap to unlock" : "Restricted content unlocked — tap to lock";

  return (
    <button
      type="button"
      className={styles.button}
      data-unlocked={!state.locked}
      aria-label={label}
      title={label}
      aria-pressed={!state.locked}
      onClick={handleClick}
    >
      <Icon icon={state.locked ? "lock" : "unlock"} />
    </button>
  );
}
