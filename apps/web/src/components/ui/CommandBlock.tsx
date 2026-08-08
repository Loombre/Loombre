// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/CommandBlock.tsx
//
// Compact, copyable, ordered shell-command block. Same clipboard pattern as
// SecretReveal's multiline mode (apps/web/src/components/ui/SecretReveal.tsx
// — copy icon-button, Copy→Check swap for 2s, graceful catch when the
// browser denies clipboard access) but WITHOUT SecretReveal's one-time-
// secret framing/warning: a CommandBlock's contents are commands to run,
// not a value that stops being valid after this render, so there is
// nothing to warn about.
//
// First consumer: DirectoryPicker's filesystem-permission-denied grant flow
// (the `remediation.commands` FilesystemPermissionRemediation carries,
// packages/contract/openapi.yaml) — but this is a generic reusable
// primitive, not specific to that caller.

import { useEffect, useRef, useState } from "react";
import { BoxSelect, Check, Copy } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { Button } from "./Button.js";
import styles from "./CommandBlock.module.css";

export interface CommandBlockProps {
  /** Shell commands, in order. Rendered one per line; copied to the
   *  clipboard joined with "\n" so a paste into a terminal runs every line
   *  in the same order they're shown. */
  commands: string[];
  /** Accessible label for the copy button. Defaults to "Copy commands". */
  ariaLabel?: string;
}

/** How long the copied/selected transient state stays up before reverting
 *  to the idle "Copy" affordance. */
const RESET_MS = 2000;

type CopyState = "idle" | "copied" | "selected";

export function CommandBlock({ commands, ariaLabel = "Copy commands" }: CommandBlockProps): React.JSX.Element {
  const [state, setState] = useState<CopyState>("idle");
  const commandsRef = useRef<HTMLDivElement>(null);
  // finding 16: the reset was a bare `setTimeout` with nothing to cancel
  // it — unmounting within the 2s window left a pending `setState` call on
  // a component that no longer exists. Keeping the id in a ref lets the
  // cleanup effect below cancel it.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  function scheduleReset(): void {
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setState("idle");
    }, RESET_MS);
  }

  /**
   * finding 7: `navigator.clipboard` is undefined in a non-secure context
   * (`http://<LAN-ip>` is this product's NORMAL admin case — the server is
   * reached over plain HTTP on the local network) — the Clipboard API does
   * not exist there at all, not merely deny access. Falling into the same
   * silent catch as an actual permission denial left Copy looking like it
   * did nothing. Selecting the command text works in every context,
   * secure or not, and puts the operator one Cmd/Ctrl-C away from the same
   * result.
   */
  function selectCommandText(): void {
    const node = commandsRef.current;
    const selection = window.getSelection();
    if (node === null || selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function handleCopy(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) {
        // Same shape as a denied/rejected clipboard call below — handled
        // by the single catch block so both paths fall back identically.
        throw new Error("Clipboard API unavailable");
      }
      // finding 18: deliberately no trailing newline. Modern zsh/bash
      // bracketed-paste holds the whole paste for review anyway, but on a
      // shell without that, no trailing newline means the paste can't
      // auto-execute its last line just from landing in the terminal.
      await navigator.clipboard.writeText(commands.join("\n"));
      setState("copied");
    } catch {
      // Clipboard access can be denied by the browser, or (finding 7) the
      // API can be entirely absent in a non-secure context — either way,
      // select the text instead so the click visibly did something (same
      // graceful-catch posture as SecretReveal's identical try/catch, plus
      // this fallback).
      selectCommandText();
      setState("selected");
    }
    scheduleReset();
  }

  const icon = state === "copied" ? Check : state === "selected" ? BoxSelect : Copy;
  const title = state === "selected" ? "Select & copy" : "Copy";

  return (
    <div className={styles.commandBlock}>
      <div className={styles.commands} ref={commandsRef}>
        {commands.map((command, i) => (
          <code key={i} className={styles.line}>
            {command}
          </code>
        ))}
      </div>
      <Button type="button" variant="ghost" iconOnly onClick={() => void handleCopy()} title={title}>
        <Icon icon={icon} size="dense" aria-label={ariaLabel} />
      </Button>
    </div>
  );
}
