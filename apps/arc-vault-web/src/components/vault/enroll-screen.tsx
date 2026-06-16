"use client";

import * as React from "react";
import { ArrowRight, Check, Download, Loader2, Lock, Printer, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandPanel } from "@/components/brand/brand-panel";
import { CopyButton } from "@/components/arc/copy-button";
import { PasswordStrength } from "@/components/arc/password-strength";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { Reveal } from "@/components/motion/reveal";
import { cn } from "@/lib/utils";

interface Props {
  busy: boolean;
  /** Null until `onEnroll` resolves; when it becomes set the ceremony advances to the
   *  recovery-key step. This is the *real* recovery key from the SDK `enroll()`. */
  recoveryKey: string | null;
  /** Triggers the real enroll() in the parent (generates keys + the recovery key). */
  onEnroll: (password: string) => void;
  /** Acknowledged the recovery key → load vaults + unlock. */
  onComplete: () => void;
  /** Abandon enrollment, back to the unlock view. */
  onBack: () => void;
}

type Step = "password" | "recovery" | "done";

/**
 * Enrollment + recovery-key ceremony (arc design system `enroll.html`), adapted to the
 * real flow: sign-in already happened, so we start at the master password. Steps:
 *   password → (real enroll() runs) → recovery-key ceremony → done.
 *
 * Pure presentation over the existing `enroll()`: same crypto, same recovery key, shown
 * once — with a forced "I've saved it" gate before the vault opens.
 */
export function EnrollScreen({ busy, recoveryKey, onEnroll, onComplete, onBack }: Props) {
  const [step, setStep] = React.useState<Step>("password");
  const [password, setPassword] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);

  // When the parent hands back the generated recovery key, advance to the ceremony.
  React.useEffect(() => {
    if (recoveryKey && step === "password") setStep("recovery");
  }, [recoveryKey, step]);

  const strength = scorePassword(password);
  const chunks = React.useMemo(
    () => (recoveryKey ?? "").replace(/[^A-Za-z0-9]/g, "").match(/.{1,4}/g) ?? [],
    [recoveryKey],
  );

  const download = () => {
    if (!recoveryKey) return;
    const blob = new Blob([`arc recovery key\n\n${recoveryKey}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "arc-recovery-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const stepIndex = step === "password" ? 0 : step === "recovery" ? 1 : 2;

  return (
    <div className="grid min-h-[calc(100dvh-3.5rem)] md:grid-cols-[1.05fr_1fr]">
      <BrandPanel variant="enroll" />
      <div className="bg-arc-mesh relative flex items-center">
        <div className="mx-auto flex w-full max-w-md flex-col gap-7 px-6 py-12 sm:py-16">
          {/* progress dots */}
          <div className="flex items-center gap-2">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={cn(
                  "h-[7px] rounded-full transition-all [transition-duration:var(--dur-base)]",
                  i === stepIndex ? "w-5 bg-primary" : i < stepIndex ? "w-[7px] bg-primary" : "w-[7px] bg-border",
                )}
              />
            ))}
          </div>

          {step === "password" ? (
            <Reveal variant="fade-up" offset={8}>
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!password) return;
                  setSubmitted(true);
                  onEnroll(password);
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-3xl font-semibold tracking-tight">Set your master password</h1>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    This is the <strong className="text-foreground">only</strong> thing that protects you.
                    arc never sees it — it&apos;s stretched with Argon2id on this device.
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="enroll-password" className="text-[13px] font-medium">
                    Master password
                  </Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="enroll-password"
                      type="password"
                      autoComplete="new-password"
                      className="pl-9"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      suppressHydrationWarning
                      autoFocus
                    />
                  </div>
                  {password ? (
                    <div className="mt-1">
                      <PasswordStrength score={strength.score} crackTime={strength.crackTime} />
                    </div>
                  ) : null}
                </div>

                <Button size="lg" type="submit" className="mt-1 w-full" disabled={busy || !password}>
                  {busy && submitted ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Creating vault
                    </>
                  ) : (
                    <>
                      Continue <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>

                <div className="flex items-center justify-between">
                  <TrustIndicator kind="local" />
                  <button
                    type="button"
                    onClick={onBack}
                    disabled={busy}
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    Back to unlock
                  </button>
                </div>
              </form>
            </Reveal>
          ) : step === "recovery" ? (
            <Reveal variant="fade-up" offset={8}>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-3xl font-semibold tracking-tight">Save your recovery key</h1>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    If you ever forget your master password, this key is the{" "}
                    <strong className="text-foreground">only</strong> way back in. We&apos;ll show it once.
                  </p>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {chunks.map((c, i) => (
                    <span
                      key={i}
                      className="rounded-md border border-input bg-[var(--surface-inset)] px-1 py-2.5 text-center font-mono text-sm tracking-[0.04em]"
                    >
                      {c}
                    </span>
                  ))}
                </div>

                <div className="flex flex-wrap gap-2">
                  <CopyButton value={recoveryKey ?? ""} label="Copy" autoClearSeconds={0} />
                  <Button variant="secondary" size="sm" onClick={() => window.print()}>
                    <Printer className="h-3.5 w-3.5" /> Print
                  </Button>
                  <Button variant="secondary" size="sm" onClick={download}>
                    <Download className="h-3.5 w-3.5" /> Download
                  </Button>
                </div>

                <div className="flex gap-2.5 rounded-md border border-[color:color-mix(in_oklab,var(--warning)_28%,transparent)] bg-[var(--warning-subtle)] p-3 text-xs leading-relaxed text-muted-foreground">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--warning)]" />
                  <span>
                    Store it somewhere safe and offline. arc cannot recover it for you — that&apos;s
                    what keeps it zero-knowledge.
                  </span>
                </div>

                <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={saved}
                    onChange={(e) => setSaved(e.target.checked)}
                    className="h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
                  />
                  I&apos;ve saved my recovery key somewhere safe
                </label>

                <Button size="lg" className="w-full" disabled={!saved} onClick={() => setStep("done")}>
                  Confirm &amp; finish <Check className="h-4 w-4" />
                </Button>
              </div>
            </Reveal>
          ) : (
            <Reveal variant="scale">
              <div className="flex flex-col gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--success-subtle)] text-[var(--success)]">
                  <Check className="h-6 w-6" strokeWidth={2.5} />
                </span>
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-3xl font-semibold tracking-tight">You&apos;re all set</h1>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Your vault is protected by a key only you hold. Let&apos;s add your first secret.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <TrustIndicator kind="zk" />
                  <TrustIndicator kind="pq" />
                </div>
                <Button size="lg" className="mt-1 w-full" disabled={busy} onClick={onComplete}>
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Opening vault
                    </>
                  ) : (
                    <>
                      Open arc <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </Reveal>
          )}
        </div>
      </div>
    </div>
  );
}

/** Lightweight strength heuristic (length + character classes). Presentational only —
 *  the real protection is Argon2id on the derived key, surfaced in the copy. */
function scorePassword(pw: string): { score: number; crackTime: string } {
  if (!pw) return { score: 0, crackTime: "instant" };
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  const len = pw.length;
  let score = 0;
  if (len >= 8) score = 1;
  if (len >= 12 && classes >= 2) score = 2;
  if (len >= 16 && classes >= 3) score = 3;
  if (len >= 20 && classes >= 3) score = 4;
  const crackTime = score >= 4 ? "centuries" : score === 3 ? "years" : score === 2 ? "weeks" : "hours";
  return { score, crackTime };
}
