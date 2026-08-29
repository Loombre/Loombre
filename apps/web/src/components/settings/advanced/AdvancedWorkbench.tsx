// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/advanced/AdvancedWorkbench.tsx
//
// UIFIX-2026-08-29 Lane K: Settings › Advanced, rebuilt as a three-pane
// workbench — scope rail (230px) · key table (flex, 430px floor) · detail
// pane (352px inline, or a min(400px, 92vw) drawer + scrim below the
// 1150px work-area width, UD-20d).
//
// UD-3, frontend only. Everything here rides the EXISTING generated SDK:
//   GET /admin/settings/schema + GET /admin/settings  (useAdminSettingsData)
//   PUT /admin/settings/{key}   — updateAdminSetting, the ONLY write, and
//                                 it is PER KEY: there is no batch endpoint
//                                 and no reset operation, so "reset" is a
//                                 PUT of the schema default and a category
//                                 reset is a sequential loop of those
//                                 (SettingsCategoryCard's own A10 posture).
//   POST /system/restart        — restartServer, the operation
//                                 ServerPowerCard already calls. No
//                                 endpoint is invented anywhere on this page.
//
// AUTOSAVE. There is no Save button: a switch/enum commits on the click, a
// number/text field on `change` (blur or Enter — never per keystroke, which
// would be one PUT per character), and the correction is offered after the
// fact as an Undo inside the shared toast (UD-20c's additive action slot).
// A batch reset's Undo restores ALL N keys — D-5 defect D4: the prototype's
// restored only scopeResettable[0], silently leaving the rest at default.
//
// LIVE REFRESH. useAdminSettingsData refetches on the `settings.updated`
// socket event. Drafts are held in a map this component owns and a refetch
// never touches — a commit clears exactly the key it committed and nothing
// else — so a second admin's write can land mid-edit without clobbering an
// in-progress draft. draftsRef mirrors that map so a blur handler always
// reads the current text rather than a stale closure.
//
// PERF (UD-9). 58 rows render plainly — no virtualisation, no new
// dependency. The ResizeObserver below is the ONLY observer this route
// adds.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPost, apiPut } from "../../../lib/api-client.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import { isAtDefault } from "../../../lib/settings-schema-widget.js";
import { Button } from "../../ui/Button.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { useToast } from "../../ui/Toast.js";
import { CATEGORY_LABELS } from "../../admin/settings/SettingsCategoryCard.js";
import { SettingsRestartBanner } from "../../admin/settings/SettingsRestartBanner.js";
import { useAdminSettingsData } from "../sections/use-admin-settings-data.js";
import { CategoryRail } from "./CategoryRail.js";
import { DetailPanel } from "./DetailPanel.js";
import { KeyTable } from "./KeyTable.js";
import { SectionSwitcher } from "./SectionSwitcher.js";
import { parseDraft } from "./advanced-draft.js";
import {
  contextCopy,
  emptyCopy,
  innerWidthOf,
  isWideLayout,
  mergeEntries,
  railCategories,
  scopeCounts,
  showsKeyPrefix,
  visibleEntries,
  type AdvancedEntry,
  type AdvancedScope,
} from "./advanced-model.js";
import styles from "./AdvancedWorkbench.module.css";

/** UD-20c: the toast's read time for an autosaved change, long enough to
 *  notice the Undo. Passed through Toast's existing `durationMs`. */
const TOAST_DURATION_MS = 4200;

const SUBTITLE = "Every server setting, with what it does and where it lives. Changes save as you make them.";

interface KeyValue {
  key: string;
  value: unknown;
}

