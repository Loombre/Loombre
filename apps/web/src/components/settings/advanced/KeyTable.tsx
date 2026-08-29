// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/advanced/KeyTable.tsx
//
// UIFIX-2026-08-29 Lane K: the middle pane — toolbar, sticky column header,
// and one row per key with its editor inline.
//
// Three prototype defects are fixed here rather than transcribed (D-5
// §3.11):
//   D1 — the prototype's row <div> set `cursor: pointer` and attached NO
//        onClick; only the Setting-cell button selected. Clicking the blurb's
//        trailing whitespace, the State cell or the row padding did nothing
//        while the cursor promised otherwise. Rows are now real, selectable,
//        keyboard-reachable grid rows (role="grid"/"row"/"gridcell",
//        aria-selected, roving tabindex, Arrow/Home/End).
//   D2 — the >24-char short-text unmount. Widget kind comes from the SCHEMA
//        (advanced-model.ts's rowEditorKind), so it cannot flip mid-edit.
//   D6 — no validation at all. Every commit routes through
//        advanced-draft.ts's parseDraft, i.e. through the projected JSON
//        Schema, so a bound like majorityAgeYears >= 18 is enforced before
//        the PUT rather than described in prose.
//
// UD-5 (compositor-only motion): the boolean switch expresses its on/off
// colour as an OPACITY CROSSFADE of two stacked track layers and two
// stacked thumb layers, plus a transform on the thumb — never the
// prototype's `transition: background-color`.

import { useId, useRef } from "react";
import { Lock, Search } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { describeLocked } from "../../../lib/settings-schema-widget.js";
import { summaryText } from "./advanced-draft.js";
import { rowEditorKind, type AdvancedEntry } from "./advanced-model.js";
import styles from "./KeyTable.module.css";

export interface KeyTableProps {
  rows: AdvancedEntry[];
  totalKeys: number;
  contextTitle: string;
  contextMeta: string;
  emptyTitle: string;
  emptyHint: string;
  showPrefix: boolean;
  query: string;
  onQueryChange: (next: string) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Draft text for a key currently being edited, or undefined when the
   *  row is showing the committed value. */
  draftFor: (key: string) => string | undefined;
  errorFor: (key: string) => string | undefined;
  onDraftChange: (key: string, text: string) => void;
  onCommitDraft: (entry: AdvancedEntry) => void;
  onToggleBoolean: (entry: AdvancedEntry, next: boolean) => void;
  resetScope: { label: string; onReset: () => void } | null;
}

function displayText(entry: AdvancedEntry, draft: string | undefined): string {
  if (draft !== undefined) return draft;
  const value = entry.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}

