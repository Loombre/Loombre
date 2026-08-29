// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/advanced/DetailPanel.tsx
//
// UIFIX-2026-08-29 Lane K: the third pane — inline at/above the 1150px
// work-area width (UD-20d), a fixed min(400px, 92vw) drawer with a scrim
// below it.
//
// D-5 gap A4: the prototype's <aside> had no role, no aria-modal, no
// labelling, no initial focus, no trap, no focus return, and Escape did not
// close it — in drawer mode the whole page behind the scrim stayed tabbable.
// All of that is supplied here; the scrim is a dismissal CONVENIENCE, never
// the only way out (A5).
//
// UD-20b: the Default row renders the wire `default` for every key. The
// prototype's "chosen from your OS" copy for the two platformDerivedDefault
// keys is dropped — that flag is not projected onto the wire at all
// (D-4 §3.4), so the browser cannot know which keys it applies to and
// inventing a two-key client list would be a second source of truth.

import { useEffect, useId, useRef } from "react";
import { Lock, X } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { describeLocked, enumOptions, formatSettingValue } from "../../../lib/settings-schema-widget.js";
import { sourceCopy, type AdvancedEntry } from "./advanced-model.js";
import styles from "./DetailPanel.module.css";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DetailPanelProps {
  entry: AdvancedEntry;
  /** true → inline third pane; false → fixed drawer + scrim. */
  wide: boolean;
  draft: string | undefined;
  error: string | undefined;
  onClose: () => void;
  onGoCategory: (category: string) => void;
  onDraftChange: (key: string, text: string) => void;
  onCommitDraft: (entry: AdvancedEntry) => void;
  onPickEnum: (entry: AdvancedEntry, option: string) => void;
  onToggleBoolean: (entry: AdvancedEntry, next: boolean) => void;
  onReset: (entry: AdvancedEntry) => void;
}

