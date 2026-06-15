"use client";

import * as React from "react";
import { Fingerprint, KeyRound, Loader2, LogIn } from "lucide-react";
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
  onEnroll: (password: string) => void;
  onNewDevice?: () => void;
  /**
   * Optional. When present, the unlock screen shows a "Use a passkey" button under the
   * Unlock action. Triggers a WebAuthn assertion via the SDK's browser authenticator;
   * the caller drives the SDK + state transition. UI doesn't gate by browser feature
   * detection (failure surfaces a toast), so users on Chrome/Safari see the affordance
   * even when no passkey is registered yet (server returns 404 → friendly toast).
   */
  onPasskeyUnlock?: () => void;
  /**
   * Optional. When present, the unlock screen shows a low-emphasis "Forgot your master
   * password?" link that routes to the dedicated recovery screen (ADR-006). Recovery is a
   * rare, multi-step break-glass flow, so it gets its own screen rather than living inline.
   */
  onForgotPassword?: () => void;
}

export function UnlockScreen({
  phase,
  busy,
  onSignIn,
  onUnlock,
  onEnroll,
  onNewDevice,
  onPasskeyUnlock,
  onForgotPassword,
}: Props) {
  const [baseUrl, setBaseUrl] = React.useState("http://localhost:3001");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  // Which action is in flight. `busy` is a single shared flag from the parent's guard(),
  // so without this every button would show its own spinner at once. We track the clicked
  // action and only spin that one; all buttons still disable while busy.
  type Action = "signin" | "unlock" | "passkey" | "enroll" | "newDevice";
  const [pending, setPending] = React.useState<Action | null>(null);

  // Reset once the parent finishes (busy → false), so the next click starts clean.
  React.useEffect(() => {
    if (!busy) setPending(null);
  }, [busy]);

  const run = (action: Action, fn: () => void) => {
    setPending(action);
    fn();
  };
  const spin = (action: Action) => busy && pending === action;

  const heading = phase === "login" ? "Sign in to arc" : "Unlock your vault";
  const lede =
    phase === "login"
      ? "Sign-in authorizes sync only. Your vault stays locked until you supply the master password on this device."
      : "Your master password is processed on this device and never sent. The server only sees ciphertext.";

  return (
    <div className="grid min-h-[calc(100dvh-3.5rem)] lg:grid-cols-[1.05fr_1fr]">
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
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{heading}</h1>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{lede}</p>
          </Stagger.Item>
        </Stagger>

        <Reveal variant="fade-up" offset={8} delay={0.18}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (phase === "login" && email) run("signin", () => onSignIn(baseUrl, email));
              if (phase === "account" && password) run("unlock", () => onUnlock(password));
            }}
          >
            {phase === "login" ? (
              <>
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
                  />
                </Field>
                <Button size="lg" type="submit" className="mt-1 w-full" disabled={busy || !email}>
                  {spin("signin") ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                  {spin("signin") ? "Signing in" : "Continue"}
                </Button>
              </>
            ) : (
              <>
                <Field id="password" label="Master password" hint="Processed on this device only.">
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
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

                  {onPasskeyUnlock && (
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
                  )}
                </div>

                <div className="mt-3 flex flex-col gap-1 border-t pt-3 text-sm">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto justify-start px-2 py-1.5 text-muted-foreground hover:text-foreground"
                    disabled={busy || !password}
                    onClick={() => run("enroll", () => onEnroll(password))}
                  >
                    {spin("enroll") ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Creating vault
                      </>
                    ) : (
                      "Create a new vault with this password"
                    )}
                  </Button>
                  {onNewDevice && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto justify-start px-2 py-1.5 text-muted-foreground hover:text-foreground"
                      disabled={busy}
                      onClick={onNewDevice}
                    >
                      Set up as a new device
                    </Button>
                  )}
                  {onForgotPassword && (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto justify-start px-2 py-1.5 text-xs text-muted-foreground"
                      disabled={busy}
                      onClick={onForgotPassword}
                    >
                      Forgot your master password?
                    </Button>
                  )}
                </div>
              </>
            )}
          </form>
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
