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
//   - README footer: "DEFAULT" always shown, "PINNABLE" only for scope:'ui'
//     entries that actually carry an envVar (env-only entries name their
//     env var inside the locked caption instead — they aren't "pinnable",
//     they're exclusively env-sourced). The env var's NAME itself lives in
//     the W13a info tooltip below, not inline in this fact — see that
//     section's comment.
//
// Layout split (see SettingsCategoryCard.tsx's header for the desktop/
// mobile rationale): this component owns its own responsive shape —
// borderless two-column row at desktop (info | editor, sharing the
// category's one box), a boxed single-column card at <=767.98px (the
// prototype boxes each key individually on mobile). Both are the SAME
// markup; only SettingField.module.css's media query changes which parts
// paint a border/radius/background.
//
// W8 (readable typography) + W13a (technical-detail tooltip mechanism,
// locked decision D-7) — both landed together because they touch the
// same header/description/metadata block:
//   - W8: key name, description, and the DEFAULT/CURRENT/PINNABLE metadata
//     line were all below comfortable reading size. Fixed sizes (see
//     SettingField.module.css's own comments at each rule): description
//     >= --text-base (14.5px, clears the 0.875rem/14px floor); metadata
//     line exactly one rung below that on the SAME --text-* scale
//     (--text-sm, 13px — not two rungs down at --text-xs); key name
//     bumped proportionally alongside body.
//   - W13a: two-layer copy (D-7) — the visible description stays
//     plain-language (its rewrite is Wave-2 item W13b; this lane only
//     builds the mechanism), and a new ⓘ info affordance next to the key
//     name reveals precise technical detail on hover/focus/click. The ONE
//     piece of technical detail this component already had on hand — the
//     PINNABLE line's raw env-pin name — moves into that tooltip instead
//     of sitting in the visible metadata row as raw jargon; DEFAULT/
//     CURRENT/PINNABLE stay visible as labels, just without the bare
//     LOOMBRE_* value inline. Callers can supply additional technical
//     copy (protocol notes, etc.) via the optional `technicalDetails`
//     prop — omitted today by every real call site (SettingsCategoryCard),
//     so this ships purely additive; wiring per-key protocol notes into it
//     is Wave-2 scope alongside the copy sweep.

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info, Minus, Plus } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { TextInput } from "../../ui/Input.js";
import { Toggle } from "../../ui/Toggle.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { Button } from "../../ui/Button.js";
import { useEscapeKey } from "../../ui/overlay-hooks.js";
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
  /** W13a / D-7's second copy layer: precise technical detail (protocol
   *  notes, format specifics, etc.) for the info tooltip beside the key
   *  name. Optional and additive — every current call site omits it, so
   *  existing pages keep compiling unchanged; this is where Wave-2's
   *  per-key copy sweep (W13b) plugs in. Combined with (not a replacement
   *  for) the env-pin note this component derives on its own below. */
  technicalDetails?: string;
}

/**
 * D-7's info affordance: a small ⓘ button beside the key name that reveals
 * `details` in a Phosphor popover surface. Opens on hover AND keyboard
 * focus (desktop); click/tap TOGGLES it independently of hover/focus so a
 * touch tap (which fires neither reliably — iOS Safari in particular does
 * not focus a tapped, non-input <button>) still works as a standalone
 * open/close. Three independent open-sources OR'd together, rather than
 * one shared boolean, so a mouse click's own resulting focus event can't
 * fight a same-tick click toggle: clicking a mouse-focused trigger only
 * ever toggles the click source off, never fights the focus source still
 * holding it open, and blurring away still unconditionally closes it.
 * Escape dismissal reuses overlay-hooks.ts's `useEscapeKey` — the same
 * hook every other Phosphor overlay in this app uses, per that file's own
 * "identical behavior instead of two hand-rolled copies" header comment.
 */
function InfoTooltip({ label, details }: { label: string; details: string }): React.JSX.Element {
  const tooltipId = useId();
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [clickOpen, setClickOpen] = useState(false);
  const open = hoverOpen || focusOpen || clickOpen;

  function closeAll(): void {
    setHoverOpen(false);
    setFocusOpen(false);
    setClickOpen(false);
  }

  useEscapeKey(open, closeAll);

  return (
    <span className={styles.infoWrap}>
      <button
        type="button"
        className={styles.infoButton}
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => setHoverOpen(true)}
        onMouseLeave={() => setHoverOpen(false)}
        onFocus={() => setFocusOpen(true)}
        onBlur={() => setFocusOpen(false)}
        onClick={() => setClickOpen((v) => !v)}
      >
        <Icon icon={Info} size="dense" />
      </button>
      {open && (
        <span role="tooltip" id={tooltipId} className={styles.infoTooltip}>
          {details}
        </span>
      )}
    </span>
  );
}

