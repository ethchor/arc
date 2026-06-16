"use client";

import * as React from "react";
import { Fingerprint, KeyRound, Loader2, LogIn, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Reveal } from "@/components/motion/reveal";
import { BrandPanel } from "@/components/brand/brand-panel";

interface Props {
  phase: "login" | "account";
  busy: boolean;
  onSignIn: (baseUrl: string, email: string) => void;
  onUnlock: (password: string) => void;
  /** Navigate to the dedicated enrollment ceremony (EnrollScreen). */
  onStartEnroll: () => void;
  onNewDevice?: () => void;
  /**
   * Optional. When present, the unlock view shows a "Use a passkey" button. Triggers a
   * WebAuthn assertion via the SDK's browser authenticator; the caller drives the SDK +
   * state transition. UI doesn't gate by feature detection (failure surfaces a toast).
   */
  onPasskeyUnlock?: () => void;
  /**
   * Optional. When present, the unlock view shows a low-emphasis "Forgot your master
   * password?" link that routes to the dedicated recovery screen (ADR-006).
   */
  onForgotPassword?: () => void;
}

type Action = "signin" | "unlock" | "passkey" | "enroll" | "newDevice";

/**
 * Onboarding / unlock surface — a split screen (brand panel left, form right) matching the
 * arc design system. After sign-in (sync auth), the form has two distinct, separate views
 * that link to each other:
 *   - "unlock"  — Welcome back: master password / passkey / recovery for an existing vault.
 *   - "enroll"  — Create your arc vault: set a master password for a brand-new vault.
 * Every underlying callback (onSignIn / onUnlock / onEnroll / onPasskeyUnlock) is unchanged.
 */
export function UnlockScreen({
  phase,
  busy,
  onSignIn,
  onUnlock,
  onStartEnroll,
  onNewDevice,
  onPasskeyUnlock,
  onForgotPassword,
}: Props) {
  const [baseUrl, setBaseUrl] = React.useState("http://localhost:3001");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  // Track the in-flight action so only the clicked button spins (busy is a shared flag).
  // The spinner keys off `pending` — set synchronously on click — not the parent's `busy`,
  // which only flips inside the async handler. That makes loading visible the instant you
  // click, even for fast-failing requests (e.g. an un-enrolled account 404). `pending` is
  // cleared when the action settles (busy → false).
  const [pending, setPending] = React.useState<Action | null>(null);
  React.useEffect(() => {
    if (!busy) setPending(null);
  }, [busy]);
  const run = (action: Action, fn: () => void) => {
    if (pending) return; // one action at a time; ignore re-entry within the defer window
    setPending(action);
    // Two frames: the first lets React paint the spinner (driven by `pending`), the second
    // runs the work. A single frame isn't enough — `enroll()`/`unlock()` can hit Argon2id
    // synchronously, and that block would swallow the spinner's first paint.
    requestAnimationFrame(() => requestAnimationFrame(() => fn()));
  };
  const spin = (action: Action) => pending === action;
  const inFlight = busy || pending !== null;

  const view: "signin" | "unlock" = phase === "login" ? "signin" : "unlock";

  const COPY = {
    signin: { title: "Sign in to arc", lede: "Sign-in authorizes sync only. Your vault stays locked until you supply the master password on this device." },
    unlock: { title: "Welcome back", lede: "Your master password is processed on this device and never sent. The server only sees ciphertext." },
  }[view];

  return (
    <div className="grid min-h-[100dvh] md:grid-cols-[1.05fr_1fr]">
      <BrandPanel />
      <div className="bg-arc-mesh relative flex items-center">
        <div className="mx-auto flex w-full max-w-md flex-col gap-8 px-6 py-12 sm:py-16">
          <Reveal variant="fade-up" offset={8} className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{COPY.title}</h1>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{COPY.lede}</p>
          </Reveal>

          <Reveal variant="fade-up" offset={8} delay={0.18}>
            {view === "signin" ? (
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (email) run("signin", () => onSignIn(baseUrl, email));
                }}
              >
                <Field id="baseUrl" label="API base URL">
                  <Input id="baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                </Field>
                <Field id="email" label="Email">
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    suppressHydrationWarning
                  />
                </Field>
                <Button size="lg" type="submit" className="mt-1 w-full" disabled={inFlight || !email}>
                  {spin("signin") ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                  {spin("signin") ? "Signing in" : "Continue"}
                </Button>
              </form>
            ) : (
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (password) run("unlock", () => onUnlock(password));
                }}
              >
                <Field id="password" label="Master password" hint="Processed on this device only.">
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    suppressHydrationWarning
                  />
                </Field>

                <div className="mt-1 flex flex-col gap-2">
                  <Button size="lg" type="submit" className="w-full" disabled={inFlight || !password}>
                    {spin("unlock") ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Unlocking
                      </>
                    ) : (
                      <>
                        <KeyRound className="h-4 w-4" /> Unlock
                      </>
                    )}
                  </Button>

                  {onPasskeyUnlock ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      className="w-full"
                      disabled={inFlight}
                      onClick={() => run("passkey", onPasskeyUnlock)}
                    >
                      {spin("passkey") ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> Waiting for passkey
                        </>
                      ) : (
                        <>
                          <Fingerprint className="h-4 w-4" /> Use a passkey
                        </>
                      )}
                    </Button>
                  ) : null}
                </div>

                {/* Secondary actions, one calm tier above the create-a-vault switch.
                    "Forgot" and "Set up as a new device" are equal-weight text links — no
                    full-width ghost slab — so neither visually outranks the other. */}
                <div className="mt-1 flex flex-col gap-3 border-t pt-4">
                  {onForgotPassword || onNewDevice ? (
                    <div className="flex flex-col items-start gap-2 text-xs">
                      {onForgotPassword ? (
                        <button
                          type="button"
                          onClick={onForgotPassword}
                          disabled={inFlight}
                          className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                        >
                          Forgot your master password?
                        </button>
                      ) : null}
                      {onNewDevice ? (
                        <button
                          type="button"
                          onClick={onNewDevice}
                          disabled={inFlight}
                          className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                        >
                          Set up as a new device
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <span>New to arc?</span>
                    <button
                      type="button"
                      onClick={onStartEnroll}
                      disabled={inFlight}
                      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Create a vault
                    </button>
                  </div>
                </div>
              </form>
            )}
          </Reveal>

          <Reveal variant="fade" delay={0.28}>
            <p className="text-xs leading-relaxed text-muted-foreground/80">
              arc is zero-knowledge. Master password, identity keys and vault keys are derived,
              wrapped and unwrapped only on this device. The server only sees ciphertext.
            </p>
          </Reveal>
        </div>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
