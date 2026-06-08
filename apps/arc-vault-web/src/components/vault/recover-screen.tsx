"use client";

import * as React from "react";
import { ArrowLeft, KeyRound, Loader2, LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Dedicated master-password recovery screen (ADR-006). Recovery is a rare, high-stakes,
 * multi-step break-glass flow, so it lives on its own screen reached from the unlock
 * screen's "Forgot your master password?" link — not inline in the unlock hot path.
 *
 * The user pastes their recovery key and chooses a new master password. On success the
 * caller drives the SDK (`recoverWithKey`) and shows the *new* recovery key via
 * `RecoveryKeyCard`, then unlocks. Everything is processed on-device — the recovery key and
 * the new password never leave the client in the clear.
 */
export function RecoverScreen({
  busy,
  onRecover,
  onBack,
}: {
  busy: boolean;
  onRecover: (recoveryKey: string, newPassword: string) => void;
  onBack: () => void;
}) {
  const [recoveryKey, setRecoveryKey] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");

  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = recoveryKey.trim().length > 0 && password.length >= 8 && password === confirm;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <LifeBuoy className="h-5 w-5 text-primary" />
          </div>
          <CardTitle className="text-xl">Recover your vault</CardTitle>
          <CardDescription>
            Enter your recovery key and choose a new master password. This restores access
            without changing your identity — all your vaults and shares stay intact. Your old
            master password will no longer work.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="recoveryKey">Recovery key</Label>
            <Input
              id="recoveryKey"
              placeholder="XXXX-XXXX-XXXX-…"
              autoComplete="off"
              spellCheck={false}
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="newpw">New master password</Label>
            <Input
              id="newpw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="confirmpw">Confirm new master password</Label>
            <Input
              id="confirmpw"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready) onRecover(recoveryKey.trim(), password);
              }}
            />
            {mismatch && <p className="text-xs text-destructive">Passwords don&apos;t match.</p>}
          </div>
        </CardContent>

        <CardFooter className="flex-col gap-2">
          <Button
            className="w-full"
            disabled={busy || !ready}
            onClick={() => onRecover(recoveryKey.trim(), password)}
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Recovering…
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4" /> Recover &amp; set new password
              </>
            )}
          </Button>
          <Button variant="ghost" className="w-full" disabled={busy} onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Back to unlock
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
