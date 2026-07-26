// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/SettingField.tsx
//
// STATE.md Addendum A, decisions A6/A7/A8 (lane S2), restyled to Phosphor
// prototype fidelity by Wave-2 lane L6 (design/phosphor/README.md
// §Screens → Settings tab 7 "Advanced Server" + §Interactions → "Registry
// editing"). Renders ONE GET /admin/settings/schema entry, merged with its
// GET /admin/settings effective value, as a widget picked by
// lib/settings-schema-widget.ts#resolveWidgetKind — no per-key branching on
// `entry.key` anywhere in this file. Every field always shows description +
// default + current + source (mission spec), plus:
//   - A7: an inline caution when the registry carries one, a per-key
//     "reset to default" action, and client-side schema validation before
//     any submit (the restricted.majorityAgeYears >=18 floor falls out of
//     this for free — it's just that entry's schema minimum, no special
//     casing).
//   - A8: locked (env-pinned) and env-only entries render a read-only
//     value display with a Lock icon + "set by environment" caption —
//     visually distinct from an editable control, never a bare `disabled`
//     input with no explanation.
//   - README "Registry editing": typing marks a field dirty and enables
//     Save; Save validates client-side and shows an inline mono error on
//     failure; success shows "SAVED · APPLIED IMMEDIATELY"; Reset returns
//     to the default and is only offered once the value has changed.
//   - README footer: "DEFAULT" always shown, "PINNABLE <ENV_VAR>" only for
//     scope:'ui' entries that actually carry an envVar (env-only entries
//     name their env var inside the locked caption instead — they aren't
//     "pinnable", they're exclusively env-sourced).
//
// Layout split (see SettingsCategoryCard.tsx's header for the desktop/
// mobile rationale): this component owns its own responsive shape —
// borderless two-column row at desktop (info | editor, sharing the
// category's one box), a boxed single-column card at <=767.98px (the
// prototype boxes each key individually on mobile). Both are the SAME
// markup; only SettingField.module.css's media query changes which parts
// paint a border/radius/background.

"use client";

import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { TextInput } from "../../ui/Input.js";
import { Toggle } from "../../ui/Toggle.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { Button } from "../../ui/Button.js";
import {
  describeLocked,
  enumOptions,
  formatSettingValue,
  isAtDefault,
  isEditable,
  numberConstraints,
  resolveWidgetKind,
  validateAgainstJsonSchema,
  type JsonSchemaLike,
} from "../../../lib/settings-schema-widget.js";
import { apiPut, LoombreApiError } from "../../../lib/api-client.js";
import type { components } from "@loombre/sdk";
import styles from "./SettingField.module.css";

type AdminSettingSchemaEntry = components["schemas"]["AdminSettingSchemaEntry"];
type UpdateSettingResponse = components["schemas"]["UpdateSettingResponse"];
type SettingsValueSource = components["schemas"]["SettingsValueSource"];

function asJsonSchema(value: unknown): JsonSchemaLike {
  return (value ?? {}) as JsonSchemaLike;
}

export interface SettingFieldProps {
  entry: AdminSettingSchemaEntry;
  value: unknown;
  source: SettingsValueSource;
  onChanged: (result: UpdateSettingResponse) => void;
}

