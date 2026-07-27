// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/AccountSection.tsx
//
// Wave 2 lane L1 (Settings IA): extracted from the pre-IA
// apps/web/src/app/settings/page.tsx almost verbatim (Profile, Restricted
// content — both real, both already wired to GET/PATCH /users/me and
// GET/PUT /users/me/restricted) so it can render both as the ONE thing a
// non-admin ever sees at /settings, and as the "Account" tab/hub-section a
// admin reaches at /settings/account (section-registry.ts) — this is the
// lane's one addition beyond the README's literal 8 tabs (see that file's
// header for why).
//
// Cleanup 1 (this lane's brief): the inert theme dark/light/system
// SegmentedControl was REMOVED from the Playback-preferences form —
// Phosphor is dark-only (design/phosphor/README.md "Light theme —
// removed"; W0 already deleted the data-theme mechanism and ThemeToggle),
// so that control could no longer do anything.
//
// Cleanup 3: the WHOLE Playback-preferences form is gone with it. Its two
// survivors (preferred audio/subtitle language) showed a green "Saved" for
// values nothing ever stored — PUT /users/me/settings
// (apps/server/src/catalog/users.controller.ts's putMySettings) declares no
// @Body() at all and mapSettings returns fixed defaults, so every save
// silently reverted on the next load. Deleting a control with no backing
// write is this repo's established handling (cleanup 1 above; the autoplay
// toggle hidden by the Addendum A doc-lane fix F3(c)) — a fake success
// state is not. Restore the form — audio/subtitle language, autoplay and
// UserSettings.theme's fate together — once user_settings.prefs is
// genuinely wired (STATE.md owner ledger item 6, "GET/PUT
// /users/me/settings is a COMPLETE STUB ... persists nothing for ANY key").
// The contract's UserSettings fields stay UNTOUCHED: removing a required
// contract field is a breaking change / an owner decision, per this lane's
// hard line.
//
// Cleanup 2 (duplicate title): `heading` is null when the mobile shell
// chrome already shows a large "Settings" title for this exact content
// (bare /settings, non-admin, phone width) — rendering "Settings" again
// here would be the literal duplicate-title bug this lane's brief calls
// out. Every OTHER caller (admin desktop "Account" tab pane, admin mobile
// /settings/account, or non-admin desktop bare /settings, where the shell
// shows no page title at all) passes a real heading.

import { useEffect, useState, type FormEvent } from "react";
import { TextInput } from "../../ui/Input.js";
import { Button } from "../../ui/Button.js";
import { Card } from "../../ui/Card.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { useRestricted } from "../../restricted/RestrictedProvider.js";
import { apiGet, apiPatch, apiPut, LoombreApiError } from "../../../lib/api-client.js";
import { PIN_LENGTH, isPinComplete, sanitizePinInput, stripPinDigits } from "../../../lib/pin-entry.js";
import type { components } from "@loombre/sdk";
import styles from "./AccountSection.module.css";

type User = components["schemas"]["User"];

function SaveStatus({ status }: { status: "idle" | "saving" | "saved" | "error" }): React.JSX.Element | null {
  if (status === "idle") return null;
  const tone = status === "error" ? "error" : status === "saved" ? "success" : undefined;
  const text = status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "Couldn't save";
  return (
    <span className={styles.status} data-tone={tone}>
      {text}
    </span>
  );
}

