"use client";

import * as React from "react";
import type { PulledItem } from "@arc/sdk";
import { Check, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrength } from "@/components/arc/password-strength";
import { asLogin, itemTitle } from "@/lib/items";
import { generatePassword } from "@/lib/password";
import { passwordStrength } from "@/lib/security";

/**
 * Fix-weak wizard. Walks a queue of flagged login items one step at a time, each pre-filled
 * with a freshly generated strong password (which the user can regenerate or edit). "Save &
 * next" rotates the password through the vault's existing save path; "Skip" advances without
 * touching it. It reuses `generatePassword` + the strength meter so the fast path matches the
 * full editor, and adds no new write surface — `onSave` is the vault's normal `saveLogin`.
 */
export function FixWeakWizard({
  open,
  onOpenChange,
  queue,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queue: PulledItem[];
  onSave: (item: PulledItem, newPassword: string) => Promise<void>;
}) {
  const [index, setIndex] = React.useState(0);
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [fixed, setFixed] = React.useState(0);
  const [skipped, setSkipped] = React.useState(0);

  // Reset the run whenever the wizard (re)opens.
  React.useEffect(() => {
    if (open) {
      setIndex(0);
      setFixed(0);
      setSkipped(0);
    }
  }, [open]);

  const total = queue.length;
  const current = queue[index];
  const login = current ? asLogin(current) : null;
  const done = index >= total;

  // Fresh strong password each time we land on a new item.
  React.useEffect(() => {
    if (open && current) setPassword(generatePassword());
  }, [open, current?.id]);

  const saveNext = async () => {
    if (!current || !password) return;
    setBusy(true);
    try {
      await onSave(current, password);
      setFixed((n) => n + 1);
      setIndex((i) => i + 1);
    } finally {
      setBusy(false);
    }
  };

  const skip = () => {
    setSkipped((n) => n + 1);
    setIndex((i) => i + 1);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--success-subtle)] text-[var(--success-fg)]">
                  <Check className="h-4 w-4" strokeWidth={2.5} />
                </span>
                All caught up
              </DialogTitle>
              <DialogDescription>
                Rotated {fixed} {fixed === 1 ? "password" : "passwords"}
                {skipped ? `, skipped ${skipped}` : ""}. New passwords were encrypted on this device
                before saving.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Fix weak passwords</DialogTitle>
              <DialogDescription>
                Step {index + 1} of {total} — a strong, unique password is generated for each.
                Encrypted on this device before it’s saved.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-3.5 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border bg-[var(--surface-raised)] font-mono text-sm font-semibold">
                  {current ? itemTitle(current).slice(0, 1).toUpperCase() : "·"}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{current ? itemTitle(current) : ""}</div>
                  <div className="truncate text-xs text-muted-foreground">{login?.fields.username || "—"}</div>
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="fix-pw">New password</Label>
                <div className="flex gap-2">
                  <Input
                    id="fix-pw"
                    className="font-mono"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Generate another password"
                    onClick={() => setPassword(generatePassword())}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
                <PasswordStrength score={passwordStrength(password)} />
              </div>
            </div>

            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" onClick={skip} disabled={busy}>
                Skip
              </Button>
              <Button onClick={saveNext} disabled={busy || !password}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {index + 1 < total ? "Save & next" : "Save & finish"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