export function DetailPanel(props: DetailPanelProps): React.JSX.Element {
  const {
    entry,
    wide,
    draft,
    error,
    onClose,
    onGoCategory,
    onDraftChange,
    onCommitDraft,
    onPickEnum,
    onToggleBoolean,
    onReset,
  } = props;
  const panelRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const errorId = useId();
  // Read through a ref so the effect below can depend on `wide` ALONE.
  // onClose is an inline arrow at every call site, so a dependency on it
  // would re-run the effect on every render — which in drawer mode means
  // re-stealing focus into the panel on each keystroke and firing the
  // "return focus to the opener" cleanup continuously.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus management. In drawer mode this is a real modal: focus moves in,
  // Tab is trapped, and focus returns to whatever opened it. Inline, only
  // Escape-to-close applies — the panel is an ordinary third column and
  // stealing focus into it on every row click would fight the table.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panelRef.current;
    // The panel itself, not its first control: assistive tech then reads the
    // dialog's own label before anything inside it.
    if (!wide && node) node.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || wide || !node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === node)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (!wide && opener && document.contains(opener)) opener.focus();
    };
  }, [wide]);

  const lockCopy = describeLocked({
    scope: entry.scope,
    locked: entry.locked,
    ...(entry.envVar !== undefined ? { envVar: entry.envVar } : {}),
    ...(entry.lockedBy !== undefined ? { lockedBy: entry.lockedBy } : {}),
  });
  const source = sourceCopy(entry);
  const isEnum = entry.widget === "enum";
  const isBoolean = entry.widget === "boolean";
  const isStructured = entry.widget === "structured";
  // A boolean gets the same two-pill control an enum does rather than the
  // prototype's free-text field — "type the word true" is not an editor.
  const isSimple = entry.editable && !isEnum && !isBoolean && !isStructured;
  const technical = [entry.technicalDetails, entry.envVar ? `Environment variable: ${entry.envVar}` : undefined]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");

  return (
    <aside
      className={styles.panel}
      data-drawer={!wide}
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      {...(wide ? {} : { role: "dialog" as const, "aria-modal": true })}
    >
      <div className={styles.header}>
        <div className={styles.headerText}>
          <button type="button" className={styles.categoryLink} onClick={() => onGoCategory(entry.category)}>
            {entry.categoryLabel}
            <span aria-hidden="true" className={styles.categoryGlyph}>
              ↗
            </span>
          </button>
          <div className={styles.key} id={titleId}>
            {entry.key}
          </div>
        </div>
        <button type="button" className={styles.close} aria-label="Close details" onClick={onClose}>
          <Icon icon={X} size="dense" strokeWidth={1.6} aria-hidden />
        </button>
      </div>

      <div className={styles.body}>
        <p className={styles.description}>{entry.description}</p>

        {entry.caution !== undefined && <p className={styles.caution}>{entry.caution}</p>}

        <div className={styles.block}>
          <div className={styles.eyebrow}>Value</div>

          {lockCopy !== null ? (
            <div className={styles.lockedCard}>
              <div className={styles.lockedRow}>
                <span className={styles.lockGlyph} aria-hidden="true">
                  <Icon icon={Lock} size="dense" strokeWidth={1.6} aria-hidden />
                </span>
                <span className={styles.lockedValue}>{formatSettingValue(entry.value)}</span>
              </div>
              <p className={styles.lockedCaption}>{lockCopy}</p>
            </div>
          ) : (
            <>
              {isEnum && (
                <div className={styles.optionRow} role="group" aria-label={`${entry.key} options`}>
                  {enumOptions(entry.valueSchema).map((option) => {
                    const selected = entry.value === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        className={styles.optionPill}
                        data-selected={selected}
                        aria-pressed={selected}
                        onClick={() => onPickEnum(entry, option)}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              )}

              {isBoolean && (
                <div className={styles.optionRow} role="group" aria-label={`${entry.key} options`}>
                  {[true, false].map((option) => (
                    <button
                      key={String(option)}
                      type="button"
                      className={styles.optionPill}
                      data-selected={entry.value === option}
                      aria-pressed={entry.value === option}
                      onClick={() => onToggleBoolean(entry, option)}
                    >
                      {option ? "On" : "Off"}
                    </button>
                  ))}
                </div>
              )}

              {isStructured && (
                <>
                  <textarea
                    className={styles.jsonEditor}
                    spellCheck={false}
                    aria-label={entry.key}
                    aria-invalid={error !== undefined}
                    {...(error !== undefined ? { "aria-describedby": errorId } : {})}
                    value={draft ?? JSON.stringify(entry.value, null, 2)}
                    onChange={(event) => onDraftChange(entry.key, event.target.value)}
                    onBlur={() => onCommitDraft(entry)}
                  />
                  {error !== undefined && (
                    <span className={styles.errorText} id={errorId}>
                      {error}
                    </span>
                  )}
                </>
              )}

              {isSimple && (
                <>
                  <p className={styles.hint}>Edit inline in the list, or here:</p>
                  <input
                    className={styles.simpleInput}
                    type="text"
                    aria-label={entry.key}
                    aria-invalid={error !== undefined}
                    {...(error !== undefined ? { "aria-describedby": errorId } : {})}
                    value={draft ?? (typeof entry.value === "string" ? entry.value : String(entry.value ?? ""))}
                    onChange={(event) => onDraftChange(entry.key, event.target.value)}
                    onBlur={() => onCommitDraft(entry)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onCommitDraft(entry);
                      }
                    }}
                  />
                  {error !== undefined && (
                    <span className={styles.errorText} id={errorId}>
                      {error}
                    </span>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <dl className={styles.facts}>
          <div className={styles.factRow}>
            <dt className={styles.factLabel}>Default</dt>
            <dd className={styles.factValue}>{formatSettingValue(entry.defaultValue)}</dd>
          </div>
          <div className={styles.factRow}>
            <dt className={styles.factLabel}>Source</dt>
            <dd className={styles.factValue} data-tone={source.tone}>
              {source.text}
            </dd>
          </div>
          {entry.requiresRestart && (
            <div className={styles.factRow}>
              <dt className={styles.factLabel}>Applies</dt>
              <dd className={styles.factValue} data-tone="environment">
                after restart
              </dd>
            </div>
          )}
        </dl>

        {technical.length > 0 && (
          <div className={styles.block}>
            <div className={styles.eyebrow}>Technical detail</div>
            <p className={styles.technical}>{technical}</p>
          </div>
        )}

        {entry.modified && (
          <button type="button" className={styles.reset} onClick={() => onReset(entry)}>
            <span aria-hidden="true" className={styles.resetGlyph}>
              ↺
            </span>
            Reset to default
          </button>
        )}
      </div>
    </aside>
  );
}