export function SettingField({ entry, value, source, onChanged }: SettingFieldProps): React.JSX.Element {
  const schema = asJsonSchema(entry.valueSchema);
  const kind = resolveWidgetKind(schema);
  const editable = isEditable(entry);
  const lockedCaption = describeLocked(entry);
  const atDefault = isAtDefault(value, entry.default);
  const pinnable = entry.scope === "ui" && entry.envVar !== undefined;

  const [rawText, setRawText] = useState<string>(() => (kind === "structured" ? JSON.stringify(value, null, 2) : String(value ?? "")));
  const [boolDraft, setBoolDraft] = useState<boolean>(Boolean(value));
  const [enumDraft, setEnumDraft] = useState<string>(typeof value === "string" ? value : "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-sync every local draft from a fresh external value (initial load,
  // a websocket-driven settings.updated refresh, or the response of this
  // field's own successful PUT) — but ONLY while the admin hasn't started
  // an in-progress edit, so a live refresh can never clobber unsaved input.
  useEffect(() => {
    if (dirty) return;
    setRawText(kind === "structured" ? JSON.stringify(value, null, 2) : String(value ?? ""));
    setBoolDraft(Boolean(value));
    setEnumDraft(typeof value === "string" ? value : "");
  }, [value, kind, dirty]);

  function parseDraft(): { ok: true; value: unknown } | { ok: false; error: string } {
    if (kind === "boolean") return { ok: true, value: boolDraft };
    if (kind === "enum") return { ok: true, value: enumDraft };
    if (kind === "number") {
      const n = Number(rawText);
      if (rawText.trim().length === 0 || Number.isNaN(n)) return { ok: false, error: "Must be a number." };
      return { ok: true, value: n };
    }
    if (kind === "string") return { ok: true, value: rawText };
    // structured
    try {
      return { ok: true, value: JSON.parse(rawText) };
    } catch {
      return { ok: false, error: "Invalid JSON." };
    }
  }

  const parsed = parseDraft();
  const validationError = parsed.ok ? validateAgainstJsonSchema(parsed.value, schema) : parsed.error;
  const canSave = editable && dirty && !saving && validationError === null;
  const numeric = numberConstraints(schema);
  // README "Registry editing": "Reset ... is only offered when the value
  // has been changed" — offered whenever the last-saved value differs from
  // the default (there's something to revert) OR the admin has an
  // in-progress dirty edit (so Reset can discard the draft too), never for
  // an untouched field already sitting at its default.
  const canReset = !atDefault || dirty;

  async function submit(nextValue: unknown, markDirtyFalseAfter: boolean): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await apiPut("/admin/settings/{key}", {
        params: { path: { key: entry.key } },
        body: { value: nextValue },
      });
      if (markDirtyFalseAfter) setDirty(false);
      setSaved(true);
      onChanged(result);
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to save this setting.");
    } finally {
      setSaving(false);
    }
  }

  function handleSave(): void {
    if (!parsed.ok) return;
    void submit(parsed.value, true);
  }

  function handleResetToDefault(): void {
    void submit(entry.default, false).then(() => {
      // Reflect the default in every draft representation immediately —
      // the next GET /admin/settings response (via onChanged -> parent
      // refetch) will confirm it, but this keeps the control from flashing
      // a stale value in the meantime.
      setRawText(kind === "structured" ? JSON.stringify(entry.default, null, 2) : String(entry.default ?? ""));
      setBoolDraft(Boolean(entry.default));
      setEnumDraft(typeof entry.default === "string" ? entry.default : "");
    });
  }

  function handleBoolToggle(): void {
    if (!editable) return;
    setBoolDraft(!boolDraft);
    setDirty(true);
  }

  function clampNumber(n: number): number {
    let v = n;
    if (numeric.min !== undefined) v = Math.max(numeric.min, v);
    if (numeric.max !== undefined) v = Math.min(numeric.max, v);
    return v;
  }

  function handleStep(delta: number): void {
    const current = Number(rawText);
    const base = Number.isFinite(current) ? current : typeof value === "number" ? value : 0;
    setRawText(String(clampNumber(base + delta)));
    setDirty(true);
  }

  // Only consulted by the editable-kind controls below (number/string/JSON)
  // — the locked branch never renders them, so "editable" isn't one of the
  // states this needs to express.
  const inputState = validationError && dirty ? "error" : dirty ? "dirty" : "clean";

  return (
    <div className={styles.field} data-locked={!editable || undefined}>
      <div className={styles.info}>
        <div className={styles.header}>
          <span className={styles.key}>{entry.key}</span>
          <span className={styles.sourcePill} data-source={source}>
            {source}
          </span>
          {entry.requiresRestart && <span className={styles.restartPill}>RESTART REQUIRED</span>}
        </div>

        <p className={styles.description}>{entry.description}</p>
        {entry.caution && <p className={styles.caution}>{entry.caution}</p>}

        <div className={styles.factRow}>
          <span className={styles.fact}>
            DEFAULT <span className={styles.factValue}>{formatSettingValue(entry.default)}</span>
          </span>
          <span className={[styles.fact, styles.factCurrent].join(" ")}>
            CURRENT <span className={[styles.factValue, styles.factValueCurrent].join(" ")}>{formatSettingValue(value)}</span>
          </span>
          {pinnable && (
            <span className={styles.fact}>
              PINNABLE <span className={styles.factValue}>{entry.envVar}</span>
            </span>
          )}
        </div>
      </div>

      <div className={styles.editorCol}>
        {!editable ? (
          <div className={styles.lockedDisplay}>
            <Icon icon="lock" size="dense" aria-label="Locked" />
            <div className={styles.lockedText}>
              <span className={styles.lockedValue}>{formatSettingValue(value)}</span>
              <span className={styles.lockedCaption}>{lockedCaption}</span>
            </div>
          </div>
        ) : (
          <div className={styles.editor}>
            {kind === "boolean" && (
              <div className={styles.boolRow} onClick={handleBoolToggle}>
                <span className={styles.boolLabel}>{boolDraft ? "ON" : "OFF"}</span>
                <Toggle checked={boolDraft} onChange={handleBoolToggle} />
              </div>
            )}

            {kind === "enum" && (
              <SegmentedControl
                key={enumDraft}
                options={enumOptions(schema)}
                defaultValue={enumDraft}
                onChange={(v) => {
                  setEnumDraft(v);
                  setDirty(true);
                }}
              />
            )}

            {kind === "number" && (
              <div className={styles.numberRow}>
                <button
                  type="button"
                  className={styles.stepButton}
                  onClick={() => handleStep(-1)}
                  aria-label="Decrease"
                >
                  <Icon icon={Minus} size="dense" />
                </button>
                <input
                  className={styles.numberInput}
                  data-state={inputState}
                  type="number"
                  inputMode="numeric"
                  value={rawText}
                  min={numeric.min}
                  max={numeric.max}
                  step={numeric.integer ? 1 : "any"}
                  onChange={(e) => {
                    setRawText(e.target.value);
                    setDirty(true);
                  }}
                />
                <button
                  type="button"
                  className={styles.stepButton}
                  onClick={() => handleStep(1)}
                  aria-label="Increase"
                >
                  <Icon icon={Plus} size="dense" />
                </button>
              </div>
            )}

            {kind === "string" && (
              <TextInput
                className={styles.stringInput}
                data-state={inputState}
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  setDirty(true);
                }}
              />
            )}

            {kind === "structured" && (
              <textarea
                className={styles.jsonEditor}
                data-state={inputState}
                value={rawText}
                spellCheck={false}
                onChange={(e) => {
                  setRawText(e.target.value);
                  setDirty(true);
                }}
              />
            )}

            {dirty && validationError && <p className={styles.errorText}>{validationError}</p>}
            {error && <p className={styles.errorText}>{error}</p>}
            {saved && !dirty && !error && <p className={styles.savedText}>SAVED · APPLIED IMMEDIATELY</p>}

            <div className={styles.actions}>
              {canReset && (
                <Button variant="ghost" onClick={handleResetToDefault} disabled={saving} title="Reset to default">
                  <Icon icon="reset" size="dense" />
                  Reset
                </Button>
              )}
              <Button variant="primary" onClick={handleSave} disabled={!canSave}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