export function AdvancedWorkbench(): React.JSX.Element {
  const { schema, settings, error, refetch, retry } = useAdminSettingsData();
  const { showToast } = useToast();

  const [scope, setScope] = useState<AdvancedScope>({ type: "all" });
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [availW, setAvailW] = useState(0);
  const [restartArmed, setRestartArmed] = useState(false);
  const [workNode, setWorkNode] = useState<HTMLDivElement | null>(null);
  const draftsRef = useRef<Record<string, string>>({});

  // The ONE observer this route adds (UD-9). It measures the work area's
  // INNER width — clientWidth minus its own left/right padding — because
  // AppShell's sidebar sits outside this component and is 210px at desktop
  // but 76px collapsed (≤1279.98px): a viewport media query would be wrong
  // by a number that itself changes at a different breakpoint.
  useEffect(() => {
    if (!workNode) return;
    const measure = (): void => {
      const cs = getComputedStyle(workNode);
      const inner = innerWidthOf(
        workNode.clientWidth,
        Number.parseFloat(cs.paddingLeft) || 0,
        Number.parseFloat(cs.paddingRight) || 0,
      );
      setAvailW((prev) => (prev === inner ? prev : inner));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(workNode);
    return () => observer.disconnect();
  }, [workNode]);

  const entries = useMemo<AdvancedEntry[]>(() => {
    if (!schema || !settings) return [];
    return mergeEntries(schema.entries, settings.settings, (category) => CATEGORY_LABELS[category] ?? category);
  }, [schema, settings]);

  const setDraft = useCallback((key: string, text: string) => {
    draftsRef.current = { ...draftsRef.current, [key]: text };
    setDrafts(draftsRef.current);
  }, []);

  const clearDraft = useCallback((key: string) => {
    const next = { ...draftsRef.current };
    delete next[key];
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  const put = useCallback(async (key: string, value: unknown): Promise<void> => {
    await apiPut("/admin/settings/{key}", { params: { path: { key } }, body: { value } });
  }, []);

  const restore = useCallback(
    async (previous: KeyValue[]): Promise<void> => {
      try {
        for (const item of previous) await put(item.key, item.value);
      } catch (err) {
        showToast(apiErrorCopy(err, "Could not undo that change."), { variant: "danger" });
        return;
      }
      refetch();
      showToast(previous.length === 1 ? "Change undone" : `${previous.length} settings restored`, {
        durationMs: TOAST_DURATION_MS,
      });
    },
    [put, refetch, showToast],
  );

  /** One write path for every editor. `previous` is the pre-write snapshot
   *  of EVERY key in the batch, which is what makes a batch Undo whole. */
  const commit = useCallback(
    async (changes: KeyValue[], message: string, previous: KeyValue[]): Promise<void> => {
      if (changes.length === 0) return;
      try {
        for (const change of changes) await put(change.key, change.value);
      } catch (err) {
        showToast(apiErrorCopy(err, "Failed to save this setting."), { variant: "danger" });
        return;
      }
      for (const change of changes) clearDraft(change.key);
      refetch();
      showToast(message, {
        durationMs: TOAST_DURATION_MS,
        action: { label: "Undo", onAction: () => void restore(previous) },
      });
    },
    [put, clearDraft, refetch, showToast, restore],
  );

  const commitDraft = useCallback(
    (entry: AdvancedEntry): void => {
      const text = draftsRef.current[entry.key];
      if (text === undefined) return; // nothing typed since the last commit
      const parsed = parseDraft(entry, text);
      if (!parsed.ok) {
        // HELD, never sent: the raw text stays in the draft map, the field
        // is flagged inline, and entry.value keeps the last valid value.
        setErrors((prev) => ({ ...prev, [entry.key]: parsed.message }));
        return;
      }
      setErrors((prev) => {
        const next = { ...prev };
        delete next[entry.key];
        return next;
      });
      // Value parity, structural rather than referential (isAtDefault is
      // this repo's JSON-stringify comparison, so a retyped array or object
      // compares equal too): returning a field to the value it already
      // holds must not issue a write that would flip its `source` from
      // "default" to "database" for zero actual change — the d3-e7 /
      // browser-restricted-settings-F8 rule SettingField already follows.
      if (isAtDefault(parsed.value, entry.value)) {
        clearDraft(entry.key);
        return;
      }
      void commit([{ key: entry.key, value: parsed.value }], `${entry.leaf} set to ${text}`, [
        { key: entry.key, value: entry.value },
      ]);
    },
    [commit, clearDraft],
  );

  const toggleBoolean = useCallback(
    (entry: AdvancedEntry, next: boolean): void => {
      void commit([{ key: entry.key, value: next }], `${entry.leaf} turned ${next ? "on" : "off"}`, [
        { key: entry.key, value: entry.value },
      ]);
    },
    [commit],
  );

  const pickEnum = useCallback(
    (entry: AdvancedEntry, option: string): void => {
      if (option === entry.value) return;
      void commit([{ key: entry.key, value: option }], `${entry.leaf} set to ${option}`, [
        { key: entry.key, value: entry.value },
      ]);
    },
    [commit],
  );

  const resetEntry = useCallback(
    (entry: AdvancedEntry): void => {
      void commit([{ key: entry.key, value: entry.defaultValue }], `${entry.leaf} reset to default`, [
        { key: entry.key, value: entry.value },
      ]);
    },
    [commit],
  );

  const selectScope = useCallback((next: AdvancedScope): void => {
    setScope(next);
    // The rail can never disagree with what the table is showing: a query
    // overrides scope entirely, so picking a scope clears it.
    setQuery("");
  }, []);

  const rows = visibleEntries(entries, scope, query);
  const counts = scopeCounts(entries);
  const cats = railCategories(entries);
  const ctx = contextCopy(entries, rows, scope, query);
  const empty = emptyCopy(scope, query);
  const showPrefix = showsKeyPrefix(scope, query);
  const wide = isWideLayout(availW);
  // D-5 defect D7 ("selected is independent of the visible row set — Lane K
  // must decide"): the selection PERSISTS across a scope change. A detail
  // panel is the answer to an explicit "tell me about this key", and
  // dropping it every time the rail moves would make comparing a key
  // against another category impossible; the panel carries its own Close,
  // and a key that leaves `entries` entirely closes it by itself.
  const selected = entries.find((e) => e.key === selectedKey) ?? null;
  const resettable = rows.filter((r) => r.modified);
  const pendingKeys = settings?.restartPendingKeys ?? [];

  const resetScopeAction =
    scope.type === "cat" && query.trim().length === 0 && resettable.length > 0
      ? {
          label: `Reset ${resettable.length} changed`,
          onReset: (): void => {
            void commit(
              resettable.map((r) => ({ key: r.key, value: r.defaultValue })),
              `${resettable.length} settings reset to default`,
              resettable.map((r) => ({ key: r.key, value: r.value })),
            );
          },
        }
      : null;

  /** Navigates to the first pending key AND selects it. Eight of the
   *  fifteen requiresRestart keys are env-only, and a category scope shows
   *  only editable keys — so a read-only pending key goes to the Env-locked
   *  view instead, where it is actually listed. */
  function showPendingKey(): void {
    const key = pendingKeys[0];
    if (key === undefined) return;
    const entry = entries.find((e) => e.key === key);
    setQuery("");
    if (entry) setScope(entry.editable ? { type: "cat", id: entry.category } : { type: "env" });
    setSelectedKey(key);
  }

  async function restartNow(): Promise<void> {
    setRestartArmed(false);
    try {
      await apiPost("/system/restart", {});
      showToast("Restarting the server…", { variant: "warning", durationMs: TOAST_DURATION_MS });
    } catch (err) {
      showToast(apiErrorCopy(err, "Could not restart the server."), { variant: "danger" });
    }
  }

  const header = (
    <SectionSwitcher
      current="advanced"
      open={menuOpen}
      onToggle={() => setMenuOpen((open) => !open)}
      onClose={() => setMenuOpen(false)}
      subtitle={SUBTITLE}
    />
  );

  if (error !== null) {
    return (
      <div className={styles.screen}>
        {header}
        <div className={styles.stateBlock}>
          <p className={styles.errorBanner} role="alert">
            {error}
          </p>
          <div>
            <Button type="button" variant="secondary" onClick={retry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!schema || !settings) {
    return (
      <div className={styles.screen}>
        {header}
        <div className={styles.stateBlock} aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} radius="lg" height={120} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      {header}

      <div className={styles.bannerSlot}>
        <SettingsRestartBanner
          keys={pendingKeys}
          actions={
            <>
              <Button type="button" variant="ghost" onClick={showPendingKey}>
                Show key
              </Button>
              {restartArmed ? (
                <>
                  <Button type="button" variant="warning" onClick={() => void restartNow()}>
                    Confirm restart
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setRestartArmed(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button type="button" variant="warning" onClick={() => setRestartArmed(true)}>
                  Restart now
                </Button>
              )}
            </>
          }
        />
      </div>

      <div className={styles.workArea} ref={setWorkNode}>
        <CategoryRail categories={cats} counts={counts} scope={scope} onSelect={selectScope} />
        <KeyTable
          rows={rows}
          totalKeys={entries.length}
          contextTitle={ctx.title}
          contextMeta={ctx.meta}
          emptyTitle={empty.title}
          emptyHint={empty.hint}
          showPrefix={showPrefix}
          query={query}
          onQueryChange={setQuery}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          draftFor={(key) => drafts[key]}
          errorFor={(key) => errors[key]}
          onDraftChange={setDraft}
          onCommitDraft={commitDraft}
          onToggleBoolean={toggleBoolean}
          resetScope={resetScopeAction}
        />
        {selected !== null && wide && (
          <DetailPanel
            entry={selected}
            wide
            draft={drafts[selected.key]}
            error={errors[selected.key]}
            onClose={() => setSelectedKey(null)}
            onGoCategory={(category) => selectScope({ type: "cat", id: category })}
            onDraftChange={setDraft}
            onCommitDraft={commitDraft}
            onPickEnum={pickEnum}
            onToggleBoolean={toggleBoolean}
            onReset={resetEntry}
          />
        )}
      </div>

      {selected !== null && !wide && (
        <>
          {/* A dismissal CONVENIENCE only — the panel's own Close button and
              Escape are the keyboard-reachable ways out (D-5 gap A5). */}
          <div className={styles.scrim} onClick={() => setSelectedKey(null)} aria-hidden="true" />
          <DetailPanel
            entry={selected}
            wide={false}
            draft={drafts[selected.key]}
            error={errors[selected.key]}
            onClose={() => setSelectedKey(null)}
            onGoCategory={(category) => selectScope({ type: "cat", id: category })}
            onDraftChange={setDraft}
            onCommitDraft={commitDraft}
            onPickEnum={pickEnum}
            onToggleBoolean={toggleBoolean}
            onReset={resetEntry}
          />
        </>
      )}
    </div>
  );
}
