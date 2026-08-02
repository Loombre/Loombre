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
// Cleanup 3 (H1, owner ledger item 6, CLOSED): the Playback-preferences form
// was removed here because its two fields (preferred audio/subtitle
// language) showed a green "Saved" for values PUT /users/me/settings
// silently discarded (it declared no @Body() at all, and mapSettings
// returned fixed defaults no matter what was sent) — the lying-save bug
// commit 9552333's audit flagged. That write path is now real
// (apps/server/src/catalog/users.controller.ts's putMySettings validates
// and persists into user_settings.prefs via @loombre/db's updateUserPrefs),
// so PlaybackPrefsSection below is restored — as two styled native <select>
// pickers under the Phosphor design language (packages/shared's
// LANGUAGE_CODES known-language list, NOT the old free-text maxLength=3
// TextInput markup this section used before cleanup 3 — that shape is
// gone for good, see `git show 9552333^` if the old form is ever needed for
// reference). Autoplay and UserSettings.theme's own UI fate are still OUT
// OF SCOPE here (orchestrator adjudication A-6): autoplay has no consuming
// player feature yet (Addendum A doc-lane fix F3(c)'s original reasoning
// still holds) and theme stays a separate owner decision (owner ledger item
// 6's remaining half) — both values still round-trip through the PUT body
// below UNCHANGED, exactly as fetched, so this form can never silently
// revert either one even though it offers no control for them.
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
// Subpath import, NOT the barrel: @loombre/shared's barrel also exports
// server-side modules importing node:crypto/node:path, which the Next
// production webpack build refuses to bundle (UnhandledSchemeError — it
// broke perf-lighthouse/perf-web-budget on the first 3-OS dispatch of the
// audit-residue run). language-codes is pure data + pure functions, safe
// for the client chunk; the subpath keeps the barrel out of the graph.
import { LANGUAGE_CODES } from "@loombre/shared/language-codes";
import type { components } from "@loombre/sdk";
import styles from "./AccountSection.module.css";

type User = components["schemas"]["User"];
type UserSettings = components["schemas"]["UserSettings"];

// Sorted once at module load, not per render — LANGUAGE_CODES is a fixed,
// immutable module-level constant (packages/shared/src/language-codes.ts).
const SORTED_LANGUAGE_OPTIONS = [...LANGUAGE_CODES].sort((a, b) => a.name.localeCompare(b.name));

// ── Current-password re-auth (G10, STATE.md "Current-password re-auth on
//    self-changes") — shared by ProfileSection, ChangePasswordSection, and
//    RestrictedSection below. A wrong currentPassword 403s with the SAME
//    fixed detail on every endpoint regardless of which field prompted the
//    check (F2/G3) — `code: "current-password-invalid"` is what
//    distinguishes it from every other 403/422 shape these forms already
//    render (a 422 currentPin mismatch, a 429 rate-limit trip, ...), so the
//    per-field error below is opt-in on that code alone, not on status.
function isCurrentPasswordInvalid(err: unknown): boolean {
  if (!(err instanceof LoombreApiError)) return false;
  const problem = err.problem;
  return (
    typeof problem === "object" &&
    problem !== null &&
    "code" in problem &&
    (problem as { code?: unknown }).code === "current-password-invalid"
  );
}

const RATE_LIMITED_MESSAGE = "Too many attempts. Wait a moment and try again.";

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

