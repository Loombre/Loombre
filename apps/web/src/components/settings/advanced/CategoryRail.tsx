// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/advanced/CategoryRail.tsx
//
// UIFIX-2026-08-29 Lane K: the 230px scope rail — All settings / Changed by
// me, then every category in REGISTRY RUNTIME ORDER with a live count (or
// the literal "env" when the category holds no editable key at all), then
// Env-locked.
//
// D-5 gap A1: the prototype shipped a <nav> of plain buttons — selection
// was background + colour + weight with no ARIA state at all, and 26
// sequential tab stops before the table. This is a real radiogroup: one tab
// stop, roving tabindex, Arrow/Home/End movement, aria-checked on the
// selected scope.
//
// DIVERGENCE from the prototype, deliberate (recorded in noted-K.md): the
// prototype visually de-selects every rail item while a search is running,
// so the rail "cannot disagree with what is shown". A radiogroup always has
// exactly one checked radio, so blanking the selection visually while
// aria-checked still points at it would make the two channels contradict
// each other. The selection stays visible and truthful in both; the toolbar
// title ("Results for …") is what says the query is overriding it, and
// picking any rail item clears the query anyway.

import { useRef } from "react";
import type { AdvancedScope, RailCategory, ScopeCounts } from "./advanced-model.js";
import styles from "./CategoryRail.module.css";

interface RailItem {
  id: string;
  label: string;
  /** Rendered right-aligned; a string because a category with no editable
   *  key shows the word "env" rather than 0. */
  count: string;
  scope: AdvancedScope;
  dimmed: boolean;
  hasModified: boolean;
}

export interface CategoryRailProps {
  categories: RailCategory[];
  counts: ScopeCounts;
  scope: AdvancedScope;
  onSelect: (scope: AdvancedScope) => void;
}

function scopeId(scope: AdvancedScope): string {
  return scope.type === "cat" ? `cat:${scope.id}` : scope.type;
}

export function CategoryRail({ categories, counts, scope, onSelect }: CategoryRailProps): React.JSX.Element {
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());

  const views: RailItem[] = [
    { id: "all", label: "All settings", count: String(counts.all), scope: { type: "all" }, dimmed: false, hasModified: false },
    { id: "mod", label: "Changed by me", count: String(counts.modified), scope: { type: "mod" }, dimmed: false, hasModified: false },
  ];
  const categoryItems: RailItem[] = categories.map((c) => ({
    id: `cat:${c.category}`,
    label: c.label,
    count: c.envOnly ? "env" : String(c.count),
    scope: { type: "cat", id: c.category },
    dimmed: c.envOnly,
    hasModified: c.hasModified,
  }));
  const envItems: RailItem[] = [
    { id: "env", label: "Env-locked", count: String(counts.envLocked), scope: { type: "env" }, dimmed: false, hasModified: false },
  ];
  const ordered = [...views, ...categoryItems, ...envItems];
  const activeId = scopeId(scope);

  function move(fromIndex: number, delta: number): void {
    const next = ordered[(fromIndex + delta + ordered.length) % ordered.length];
    if (!next) return;
    onSelect(next.scope);
    buttonsRef.current.get(next.id)?.focus();
  }

  function jump(index: number): void {
    const next = ordered[index];
    if (!next) return;
    onSelect(next.scope);
    buttonsRef.current.get(next.id)?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        move(index, 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        move(index, -1);
        break;
      case "Home":
        event.preventDefault();
        jump(0);
        break;
      case "End":
        event.preventDefault();
        jump(ordered.length - 1);
        break;
      default:
        break;
    }
  }

  function renderItem(item: RailItem): React.JSX.Element {
    const index = ordered.findIndex((i) => i.id === item.id);
    const checked = item.id === activeId;
    return (
      <button
        key={item.id}
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={checked ? 0 : -1}
        className={styles.item}
        data-dimmed={item.dimmed}
        ref={(node) => {
          if (node) buttonsRef.current.set(item.id, node);
          else buttonsRef.current.delete(item.id);
        }}
        onClick={() => onSelect(item.scope)}
        onKeyDown={(event) => onKeyDown(event, index)}
      >
        <span className={styles.itemLabel}>{item.label}</span>
        {item.hasModified && <span className={styles.modDot} aria-label="has overrides" role="img" />}
        <span className={styles.itemCount}>{item.count}</span>
      </button>
    );
  }

  return (
    <div className={styles.rail}>
      <div className={styles.group} role="radiogroup" aria-label="Setting scope">
        {views.map(renderItem)}
        <div className={styles.divider} aria-hidden="true" />
        <div className={styles.eyebrow}>Categories</div>
        {categoryItems.map(renderItem)}
        <div className={styles.divider} aria-hidden="true" />
        {envItems.map(renderItem)}
      </div>
      <p className={styles.footnote}>Set in the environment or a config file. Read-only here.</p>
    </div>
  );
}
