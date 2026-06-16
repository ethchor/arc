"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, Copy, Download, Loader2, Lock, Printer, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandPanel } from "@/components/brand/brand-panel";
import { PasswordStrength } from "@/components/arc/password-strength";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { Stagger } from "@/components/motion/stagger";
import { DUR, EASE, SPRING_SNAPPY, SPRING_SOFT } from "@/lib/motion";
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

/** One directional slide+fade per ceremony step. Horizontal offset is modest (16px) so it
 *  reads as "moving to the next page" without ever overflowing the `px-6` form gutter.
 *  Under `prefers-reduced-motion` (MotionConfig, root layout) the x-transform is dropped
 *  and only the opacity crossfade remains. */
const stepVariants = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
};

/**
 * Enrollment + recovery-key ceremony (arc design system `enroll.html`), adapted to the
 * real flow: sign-in already happened, so we start at the master password. Steps:
 *   password → (real enroll() runs) → recovery-key ceremony → done.
 *
 * Pure presentation over the existing `enroll()`: same crypto, same recovery key, shown
 * once — with a forced "I've saved it" gate before the vault opens. The recovery key never
 * leaves this device; Copy / Print / Download all build their artifact client-side.
 */
export function EnrollScreen({ busy, recoveryKey, onEnroll, onComplete, onBack }: Props) {
  const [step, setStep] = React.useState<Step>("password");
  const [password, setPassword] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const copyKey = async () => {
    if (!recoveryKey) return;
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard can fail in non-secure contexts; the visual stays at "Copy" */
    }
  };

  // When the parent hands back the generated recovery key, advance to the ceremony.
  React.useEffect(() => {
    if (recoveryKey && step === "password") setStep("recovery");
  }, [recoveryKey, step]);

  // Clear the in-flight flag once the parent settles (success advances the step; failure
  // surfaces a toast and `busy` drops). Keeps the "Creating vault" spinner keyed on a state
  // that's set synchronously on submit — see the submit handler.
  React.useEffect(() => {
    if (!busy) setSubmitted(false);
  }, [busy]);

  const strength = scorePassword(password);
  const chunks = React.useMemo(
    () => (recoveryKey ?? "").replace(/[^A-Za-z0-9]/g, "").match(/.{1,4}/g) ?? [],
    [recoveryKey],
  );

  const download = () => {
    if (!recoveryKey) return;
    // A formatted artifact (verbatim key + context + timestamp), not a bare dump. The
    // verbatim `recoveryKey` is the authoritative line so it can be pasted back exactly.
    const body = [
      "arc — recovery key",
      "",
      "This key is the only way back into your vault if you ever forget your",
      "master password. arc is zero-knowledge — we cannot recover it for you.",
      "",
      "RECOVERY KEY",
      recoveryKey,
      "",
      `Generated: ${new Date().toLocaleString()}`,
      "",
      "Keep this file offline and somewhere safe. Anyone with this key plus access",
      "to your account can unlock your vault. Don't email it or store it in another",
      "password manager.",
      "",
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "arc-recovery-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  // A dedicated, branded print sheet — honeycomb mark + the chunked key + a generation
  // timestamp + title/description/warning — instead of printing the live React component.
  // Built entirely client-side from the key already in memory; nothing is sent anywhere.
  const printRecoveryKey = () => {
    if (!recoveryKey || chunks.length === 0) return;
    const win = window.open("", "_blank", "width=760,height=960");
    if (!win) return; // popup blocked — Copy / Download remain available
    const origin = window.location.origin;
    const mark = `${origin}/arc-honeycomb.svg`;
    const generated = new Date().toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
    const cells = chunks.map((c) => `<span class="cell">${c}</span>`).join("");
    win.document.write(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>arc · recovery key</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; color: #0C0F16; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  .sheet { max-width: 560px; margin: 0 auto; padding: 56px 48px; }
  .head { display: flex; align-items: center; gap: 14px; padding-bottom: 26px; border-bottom: 1px solid #E6E8EC; }
  .mark { width: 50px; height: 50px; flex: none; display: inline-block; background: #14AE9B;
    -webkit-mask: url("${mark}") center / contain no-repeat; mask: url("${mark}") center / contain no-repeat; }
  .brand { display: flex; flex-direction: column; line-height: 1.1; }
  .word { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .kicker { font-size: 11px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #14AE9B; margin-top: 4px; }
  h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin: 32px 0 10px; }
  .lede { font-size: 14px; color: #4A5160; margin: 0 0 24px; max-width: 48ch; }
  .keybox { border: 1px solid #E6E8EC; border-radius: 12px; background: #F6F7F9; padding: 18px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .cell { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 16px; font-weight: 600;
    letter-spacing: 0.08em; text-align: center; padding: 12px 4px; background: #fff; border: 1px solid #E6E8EC; border-radius: 8px; color: #0C0F16; }
  .meta { font-size: 12px; color: #6B7280; margin: 14px 2px 0; }
  .note { margin: 28px 0 0; padding: 16px 18px; border: 1px solid #F0D9A8; background: #FBF4E4; border-radius: 10px; font-size: 13px; color: #5C4A1E; }
  .note strong { display: block; margin-bottom: 4px; color: #3F3413; }
  .foot { margin-top: 38px; padding-top: 18px; border-top: 1px solid #E6E8EC; font-size: 12px; color: #9AA1AD; }
  @page { margin: 16mm; }
  @media print { .sheet { padding: 8px 4px; } }
</style>
</head>
<body>
  <main class="sheet">
    <header class="head">
      <span class="mark" aria-hidden="true"></span>
      <span class="brand"><span class="word">arc</span><span class="kicker">recovery key</span></span>
    </header>
    <h1>Your arc recovery key</h1>
    <p class="lede">This key is the only way back into your vault if you ever forget your master password. arc is zero-knowledge, so we can't recover it for you — this sheet is your backup.</p>
    <section class="keybox" aria-label="recovery key"><div class="grid">${cells}</div></section>
    <p class="meta">Generated ${generated}</p>
    <section class="note"><strong>Keep this sheet offline and somewhere safe.</strong>Anyone who has this key and access to your account can unlock your vault. Don't photograph it, email it, or store it in another password manager.</section>
    <footer class="foot">arc — one key, held only by you.</footer>
  </main>
  <script>
    (function () {
      var done = false;
      function go() { if (done) return; done = true; try { window.focus(); } catch (e) {} window.print(); }
      var img = new Image();
      img.onload = go; img.onerror = go; img.src = ${JSON.stringify(mark)};
      setTimeout(go, 800);
      window.onafterprint = function () { window.close(); };
    })();
  <\/script>
</body>
</html>`);
    win.document.close();
  };

  const stepIndex = step === "password" ? 0 : step === "recovery" ? 1 : 2;

  return (
    <div className="grid min-h-[100dvh] md:grid-cols-[1.05fr_1fr]">
      <BrandPanel variant="enroll" />
      <div className="bg-arc-mesh relative flex items-center">
        <div className="mx-auto flex w-full max-w-md flex-col gap-7 px-6 py-12 sm:py-16">
          {/* progress dots — persist across steps; only the active dot animates */}
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

          {/* One pane present at a time; `mode="wait"` lets the old step slide out before the
              next slides in, so the ceremony reads as moving page-to-page. */}
          <AnimatePresence mode="wait" initial>
            <motion.div
              key={step}
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: DUR.base, ease: EASE.outQuart }}
            >
              {step === "password" ? (
                <form
                  className="flex flex-col gap-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!password || submitted) return;
                    setSubmitted(true);
                    // Two frames before the heavy work: the first paints the "Creating vault"
                    // spinner (driven by `submitted`, set synchronously above), the second runs
                    // onEnroll — whose `enroll()` hits Argon2id *synchronously*. A single frame
                    // isn't enough; that block would swallow the spinner's first paint.
                    requestAnimationFrame(() => requestAnimationFrame(() => onEnroll(password)));
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

                  <Button size="lg" type="submit" className="mt-1 w-full" disabled={busy || submitted || !password}>
                    {submitted ? (
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
              ) : step === "recovery" ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <h1 className="text-3xl font-semibold tracking-tight">Save your recovery key</h1>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      If you ever forget your master password, this key is the{" "}
                      <strong className="text-foreground">only</strong> way back in. We&apos;ll show it once.
                    </p>
                  </div>

                  {/* Chips cascade in just after the pane settles. */}
                  <Stagger className="grid grid-cols-4 gap-2" stagger={0.035} delayChildren={0.12}>
                    {chunks.map((c, i) => (
                      <Stagger.Item
                        key={i}
                        className="rounded-md border border-input bg-[var(--surface-inset)] px-1 py-2.5 text-center font-mono text-sm tracking-[0.04em]"
                      >
                        {c}
                      </Stagger.Item>
                    ))}
                  </Stagger>

                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={copyKey}>
                      <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
                        <AnimatePresence mode="wait" initial={false}>
                          {copied ? (
                            <motion.span
                              key="copied"
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={SPRING_SNAPPY}
                              className="absolute inset-0 flex items-center justify-center"
                            >
                              <Check className="h-3.5 w-3.5 text-emerald-500" />
                            </motion.span>
                          ) : (
                            <motion.span
                              key="copy"
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={SPRING_SNAPPY}
                              className="absolute inset-0 flex items-center justify-center"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </span>
                      {copied ? "Copied" : "Copy"}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={printRecoveryKey}>
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
              ) : (
                <div className="flex flex-col gap-4">
                  {/* "All set" — the badge springs in, then the check lands a beat later. */}
                  <motion.span
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ ...SPRING_SOFT, delay: 0.08 }}
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--success-subtle)] text-[var(--success)]"
                  >
                    <motion.span
                      initial={{ scale: 0.4, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ ...SPRING_SNAPPY, delay: 0.22 }}
                    >
                      <Check className="h-6 w-6" strokeWidth={2.5} />
                    </motion.span>
                  </motion.span>
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
              )}
            </motion.div>
          </AnimatePresence>
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
