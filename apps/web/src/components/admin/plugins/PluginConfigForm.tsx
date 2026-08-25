// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/plugins/PluginConfigForm.tsx
//
// LPP v1, Lane W5, C3: "manifest configSchema ... auto-renders the admin
// config form — no hand-built forms, ever." Reuses lib/settings-schema-
// widget.ts's resolveWidgetKind/numberConstraints/enumOptions/
// validateAgainstJsonSchema — the SAME key-agnostic schema->widget
// renderer apps/web/src/components/admin/settings/SettingField.tsx uses
// for the settings registry — dispatching only on lib/plugin-manifest.ts's
// resolvePluginFieldWidgetKind (settings-schema-widget's ordinary kinds
// plus the one LPP-specific extension, `secret`). No per-field-name
// branching anywhere in this file.
//
// One whole-object Save (unlike SettingField's per-key immediate PUT):
// registerAdminPlugin/updateAdminPluginConfig both take ONE `config`
// object, so this form collects every field's draft locally and submits
// them together via the caller-supplied onSubmit — reused identically by
// the registration wizard's config step (onSubmit just stashes the values
// in wizard state, nothing persisted yet) and the detail page's config
// editor (onSubmit calls apiPut(".../config", ...) directly).
//
// Secret fields (ProviderKeysCard's write-only pattern, C3): never
// pre-filled (there is nothing to pre-fill them with), tracked in a
// SEPARATE draft map so an untouched field is distinguishable from an
// explicit empty string — see lib/plugin-manifest.ts#buildConfigSubmission.

"use client";

import { useState } from "react";
import { TextInput } from "../../ui/Input.js";
import { Toggle } from "../../ui/Toggle.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { Button } from "../../ui/Button.js";
import { enumOptions, numberConstraints } from "../../../lib/settings-schema-widget.js";
import {
  buildConfigSubmission,
  buildInitialConfigDraft,
  resolvePluginFieldWidgetKind,
  validatePluginConfigDraft,
  type PluginConfigSchema,
} from "../../../lib/plugin-manifest.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./PluginConfigForm.module.css";

export interface PluginConfigFormProps {
  schema: PluginConfigSchema;
  /** Current NON-secret config values (empty for a fresh registration). */
  initialValues: Record<string, unknown>;
  /** True for a fresh registration (every required secret must be typed
   *  before continuing); false when editing an already-configured plugin
   *  (a blank secret field means "leave the existing keyring value alone"
   *  — see lib/plugin-manifest.ts#buildConfigSubmission's header). */
  requireAllSecrets: boolean;
  submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}

export function PluginConfigForm({
  schema,
  initialValues,
  requireAllSecrets,
  submitLabel,
  onSubmit,
}: PluginConfigFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => buildInitialConfigDraft(schema, initialValues));
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  // Raw text for "structured" (array/object) fields, kept separate from
  // `draft` so an in-progress edit that isn't valid JSON yet doesn't wipe
  // out the last successfully-parsed value — same reasoning SettingField's
  // rawText/dirty split documents.
  const [structuredText, setStructuredText] = useState<Record<string, string>>({});
  const [structuredErrors, setStructuredErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const entries = Object.entries(schema.properties);
  const required = new Set(schema.required ?? []);
  const validation = validatePluginConfigDraft(schema, draft, secretDrafts, requireAllSecrets);
  const hasStructuredError = Object.keys(structuredErrors).length > 0;
  const canSubmit = validation.valid && !hasStructuredError && !submitting;

  function handleStructuredChange(key: string, text: string): void {
    setStructuredText((prev) => ({ ...prev, [key]: text }));
    try {
      const parsed = JSON.parse(text) as unknown;
      setDraft((prev) => ({ ...prev, [key]: parsed }));
      setStructuredErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch {
      setStructuredErrors((prev) => ({ ...prev, [key]: "Invalid JSON." }));
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit(buildConfigSubmission(schema, draft, secretDrafts));
    } catch (err) {
      setFormError(apiErrorCopy(err, "Failed to save this configuration."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.form}>
      {entries.length === 0 && <p className={styles.empty}>This plugin has no configurable options.</p>}

      {entries.map(([key, field]) => {
        const kind = resolvePluginFieldWidgetKind(field);
        const fieldError = kind === "structured" ? structuredErrors[key] : validation.errors[key];
        const numeric = numberConstraints(field);

        return (
          <div key={key} className={styles.field}>
            <div className={styles.fieldHeader}>
              <span className={styles.fieldName}>{key}</span>
              {required.has(key) && (
                <span className={styles.requiredMark} aria-label="Required">
                  *
                </span>
              )}
              {kind === "secret" && <span className={styles.secretPill}>Write-only</span>}
            </div>
            {field["description"] !== undefined && typeof field["description"] === "string" && (
              <p className={styles.description}>{field["description"]}</p>
            )}

            {kind === "secret" && (
              <>
                <TextInput
                  type="password"
                  placeholder={requireAllSecrets ? "Paste value…" : "Leave blank to keep the current value…"}
                  autoComplete="off"
                  value={secretDrafts[key] ?? ""}
                  onChange={(e) => setSecretDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                <p className={styles.secretHint}>
                  Write-only — once saved, this value is never shown or returned again, here or on any other screen.
                </p>
              </>
            )}

            {kind === "boolean" && <Toggle checked={Boolean(draft[key])} onChange={(v) => setDraft((prev) => ({ ...prev, [key]: v }))} />}

            {kind === "enum" && (
              <SegmentedControl
                key={String(draft[key] ?? "")}
                options={enumOptions(field)}
                {...(typeof draft[key] === "string" ? { defaultValue: draft[key] as string } : {})}
                onChange={(v) => setDraft((prev) => ({ ...prev, [key]: v }))}
              />
            )}

            {kind === "number" && (
              <TextInput
                type="number"
                inputMode="numeric"
                value={draft[key] === undefined ? "" : String(draft[key])}
                {...(numeric.min !== undefined ? { min: numeric.min } : {})}
                {...(numeric.max !== undefined ? { max: numeric.max } : {})}
                step={numeric.integer ? 1 : "any"}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, [key]: e.target.value === "" ? undefined : Number(e.target.value) }))
                }
              />
            )}

            {kind === "string" && (
              <TextInput
                value={typeof draft[key] === "string" ? (draft[key] as string) : ""}
                onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            )}

            {kind === "structured" && (
              <textarea
                className={styles.description}
                spellCheck={false}
                rows={4}
                value={structuredText[key] ?? JSON.stringify(draft[key] ?? null, null, 2)}
                onChange={(e) => handleStructuredChange(key, e.target.value)}
              />
            )}

            {fieldError && <p className={styles.errorText}>{fieldError}</p>}
          </div>
        );
      })}

      {formError && <p className={styles.formError}>{formError}</p>}

      <div className={styles.actions}>
        <Button variant="primary" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
