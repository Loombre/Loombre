// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/page.tsx
//
// First-boot onboarding wizard (STATE.md P4.6/P4.10). Full-screen, pre-auth
// — no AppShell (there is no signed-in viewer yet). Orchestrates step
// sequencing only; each step owns its own network calls and local state
// (see ./_components/*). Sequencing/validation logic is pure and lives in
// ./wizard-state.ts, unit-tested there without a rendering harness.
//
// Self-guard (task spec): "a configured instance never flashes the wizard
// route" — this page re-checks GET /setup/state itself (via the SAME
// AuthStore.checkNeedsSetup() the root boot redirect uses, so a normal
// /-> /setup navigation reuses the cached answer and a direct deep link to
// /setup gets its own fresh check) and bounces to /login the instant
// needsSetup is false. An already-authenticated device (e.g. back-button
// after finishing the wizard) bounces straight to /home.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAuthStore } from "../../lib/auth-store.js";
import { PillProgress } from "./_components/PillProgress.js";
import { WelcomeStep } from "./_components/WelcomeStep.js";
import { AdminStep } from "./_components/AdminStep.js";
import { LibraryStep } from "./_components/LibraryStep.js";
import { HardwareStep } from "./_components/HardwareStep.js";
import { RestrictedStep } from "./_components/RestrictedStep.js";
import { RestoreStep } from "./_components/RestoreStep.js";
import { DoneStep } from "./_components/DoneStep.js";
import { nextStep, type StepId, type WizardFlags } from "./wizard-state.js";
import styles from "./page.module.css";

const STEP_LABELS: Record<StepId, string> = {
  welcome: "Welcome",
  admin: "Admin",
  libraries: "Libraries",
  hardware: "Hardware",
  restricted: "Restricted",
  restore: "Restore",
  done: "Done",
};

type GuardState = "checking" | "ready" | "redirecting";

export default function SetupPage(): React.JSX.Element | null {
  const router = useRouter();
  const [guard, setGuard] = useState<GuardState>("checking");
  const [step, setStep] = useState<StepId>("welcome");
  const [flags, setFlags] = useState<WizardFlags>({ adminCreated: false, libraryCreatedThisSession: false });

  useEffect(() => {
    let cancelled = false;
    const store = getAuthStore();

    if (store.isAuthenticated()) {
      setGuard("redirecting");
      router.replace("/home");
      return;
    }

    void store.checkNeedsSetup().then((needsSetup) => {
      if (cancelled) return;
      if (!needsSetup) {
        setGuard("redirecting");
        router.replace("/login");
        return;
      }
      setGuard("ready");
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (guard !== "ready") return null;

  function advance(patch?: Partial<WizardFlags>): void {
    if (patch) setFlags((f) => ({ ...f, ...patch }));
    setStep((s) => nextStep(s));
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <PillProgress current={step} labels={STEP_LABELS} />
        <div className={styles.card}>
          {step === "welcome" && <WelcomeStep onNext={() => advance()} />}
          {step === "admin" && <AdminStep onNext={() => advance({ adminCreated: true })} />}
          {step === "libraries" && (
            <LibraryStep onNext={(created) => advance({ libraryCreatedThisSession: created })} />
          )}
          {step === "hardware" && <HardwareStep onNext={() => advance()} />}
          {step === "restricted" && <RestrictedStep onNext={() => advance()} />}
          {step === "restore" && <RestoreStep flags={flags} onNext={() => advance()} />}
          {step === "done" && <DoneStep onFinish={() => router.replace("/home")} />}
        </div>
      </div>
    </div>
  );
}
