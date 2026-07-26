// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { Bell, ChevronDown, Search, User } from "lucide-react";
import { BlazeMark, type BlazeMarkVariant } from "../../components/brand/BlazeMark.js";
import { Icon } from "../../components/icon/Icon.js";
import { Button } from "../../components/ui/Button.js";
import { Badge, Chip, Tag } from "../../components/ui/Chip.js";
import { SearchField, TextInput } from "../../components/ui/Input.js";
import { SegmentedControl } from "../../components/ui/SegmentedControl.js";
import { ProgressBar, ScrubberMock } from "../../components/ui/ProgressBar.js";
import { DialogDemo, MenuDemo, PopoverDemo } from "../../components/ui/Overlay.js";
import { BottomSheet } from "../../components/ui/BottomSheet.js";
import { SheetOrModal } from "../../components/ui/SheetOrModal.js";
import { ToastProvider, useToast } from "../../components/ui/Toast.js";
import { Avatar, Card } from "../../components/ui/Card.js";
import { Skeleton } from "../../components/skeleton/Skeleton.js";
import styles from "./page.module.css";

// ── Phosphor primitive demos (STATE.md Phosphor W1b: bottom-sheet + toast) ──
// These are the ONLY live consumers of BottomSheet/SheetOrModal/ToastProvider
// in this codebase today — everything else that will use them is Wave-2
// scope. Kept here (rather than only in a test) so the orchestrator and the
// W3 fidelity audit can exercise both primitives without a real flow.

function SheetDemo(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open bottom sheet
      </Button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Add library" sub="Choose a folder to scan">
        <p style={{ margin: 0, color: "var(--muted)" }}>
          The body scrolls independently of the header/handle; max-height caps at 82% of the viewport. Escape,
          scrim-tap, or Done all close it — try each.
        </p>
      </BottomSheet>
    </>
  );
}

function SheetOrModalDemo(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open SheetOrModal (narrow the viewport below 768px for the sheet)
      </Button>
      <SheetOrModal open={open} onClose={() => setOpen(false)} title="Responsive dialog" sub="Same API, breakpoint picks the shell">
        <p style={{ margin: 0, color: "var(--muted)" }}>
          Renders BottomSheet on phone-width viewports, a centered dialog above the breakpoint.
        </p>
      </SheetOrModal>
    </>
  );
}

function ToastDemo(): React.JSX.Element {
  const { showToast } = useToast();
  return (
    <>
      <Button variant="secondary" onClick={() => showToast("ADDED TO WATCHLIST")}>
        Show toast (accent)
      </Button>
      <Button variant="secondary" onClick={() => showToast("RESTRICTED ITEMS HIDDEN · PIN TO UNLOCK", { variant: "warning" })}>
        Show toast (warning)
      </Button>
    </>
  );
}

// ── Blaze mark fixture (STATE.md "Blaze logo rollout" W0 task E, owner
// checkpoint harness): 3 variants × 4 sizes on both spec surfaces
// (#0B0C0F app bg, #101218 "tile" — G4: #101218 duplicates no token, a
// local literal is fine on a fixture page), each cell labeled with the
// requested variant/size and whether the D5 size gate downgraded it to
// flat, plus one static/animated side-by-side to prove the two render
// modes are visually identical when the animated core's `surface` prop
// matches the surrounding background exactly. ──────────────────────────

const BLAZE_VARIANTS: readonly BlazeMarkVariant[] = ["gradient", "scanline", "flat"];
const BLAZE_SIZES = [16, 24, 48, 120] as const;