function ProfileSection(): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet("/users/me").then((u) => {
      setUser(u);
      setDisplayName(u.displayName ?? "");
      setEmail(u.email);
      setBirthDate(u.birthDate ?? "");
    });
  }, []);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      // `birthDate` is always sent, `null` when the input is empty: the
      // contract types it `[string, 'null']` precisely so it can be
      // cleared, and updateMe only touches the column when the key is
      // PRESENT — omitting it (as this form used to) made clearing a
      // stored birth date impossible.
      const body: { displayName: string | null; email: string; birthDate: string | null } = {
        displayName: displayName || null,
        email,
        birthDate: birthDate || null,
      };
      const u = await apiPatch("/users/me", { body });
      setUser(u);
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof LoombreApiError ? err.message : "Network error");
    }
  }

  if (!user) return <p className={styles.sectionBody}>Loading…</p>;

  return (
    <form className={styles.section} onSubmit={handleSubmit}>
      <h2 className={styles.sectionTitle}>Profile</h2>
      <label className={styles.field}>
        <span className={styles.label}>Username</span>
        <TextInput value={user.username} disabled />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Display name</span>
        <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Email</span>
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Birth date</span>
        <TextInput type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
      </label>
      <div className={styles.actions}>
        {error && (
          <span className={styles.status} data-tone="error">
            {error}
          </span>
        )}
        <SaveStatus status={status} />
        <Button type="submit" variant="primary" disabled={status === "saving"}>
          Save profile
        </Button>
      </div>
    </form>
  );
}

// Cleanup 4 (lockout bug): this card used to accept a PIN of ANY length
// while components/restricted/PinModal.tsx — the ONE unlock surface —
// hard-requires exactly PIN_LENGTH digits and auto-submits on the last one.
// Setting a 5-digit PIN here therefore made restricted content permanently
// unreachable, with nothing in the UI to undo it. Both fields now route
// through lib/pin-entry.ts (the same module PinModal and the setup wizard's
// RestrictedStep use), and submission is gated on isPinComplete so a
// non-conforming PIN cannot reach the wire. Server-side the same rule is
// enforced by apps/server/src/session/pin-format.ts against the contract's
// `^[0-9]{4}$` on RestrictedSettingsUpdate.pin — the client gate is UX, not
// the boundary.
//
// `Current PIN` is the deliberate exception: it proves an ALREADY-STORED
// secret, which on an install predating the rule may be longer, so it gets
// stripPinDigits (digits-only) and NOT the clamp. That field is such a
// user's entire recovery path — prove the old PIN, set a conforming new one
// — and the contract leaves `currentPin` unconstrained for exactly this
// reason. Clamping it would be strictly worse than the bug being fixed.
function RestrictedSection(): React.JSX.Element {
  const { state, applyRestrictedSettings } = useRestricted();
  const [optIn, setOptIn] = useState(state.optIn);
  const [pin, setPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setOptIn(state.optIn), [state.optIn]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();

    // Opting OUT never sets a PIN — the New PIN field isn't even rendered
    // then, so a value left over from before the toggle flipped is
    // abandoned input, not a submission. Scoping it here keeps that stale
    // value from both blocking the guards below and reaching the wire.
    const newPin = optIn ? pin : "";

    // A blank New PIN means "keep the current one" ONLY when there is one
    // to keep; otherwise opting in needs a PIN and the server would 422.
    if (optIn && newPin.length === 0 && !state.hasPin) {
      setStatus("error");
      setError(`Enter a ${PIN_LENGTH}-digit PIN to enable restricted content.`);
      return;
    }
    // A partially typed PIN must never be stored: the unlock prompt can
    // only ever send PIN_LENGTH digits, so anything else is a lockout.
    if (newPin.length > 0 && !isPinComplete(newPin)) {
      setStatus("error");
      setError(
        state.hasPin
          ? `A PIN must be exactly ${PIN_LENGTH} digits — leave it blank to keep your current one.`
          : `Enter a ${PIN_LENGTH}-digit PIN to enable restricted content.`,
      );
      return;
    }

    setStatus("saving");
    setError(null);
    try {
      const body: { optIn: boolean; pin?: string; currentPin?: string } = { optIn };
      if (newPin) body.pin = newPin;
      if (currentPin) body.currentPin = currentPin;
      const result = await apiPut("/users/me/restricted", { body });
      applyRestrictedSettings(result.optIn, result.hasPin);
      setPin("");
      setCurrentPin("");
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof LoombreApiError ? err.message : "Network error");
    }
  }

  return (
    <form className={styles.section} onSubmit={handleSubmit}>
      <h2 className={styles.sectionTitle}>Restricted content</h2>
      <p className={styles.sectionBody}>
        Opt in to see restricted-content libraries. Unlocking never persists across logins — you always need the PIN
        again after signing back in.
      </p>
      <div className={styles.row}>
        <span className={styles.label}>Enable restricted content</span>
        <SegmentedControl
          key={optIn ? "on" : "off"}
          options={["Off", "On"]}
          defaultValue={optIn ? "On" : "Off"}
          onChange={(v) => setOptIn(v === "On")}
        />
      </div>
      {optIn && (
        <label className={styles.field}>
          <span className={styles.label}>
            New PIN ({PIN_LENGTH} digits){state.hasPin ? " — leave blank to keep current" : ""}
          </span>
          <TextInput
            type="password"
            inputMode="numeric"
            maxLength={PIN_LENGTH}
            value={pin}
            onChange={(e) => setPin(sanitizePinInput(e.target.value))}
          />
        </label>
      )}
      {/* Keyed off state.hasPin ALONE, deliberately NOT nested under
          `optIn`: the server requires currentPin to opt OUT, so hiding this
          field the moment the toggle flips to Off (as it used to) made
          opting out unreachable from this UI — the value had to be typed
          before flipping and then survive in state, invisibly. */}
      {state.hasPin && (
        <label className={styles.field}>
          <span className={styles.label}>Current PIN (required to change PIN or opt out)</span>
          {/* stripPinDigits, not sanitizePinInput: see this section's
              header — a PIN stored before the length rule existed must
              stay typeable here or its owner has no way back in. */}
          <TextInput
            type="password"
            inputMode="numeric"
            value={currentPin}
            onChange={(e) => setCurrentPin(stripPinDigits(e.target.value))}
          />
        </label>
      )}
      <div className={styles.actions}>
        {error && (
          <span className={styles.status} data-tone="error">
            {error}
          </span>
        )}
        <SaveStatus status={status} />
        <Button type="submit" variant="primary" disabled={status === "saving"}>
          Save
        </Button>
      </div>
    </form>
  );
}