// G10: dirty-fields-only submission (true PATCH semantics) — a member is
// sent ONLY when its current value differs from the last-loaded/last-saved
// snapshot (`initial` below), never the full form state. This is what lets
// a bare displayName/birthDate-only save stay re-auth-free: updateMe's
// `dependentRequired` triggers on `email` being PRESENT in the body, not on
// its value, so omitting an unchanged email omits the requirement too.
// `emailDirty` is derived at render time (Phosphor's "derived, not stored"
// rule) — it governs BOTH whether `email`/`currentPassword` are sent and
// whether the Current password field is even shown, so the two can never
// drift apart.
function ProfileSection(): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [initial, setInitial] = useState({ displayName: "", email: "", birthDate: "" });
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet("/users/me").then((u) => {
      setUser(u);
      const loaded = { displayName: u.displayName ?? "", email: u.email ?? "", birthDate: u.birthDate ?? "" };
      setInitial(loaded);
      setDisplayName(loaded.displayName);
      setEmail(loaded.email);
      setBirthDate(loaded.birthDate);
    });
  }, []);

  // "set, changed, or cleared to null all count" (G10) — a plain string
  // inequality against the last-loaded snapshot covers all three: a fresh
  // value, an edited value, and "" (the form's empty-string-for-null
  // convention) differing from a previously non-empty stored address.
  const emailDirty = email !== initial.email;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("saving");
    setError(null);
    setCurrentPasswordError(null);
    try {
      // `birthDate`/`email` are `null` when the input is empty: the
      // contract types both `[string, 'null']` precisely so either can be
      // cleared — but each member is only PRESENT at all when it changed
      // (dirty-fields-only, see this function's header). displayName and
      // birthDate carry no re-auth requirement; email does, exactly when
      // present, so currentPassword rides along with it and nothing else.
      const body: { displayName?: string | null; email?: string | null; birthDate?: string | null; currentPassword?: string } =
        {};
      if (displayName !== initial.displayName) body.displayName = displayName || null;
      if (birthDate !== initial.birthDate) body.birthDate = birthDate || null;
      if (emailDirty) {
        body.email = email || null;
        body.currentPassword = currentPassword;
      }
      const u = await apiPatch("/users/me", { body });
      setUser(u);
      const loaded = { displayName: u.displayName ?? "", email: u.email ?? "", birthDate: u.birthDate ?? "" };
      setInitial(loaded);
      setDisplayName(loaded.displayName);
      setEmail(loaded.email);
      setBirthDate(loaded.birthDate);
      setCurrentPassword("");
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      if (isCurrentPasswordInvalid(err)) {
        setCurrentPasswordError(err instanceof LoombreApiError ? err.message : "Current password is incorrect.");
      } else if (err instanceof LoombreApiError && err.status === 429) {
        setError(RATE_LIMITED_MESSAGE);
      } else {
        setError(err instanceof LoombreApiError ? err.message : "Network error");
      }
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
        <span className={styles.label}>Email (optional)</span>
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {emailDirty && (
        <label className={styles.field}>
          <span className={styles.label}>Current password</span>
          <TextInput
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          {currentPasswordError && <span className={styles.fieldError}>{currentPasswordError}</span>}
        </label>
      )}
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
//
// G10/F4: `currentPassword` (below, always present) is ADDITIONAL to all of
// the above, not a PIN replacement — every call to this endpoint is
// account-critical (PIN set/change AND opt-in/out are one operation, F1),
// so RestrictedSettingsUpdate requires it literally regardless of which of
// optIn/pin/currentPin the call also carries.
function RestrictedSection(): React.JSX.Element {
  const { state, applyRestrictedSettings } = useRestricted();
  const [optIn, setOptIn] = useState(state.optIn);
  const [pin, setPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null);

  useEffect(() => setOptIn(state.optIn), [state.optIn]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setCurrentPasswordError(null);

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
      const body: { optIn: boolean; currentPassword: string; pin?: string; currentPin?: string } = {
        optIn,
        currentPassword,
      };
      if (newPin) body.pin = newPin;
      if (currentPin) body.currentPin = currentPin;
      const result = await apiPut("/users/me/restricted", { body });
      applyRestrictedSettings(result.optIn, result.hasPin);
      setPin("");
      setCurrentPin("");
      setCurrentPassword("");
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      if (isCurrentPasswordInvalid(err)) {
        setCurrentPasswordError(err instanceof LoombreApiError ? err.message : "Current password is incorrect.");
      } else if (err instanceof LoombreApiError && err.status === 429) {
        setError(RATE_LIMITED_MESSAGE);
      } else {
        setError(err instanceof LoombreApiError ? err.message : "Network error");
      }
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
      <label className={styles.field}>
        <span className={styles.label}>Current password</span>
        <TextInput
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
        {currentPasswordError && <span className={styles.fieldError}>{currentPasswordError}</span>}
      </label>
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
// or email save must never carry a password. G10/F1-F3 (STATE.md
// "Current-password re-auth on self-changes"): PATCH /users/me's
// `dependentRequired` now requires `currentPassword` whenever the body
// carries `password` — verified server-side against the caller's OWN
// stored hash (apps/server/src/catalog/users.controller.ts's updateMe via
// require-current-password.ts) before the change is applied, closing the
// stolen-session-can-rotate-the-password gap this comment used to name.
// F3: a successful change also revokes every OTHER device's session
// (the current one survives) — the success line below states that
// plainly, and only after a genuine 2xx (lying-Saved law).
function ChangePasswordSection(): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setCurrentPasswordError(null);
    if (password !== confirmation) {
      setStatus("error");
      setError("The two passwords don't match.");
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      await apiPatch("/users/me", { body: { password, currentPassword } });
      setCurrentPassword("");
      setPassword("");
      setConfirmation("");
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      if (isCurrentPasswordInvalid(err)) {
        setCurrentPasswordError(err instanceof LoombreApiError ? err.message : "Current password is incorrect.");
      } else if (err instanceof LoombreApiError && err.status === 429) {
        setError(RATE_LIMITED_MESSAGE);
      } else {
        setError(err instanceof LoombreApiError ? err.message : "Network error");
      }
    }
  }

  return (
    <form className={styles.section} onSubmit={handleSubmit}>
      <h2 className={styles.sectionTitle}>Password</h2>
      <p className={styles.sectionBody}>
        Changing your password signs your other devices out — this one stays signed in.
      </p>
      <label className={styles.field}>
        <span className={styles.label}>Current password</span>
        <TextInput
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
        {currentPasswordError && <span className={styles.fieldError}>{currentPasswordError}</span>}
      </label>
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
        {status === "saved" && <span className={styles.status}>Other devices have been signed out.</span>}
        <Button type="submit" variant="primary" disabled={status === "saving"}>
          Change password
        </Button>
      </div>
    </form>
  );
}

// H1 (owner ledger item 6, closed) — see this file's header (cleanup 3) for
// the lying-save bug this restores from. "No preference" is represented as
// the empty string in this form's OWN local state (a <select>'s `value`
// can't be `null`) and translated to/from the contract's `null` only at the
// GET/PUT boundary — never held as `null` in React state.
function PlaybackPrefsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [audioLang, setAudioLang] = useState("");
  const [subtitleLang, setSubtitleLang] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet("/users/me/settings").then((s) => {
      setSettings(s);
      setAudioLang(s.audioPreferredLanguage ?? "");
      setSubtitleLang(s.subtitlePreferredLanguage ?? "");
    });
  }, []);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!settings) return;
    setStatus("saving");
    setError(null);
    try {
      // restrictedOptIn/theme/autoplayNextEpisode/updatedAtMs all round-trip
      // EXACTLY as fetched — this form offers no control for any of them
      // (see this file's header, A-6): restrictedOptIn is readOnly server-
      // side regardless of what's sent, and the other three simply aren't
      // this form's concern. Only the two language fields, below, can
      // actually change here.
      const updated = await apiPut("/users/me/settings", {
        body: {
          restrictedOptIn: settings.restrictedOptIn,
          locale: settings.locale,
          theme: settings.theme,
          subtitlePreferredLanguage: subtitleLang || null,
          audioPreferredLanguage: audioLang || null,
          autoplayNextEpisode: settings.autoplayNextEpisode,
          updatedAtMs: settings.updatedAtMs,
        },
      });
      // "Saved" is reached ONLY via this line — it runs only after apiPut
      // resolves without throwing, i.e. only after a genuine 2xx (the
      // lying-save bug this whole section exists to not repeat: see this
      // file's header, cleanup 3).
      setSettings(updated);
      setAudioLang(updated.audioPreferredLanguage ?? "");
      setSubtitleLang(updated.subtitlePreferredLanguage ?? "");
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof LoombreApiError ? err.message : "Network error");
    }
  }

  if (!settings) return <p className={styles.sectionBody}>Loading…</p>;

  return (
    <form className={styles.section} onSubmit={handleSubmit}>
      <h2 className={styles.sectionTitle}>Playback</h2>
      <label className={styles.field}>
        <span className={styles.label}>Preferred audio language</span>
        <select className={styles.select} value={audioLang} onChange={(e) => setAudioLang(e.target.value)}>
          <option value="">No preference</option>
          {SORTED_LANGUAGE_OPTIONS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Preferred subtitle language</span>
        <select className={styles.select} value={subtitleLang} onChange={(e) => setSubtitleLang(e.target.value)}>
          <option value="">No preference</option>
          {SORTED_LANGUAGE_OPTIONS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
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
      <Card>
        <PlaybackPrefsSection />
      </Card>
    </div>
  );
}
