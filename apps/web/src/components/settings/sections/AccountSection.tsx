// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/AccountSection.tsx
//
// Wave 2 lane L1 (Settings IA): extracted from the pre-IA
// apps/web/src/app/settings/page.tsx almost verbatim (Profile, Restricted
// content, Playback preferences — all real, all already wired to
// GET/PATCH /users/me, GET/PUT /users/me/restricted, GET/PUT
// /users/me/settings) so it can render both as the ONE thing a non-admin
// ever sees at /settings, and as the "Account" tab/hub-section a admin
// reaches at /settings/account (section-registry.ts) — this is the lane's
// one addition beyond the README's literal 8 tabs (see that file's header
// for why).
//
// Cleanup 1 (this lane's brief): the inert theme dark/light/system
// SegmentedControl is REMOVED from PlaybackPrefsSection below — Phosphor
// is dark-only (design/phosphor/README.md "Light theme — removed"; W0
// already deleted the data-theme mechanism and ThemeToggle), so this
// control could no longer do anything. UserSettings.theme itself is
// UNTOUCHED in the contract (removing a required contract field is a
// breaking change / an owner decision per this lane's hard line) — the PUT
// body below still round-trips `theme: settings.theme` exactly as fetched,
// unread and unwritten by any control, so the field stays byte-identical
// through every save this page makes.
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
import type { components } from "@loombre/sdk";
import styles from "./AccountSection.module.css";

type User = components["schemas"]["User"];
type UserSettings = components["schemas"]["UserSettings"];

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
      const body: { displayName: string | null; email: string; birthDate?: string } = {
        displayName: displayName || null,
        email,
      };
      if (birthDate) body.birthDate = birthDate;
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
    setStatus("saving");
    setError(null);
    try {
      const body: { optIn: boolean; pin?: string; currentPin?: string } = { optIn };
      if (pin) body.pin = pin;
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
        <>
          <label className={styles.field}>
            <span className={styles.label}>New PIN {state.hasPin ? "(leave blank to keep current)" : ""}</span>
            <TextInput type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </label>
          {state.hasPin && (
            <label className={styles.field}>
              <span className={styles.label}>Current PIN (required to change PIN or opt out)</span>
              <TextInput
                type="password"
                inputMode="numeric"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ""))}
              />
            </label>
          )}
        </>
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

function PlaybackPrefsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [autoplay, setAutoplay] = useState(true);
  const [subtitleLang, setSubtitleLang] = useState("");
  const [audioLang, setAudioLang] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet("/users/me/settings").then((s) => {
      setSettings(s);
      setAutoplay(s.autoplayNextEpisode);
      setSubtitleLang(s.subtitlePreferredLanguage ?? "");
      setAudioLang(s.audioPreferredLanguage ?? "");
    });
  }, []);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!settings) return;
    setStatus("saving");
    setError(null);
    try {
      // `theme` round-trips exactly as fetched — no control writes it
      // anymore (see this file's header, cleanup 1: the theme picker is
      // removed, the contract field is untouched).
      const updated = await apiPut("/users/me/settings", {
        body: {
          restrictedOptIn: settings.restrictedOptIn,
          locale: settings.locale,
          theme: settings.theme,
          subtitlePreferredLanguage: subtitleLang || null,
          audioPreferredLanguage: audioLang || null,
          autoplayNextEpisode: autoplay,
          updatedAtMs: settings.updatedAtMs,
        },
      });
      setSettings(updated);
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
      {/* Autoplay-next-episode control intentionally hidden (Addendum A
          doc-lane fix F3(c)): `autoplay`/`autoplayNextEpisode` still
          round-trips through GET/PUT /users/me/settings below exactly as
          before — untouched — but nothing in the player reads
          UserSettings.autoplayNextEpisode yet. Restore a control here once
          a player feature actually consumes the setting. */}
      <label className={styles.field}>
        <span className={styles.label}>Preferred audio language (ISO 639-2, e.g. eng)</span>
        <TextInput value={audioLang} onChange={(e) => setAudioLang(e.target.value)} maxLength={3} />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Preferred subtitle language (ISO 639-2)</span>
        <TextInput value={subtitleLang} onChange={(e) => setSubtitleLang(e.target.value)} maxLength={3} />
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
        <RestrictedSection />
      </Card>
      <Card>
        <PlaybackPrefsSection />
      </Card>
    </div>
  );
}