export function KeyTable(props: KeyTableProps): React.JSX.Element {
  const {
    rows,
    totalKeys,
    contextTitle,
    contextMeta,
    emptyTitle,
    emptyHint,
    showPrefix,
    query,
    onQueryChange,
    selectedKey,
    onSelect,
    draftFor,
    errorFor,
    onDraftChange,
    onCommitDraft,
    onToggleBoolean,
    resetScope,
  } = props;

  const rowsRef = useRef(new Map<string, HTMLDivElement>());
  const errorIdPrefix = useId();

  /** Roving tabindex: the selected row owns the single tab stop; with no
   *  selection the first row does, so the table is always reachable in one
   *  Tab from the toolbar. */
  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.key === selectedKey),
  );

  function moveRowFocus(index: number, delta: number): void {
    const next = rows[(index + delta + rows.length) % rows.length];
    if (!next) return;
    onSelect(next.key);
    rowsRef.current.get(next.key)?.focus();
  }

  function onRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>, index: number, entry: AdvancedEntry): void {
    if (event.target !== event.currentTarget) return; // a control inside the row owns its own keys
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveRowFocus(index, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveRowFocus(index, -1);
        break;
      case "Home":
        event.preventDefault();
        moveRowFocus(-1, 1);
        break;
      case "End":
        event.preventDefault();
        moveRowFocus(0, -1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        onSelect(entry.key);
        break;
      default:
        break;
    }
  }

  function renderEditor(entry: AdvancedEntry): React.JSX.Element {
    const kind = rowEditorKind(entry);
    const draft = draftFor(entry.key);
    const error = errorFor(entry.key);
    const errorId = `${errorIdPrefix}-${entry.key}`;

    if (kind === "switch") {
      const on = draft !== undefined ? draft === "true" : entry.value === true;
      return (
        <>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={entry.key}
            className={styles.switch}
            onClick={() => onToggleBoolean(entry, !on)}
          >
            <span className={styles.track} data-on={on}>
              <span className={styles.trackOn} />
              <span className={styles.thumb}>
                <span className={styles.thumbOn} />
              </span>
            </span>
          </button>
          <span className={styles.switchText} aria-hidden="true">
            {on ? "ON" : "OFF"}
          </span>
        </>
      );
    }

    if (kind === "number" || kind === "text") {
      return (
        <span className={styles.inputWrap}>
          <input
            className={kind === "number" ? styles.numberInput : styles.textInput}
            type="text"
            {...(kind === "number" ? { inputMode: "numeric" as const } : {})}
            aria-label={entry.key}
            aria-invalid={error !== undefined}
            {...(error !== undefined ? { "aria-describedby": errorId } : {})}
            value={displayText(entry, draft)}
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
            <span className={styles.inlineError} id={errorId}>
              {error}
            </span>
          )}
        </span>
      );
    }

    const summary = summaryText(entry, entry.value);
    return (
      <button
        type="button"
        className={styles.summary}
        aria-label={`${entry.key}: ${summary}. Open details`}
        onClick={() => onSelect(entry.key)}
      >
        <span className={styles.summaryText}>{summary}</span>
        <span className={styles.summaryChevron} aria-hidden="true">
          ›
        </span>
      </button>
    );
  }

  return (
    <section className={styles.pane} aria-label="Setting keys">
      <div className={styles.toolbar}>
        <div className={styles.context}>
          <div className={styles.contextTitle}>{contextTitle}</div>
          {/* D-5 gap A13: this line is the only feedback a search gives, and
              in the prototype it changed silently. */}
          <div className={styles.contextMeta} aria-live="polite">
            {contextMeta}
          </div>
        </div>
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon} aria-hidden="true">
            <Icon icon={Search} size="dense" />
          </span>
          <input
            className={styles.searchInput}
            type="search"
            aria-label="Search all settings"
            placeholder={`Search all ${totalKeys} settings…`}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        {resetScope && (
          <button type="button" className={styles.resetScope} onClick={resetScope.onReset}>
            {resetScope.label}
          </button>
        )}
      </div>

      <div className={styles.scroll}>
        <div className={styles.grid} role="grid" aria-label="Advanced settings">
          <div className={styles.headRow} role="row">
            <span role="columnheader">Setting</span>
            <span role="columnheader">Value</span>
            <span className={styles.headState} role="columnheader">
              State
            </span>
          </div>
          {rows.map((entry, index) => {
            const selected = entry.key === selectedKey;
            const lockCopy = describeLocked({
              scope: entry.scope,
              locked: entry.locked,
              ...(entry.envVar !== undefined ? { envVar: entry.envVar } : {}),
              ...(entry.lockedBy !== undefined ? { lockedBy: entry.lockedBy } : {}),
            });
            return (
              <div
                key={entry.key}
                className={styles.row}
                role="row"
                aria-selected={selected}
                tabIndex={index === focusIndex ? 0 : -1}
                data-selected={selected}
                ref={(node) => {
                  if (node) rowsRef.current.set(entry.key, node);
                  else rowsRef.current.delete(entry.key);
                }}
                onClick={() => onSelect(entry.key)}
                onKeyDown={(event) => onRowKeyDown(event, index, entry)}
              >
                <div className={styles.cellKey} role="gridcell">
                  <span className={styles.keyLine}>
                    {showPrefix && entry.prefix.length > 0 && <span className={styles.keyPrefix}>{entry.prefix}</span>}
                    <span className={styles.keyLeaf}>{showPrefix ? entry.leaf : entry.key}</span>
                  </span>
                  <span className={styles.blurb}>{entry.description}</span>
                </div>
                <div className={styles.cellValue} role="gridcell">
                  {renderEditor(entry)}
                </div>
                <div className={styles.cellState} role="gridcell">
                  {entry.requiresRestart && (
                    <span className={styles.rsPill}>
                      <span className={styles.srOnly}>Needs a restart</span>
                      <span aria-hidden="true">RS</span>
                    </span>
                  )}
                  {entry.modified && <span className={styles.modDot} role="img" aria-label="Changed from default" />}
                  {lockCopy !== null && (
                    <span className={styles.lockGlyph} role="img" aria-label={lockCopy}>
                      <Icon icon={Lock} size="dense" strokeWidth={1.6} aria-hidden />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>{emptyTitle}</div>
            <p className={styles.emptyHint}>{emptyHint}</p>
          </div>
        )}
      </div>
    </section>
  );
}