function BlazeSurfaceGrid({
  label,
  surfaceClassName,
}: {
  label: string;
  // CSS-module imports type as `{ readonly [key: string]: string }`, so
  // property access is `string | undefined` under noUncheckedIndexedAccess
  // even though the class genuinely exists at runtime (page.module.css
  // defines it) — accept the union rather than asserting it away.
  surfaceClassName: string | undefined;
}): React.JSX.Element {
  return (
    <div className={`${styles.blazeSurface} ${surfaceClassName}`}>
      <span className={styles.blazeSurfaceLabel}>{label}</span>
      <div className={styles.blazeGrid}>
        {BLAZE_VARIANTS.flatMap((variant) =>
          BLAZE_SIZES.map((size) => {
            const downgraded = size < 24 && variant !== "flat";
            return (
              <div className={styles.blazeCell} key={`${variant}-${size}`}>
                <BlazeMark variant={variant} size={size} />
                <span className={styles.blazeCellLabel}>
                  {variant} · {size}px · {downgraded ? "downgraded" : "ok"}
                </span>
              </div>
            );
          }),
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  radius,
  children,
}: {
  title: string;
  radius?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeading}>
        <span>{title}</span>
        {radius && <span className={styles.radiusLabel}>{radius}</span>}
      </div>
      <div className={styles.row}>{children}</div>
    </section>
  );
}

export default function StyleguidePage(): React.JSX.Element {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Loombre Styleguide</h1>
      </header>

      <Section title="Buttons — pill" radius="--radius-pill">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
      </Section>

      <Section title="Icon-only button — full (circle)" radius="--radius-full">
        <Button variant="secondary" iconOnly aria-label="Search">
          <Icon icon={Search} />
        </Button>
        <Button variant="secondary" iconOnly aria-label="Notifications">
          <Icon icon={Bell} />
        </Button>
      </Section>

      <Section title="Chips / tags / badges — pill + sm" radius="--radius-pill / --radius-sm">
        <Chip>Chip</Chip>
        <Tag>Genre tag</Tag>
        <Badge>12</Badge>
      </Section>

      <Section title="Text input — pill" radius="--radius-pill">
        <TextInput className={styles.field} placeholder="Type something…" />
      </Section>

      <Section title="Search field — pill" radius="--radius-pill">
        <SearchField className={styles.field} placeholder="Search your library…" />
      </Section>

      <Section title="Segmented control — pill" radius="--radius-pill">
        <SegmentedControl options={["Movies", "Series", "Music"]} />
      </Section>

      <Section title="Progress bar — pill" radius="--radius-pill">
        <div style={{ width: 260 }}>
          <ProgressBar percent={62} />
        </div>
      </Section>

      <Section title="Scrubber mock — pill" radius="--radius-pill">
        <div style={{ width: 400 }}>
          <ScrubberMock percent={38} />
        </div>
      </Section>

      <Section title="Dropdown menu (open) — lg" radius="--radius-lg">
        <MenuDemo items={["Profile", "Devices", "Sign out"]} />
      </Section>

      <Section title="Dialog (open, glass overlay) — lg" radius="--radius-lg">
        <DialogDemo>
          <h3 style={{ margin: 0 }}>Confirm</h3>
          <p style={{ color: "var(--muted)" }}>This is a glass-overlay dialog.</p>
          <div className={styles.row}>
            <Button variant="ghost">Cancel</Button>
            <Button variant="primary">Confirm</Button>
          </div>
        </DialogDemo>
      </Section>

      <Section title="Popover — lg" radius="--radius-lg">
        <PopoverDemo>
          <div className={styles.row} style={{ gap: "var(--space-xs)" }}>
            <Icon icon={ChevronDown} size="dense" />
            <span>Popover content</span>
          </div>
        </PopoverDemo>
      </Section>

      <Section title="Bottom sheet — lg (20px top corners, grab handle, Done)" radius="--radius-lg">
        <SheetDemo />
      </Section>

      <Section title="SheetOrModal — responsive seam (sheet on phone, dialog on desktop)" radius="--radius-lg">
        <SheetOrModalDemo />
      </Section>

      <Section title="Toast — pill, accent dot, uppercase mono, 2.6s auto-dismiss" radius="--radius-pill">
        <ToastProvider>
          <ToastDemo />
        </ToastProvider>
      </Section>

      <Section title="Phosphor chrome — flat translucent scrim over a backdrop" radius="--radius-lg">
        <div className={styles.glassDemoBackdrop}>
          <div className={styles.glassDemoPanel}>Chrome scrim over artwork</div>
        </div>
      </Section>

      <p className={styles.glassNote}>
        Fallback: browsers without backdrop-filter support (
        <code>@supports not (backdrop-filter: blur(1px))</code>) render every
        glass surface as an opaque elevated surface — <code>var(--color-surface)</code>,
        no blur, no transparency. Same markup, same radius, no separate code path.
      </p>

      <Section title="Card — lg" radius="--radius-lg">
        <Card>
          <strong>Card title</strong>
          <p style={{ color: "var(--muted)", margin: "var(--space-xs) 0 0" }}>Card body content.</p>
        </Card>
      </Section>

      <Section title="Poster tile with blurhash placeholder + hover lift — md" radius="--radius-md">
        <div className={styles.demoTile} tabIndex={0}>
          <div className={styles.demoTileGradient} />
        </div>
      </Section>

      <Section title="Avatar — full (circle)" radius="--radius-full">
        <Avatar label="Admin" />
        <Icon icon={User} />
      </Section>

      <Section title="Skeleton variants next to their real counterparts">
        <div className={styles.pair}>
          <div>
            <Skeleton radius="pill" width={100} height={36} />
            <div className={styles.pairLabel}>skeleton (pill)</div>
          </div>
          <div>
            <Button variant="primary">Loaded</Button>
            <div className={styles.pairLabel}>real button</div>
          </div>
        </div>
        <div className={styles.pair}>
          <div>
            <Skeleton radius="md" width={160} height={240} />
            <div className={styles.pairLabel}>skeleton (md)</div>
          </div>
          <div>
            <div className={styles.demoTile}>
              <div className={styles.demoTileGradient} />
            </div>
            <div className={styles.pairLabel}>real poster tile</div>
          </div>
        </div>
        <div className={styles.pair}>
          <div>
            <Skeleton radius="full" width={36} height={36} />
            <div className={styles.pairLabel}>skeleton (full)</div>
          </div>
          <div>
            <Avatar label="Admin" />
            <div className={styles.pairLabel}>real avatar</div>
          </div>
        </div>
      </Section>

      <Section title="Blaze mark — 3 variants × 16/24/48/120px, two surfaces">
        <div className={styles.blazeSurfaces}>
          <BlazeSurfaceGrid label="#0B0C0F — app bg" surfaceClassName={styles.blazeSurfaceDark} />
          <BlazeSurfaceGrid label="#101218 — tile" surfaceClassName={styles.blazeSurfaceTile} />
        </div>
      </Section>

      <Section title="Blaze mark — static vs animated parity (same surface, same variant)">
        <div className={`${styles.blazeParityDemo} ${styles.blazeSurfaceDark}`}>
          <div className={styles.blazeCell}>
            <BlazeMark variant="gradient" size={120} />
            <span className={styles.blazeCellLabel}>static · one evenodd path</span>
          </div>
          <div className={styles.blazeCell}>
            <BlazeMark variant="gradient" size={120} animated surface="#0b0c0f" />
            <span className={styles.blazeCellLabel}>animated · two paths, surface=#0B0C0F</span>
          </div>
        </div>
      </Section>

      <Section title="Focus ring demo — tab into these">
        <Button variant="secondary">Focusable button</Button>
        <TextInput className={styles.field} placeholder="Focusable input" />
        <div className={styles.demoTile} tabIndex={0} style={{ width: 60, height: 60 }}>
          <div className={styles.demoTileGradient} />
        </div>
      </Section>
    </div>
  );
}