// Its own form, deliberately NOT a field on ProfileSection: a display-name
// or email save must never carry a password. PATCH /users/me is the only
// password-change surface the contract has — UpdateMeRequest declares
// `password` and, being additionalProperties:false, nothing to re-
// authenticate with, so no current-password proof can be sent today.
// Requiring one (contract field + a verify in
// apps/server/src/catalog/users.controller.ts's updateMe) is an owner /
// contract pass; until then a stolen session can already rotate the
// password straight against the API, which this form does not widen.
function ChangePasswordSection(): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== confirmation) {
      setStatus("error");
      setError("The two passwords don't match.");
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      await apiPatch("/users/me", { body: { password } });
      setPassword("");
      setConfirmation("");
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof LoombreApiError ? err.message : "Network error");
    }
  }

  return (
    <form className={styles.section} onSubmit={handleSubmit}>
      <h2 className={styles.sectionTitle}>Password</h2>
      <p className={styles.sectionBody}>
        Changing your password does not sign your other devices out — revoke them from Devices if you need to.
      </p>
      <label className={styles.field}>
        <span className={styles.label}>New password</span>
        <TextInput
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Confirm new password</span>
        <TextInput
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          required
        />
      </label>
      <div className={styles.actions}>
        {error && (
          <span className={styles.status} data-tone="error">
            {error}
          </span>
        )}
        <SaveStatus status={status} />
        <Button type="submit" variant="primary" disabled={status === "saving"}>
          Change password
        </Button>
      </div>
    </form>
  );
}

export function AccountSection({ heading }: { heading: string | null }): React.JSX.Element {
  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}
      <Card>
        <ProfileSection />
      </Card>
      <Card>
        <ChangePasswordSection />
      </Card>
      <Card>
        <RestrictedSection />
      </Card>
    </div>
  );
}