export function SettingField({ entry, value, source, onChanged, technicalDetails }: SettingFieldProps): React.JSX.Element {
  const schema = asJsonSchema(entry.valueSchema);
  const kind = resolveWidgetKind(schema);
  const editable = isEditable(entry);
  const lockedCaption = describeLocked(entry);
  const atDefault = isAtDefault(value, entry.default);
  const pinnable = entry.scope === "ui" && entry.envVar !== undefined;
  // The env-pin name used to sit in the visible PINNABLE fact as raw
  // jargon (see the PINNABLE <span> below, which now shows the label
  // only); it lives here instead, folded into whatever technical copy the
  // caller supplied, so the field never loses that detail even before
  // W13b's per-key copy sweep adds richer notes of its own.
  const envPinDetail = pinnable ? `Pinnable via environment variable ${entry.envVar}.` : null;
  const technicalNotes = [technicalDetails?.trim(), envPinDetail].filter((note): note is string => Boolean(note)).join(" ");
  const hasTechnicalDetails = technicalNotes.length > 0;

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
  // `dirty` gates this but must NOT be a dependency: Save/Reset clear it
  // locally the instant their PUT resolves, before onChanged's refetch has
  // round-tripped — so `value` here is still the pre-write snapshot for a
  // moment. Depending on `dirty` would re-run this effect on that
  // transition alone and repaint that stale `value`, flashing it over the
  // optimistic default/edit Save/Reset just painted. Reading `dirty` from a
  // ref means this only resyncs when `value` itself actually changes.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setRawText(kind === "structured" ? JSON.stringify(value, null, 2) : String(value ?? ""));
    setBoolDraft(Boolean(value));
    setEnumDraft(typeof value === "string" ? value : "");
  }, [value, kind]);

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

  async function submit(nextValue: unknown, markDirtyFalseAfter: boolean): Promise<boolean> {
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
      return true;
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to save this setting.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function handleSave(): void {
    if (!parsed.ok) return;
    void submit(parsed.value, true);
  }

  function handleResetToDefault(): void {
    void submit(entry.default, false).then((ok) => {
      if (!ok) return;
      // Reflect the default in every draft representation immediately, and
      // clear `dirty` in this SAME batch — NOT via markDirtyFalseAfter,
      // which would clear it before this write lands and let the resync
      // effect above re-run against the still-stale `value` prop, flashing
      // the pre-reset value. Clearing dirty here also re-arms the effect
      // for the next external update (live refresh, another admin's write)
      // instead of leaving this field frozen on its last local snapshot.
      // The next GET /admin/settings response (via onChanged -> parent
      // refetch) will confirm the default explicitly.
      setRawText(kind === "structured" ? JSON.stringify(entry.default, null, 2) : String(entry.default ?? ""));
      setBoolDraft(Boolean(entry.default));
      setEnumDraft(typeof entry.default === "string" ? entry.default : "");
      setDirty(false);
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
          {hasTechnicalDetails && <InfoTooltip label={`Technical details for ${entry.key}`} details={technicalNotes} />}
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
          {/* The env-pin NAME itself no longer sits here (W13a/D-7) — it's
              folded into the info tooltip above alongside any other
              technical detail; this label is just the boolean "yes, an
              env var can override this key" signal. */}
          {pinnable && <span className={styles.fact}>PINNABLE</span>}
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
              // LD-13 hardening: previously the ROW div also carried
              // onClick={handleBoolToggle}, duplicating Toggle's own
              // onChange — this was a REAL, reproduced dead-switch bug, not
              // a harmless redundancy (opus-review LD wave, Finding 2 —
              // see SettingField.test.tsx's "exactly one net toggle" test
              // for the confirmed red-then-green proof). A click landing on
              // the switch itself (its track/thumb, not the row's ON/OFF
              // text) reaches the app as TWO SEPARATE native click
              // dispatches: the user's own click, then — synthesized by the
              // browser's native <label>-to-<input> click-forwarding (HTML
              // spec activation behavior) — a second click on the <input>
              // itself. React 18 flushes discrete click updates at the end
              // of EACH native dispatch, so the first dispatch's flip was
              // already committed by the time the second dispatch's
              // handlers ran: dispatch A (row onClick) read the pre-click
              // value and flipped it; dispatch B (Toggle onChange AND row
              // onClick, both firing off the SAME forwarded click) each
              // read dispatch A's already-committed value and flipped it
              // BACK. Net effect: false -> true -> false — the switch
              // visibly failed to respond to a click on itself, while
              // clicking the ON/OFF text (a single dispatch, no
              // label-forwarding involved) worked fine, which is what made
              // this easy to dismiss as user error rather than a real bug.
              // Exactly one element now owns each interactive target: the
              // label text has its own onClick, the switch is governed
              // solely by Toggle's onChange. Same visual affordance (click
              // the text OR the switch), zero redundant invocations, by
              // construction rather than by lucky batching.
              <div className={styles.boolRow}>
                <span className={styles.boolLabel} onClick={handleBoolToggle}>
                  {boolDraft ? "ON" : "OFF"}
                </span>
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
