"use client";

import * as React from "react";
import { Fingerprint, KeyRound, Loader2, LogIn, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Reveal } from "@/components/motion/reveal";
import { Stagger } from "@/components/motion/stagger";
import { ArcMark } from "@/components/brand/arc-mark";
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
  const [pending, setPending] = React.useState<Action | null>(null);
  React.useEffect(() => {
    if (!busy) setPending(null);
  }, [busy]);
  const run = (action: Action, fn: () => void) => {
    setPending(action);
    fn();
  };
  const spin = (action: Action) => busy && pending === action;

  const view: "signin" | "unlock" = phase === "login" ? "signin" : "unlock";

  const COPY = {
    signin: { title: "Sign in to arc", lede: "Sign-in authorizes sync only. Your vault stays locked until you supply the master password on this device." },
    unlock: { title: "Welcome back", lede: "Your master password is processed on this device and never sent. The server only sees ciphertext." },
  }[view];

  return (
    <div className="grid min-h-[calc(100dvh-3.5rem)] md:grid-cols-[1.05fr_1fr]">
      <BrandPanel />
      <div className="bg-arc-mesh relative flex items-center">
        <div className="mx-auto flex w-full max-w-md flex-col gap-8 px-6 py-12 sm:py-16">
          <Stagger stagger={0.06} className="flex flex-col gap-6">
            <Stagger.Item>
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/20">
                <ArcMark className="h-6 w-6" />
              </div>
            </Stagger.Item>
            <Stagger.Item className="flex flex-col gap-2">
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{COPY.title}</h1>
              <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{COPY.lede}</p>
            </Stagger.Item>
          </Stagger>

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
                <Button size="lg" type="submit" className="mt-1 w-full" disabled={busy || !email}>
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
                  <Button size="lg" type="submit" className="w-full" disabled={busy || !password}>
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
                      disabled={busy}
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

                <div className="mt-2 flex flex-col gap-1 border-t pt-3 text-sm">
                  {onForgotPassword ? (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto justify-start px-2 py-1.5 text-xs text-muted-foreground"
                      disabled={busy}
                      onClick={onForgotPassword}
                    >
                      Forgot your master password?
                    </Button>
                  ) : null}
                  {onNewDevice ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto justify-start px-2 py-1.5 text-muted-foreground hover:text-foreground"
                      disabled={busy}
                      onClick={onNewDevice}
                    >
                      Set up as a new device
                    </Button>
                  ) : null}
                </div>

                <SwitchPrompt
                  prompt="New to arc?"
                  action="Create a vault"
                  icon={<UserPlus className="h-3.5 w-3.5" />}
                  disabled={busy}
                  onClick={onStartEnroll}
                />
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

function SwitchPrompt({
  prompt,
  action,
  icon,
  onClick,
  disabled,
}: {
  prompt: string;
  action: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-center gap-1.5 border-t pt-4 text-sm text-muted-foreground">
      <span>{prompt}</span>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50"
      >
        {icon}
        {action}
      </button>
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
