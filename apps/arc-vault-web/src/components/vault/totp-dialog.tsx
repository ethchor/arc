"use client";

import * as React from "react";
import { parseOtpauthUri } from "@arc/crypto";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface TotpInput {
  key: string;
  secret: string;
  issuer: string;
  account: string;
}

const EMPTY: TotpInput = { key: "", secret: "", issuer: "", account: "" };

/**
 * If the user pastes an `otpauth://` URI into the secret field, parse it and auto-fill
 * the issuer / account / name. Falls back to the raw paste on any error (the user might
 * be pasting a bare base32 secret).
 */
function maybeApplyOtpauth(prev: TotpInput, pasted: string): TotpInput {
  if (!pasted.startsWith("otpauth://")) return { ...prev, secret: pasted };
  try {
    const f = parseOtpauthUri(pasted);
    return {
      key: prev.key || f.account || f.issuer || "TOTP",
      secret: f.secret,
      issuer: f.issuer ?? prev.issuer,
      account: f.account ?? prev.account,
    };
  } catch {
    return { ...prev, secret: pasted };
  }
}

export function TotpDialog({
  trigger,
  initial,
  heading = "Add TOTP",
  folders = [],
  initialFolderId = null,
  onSubmit,
}: {
  trigger: React.ReactNode;
  initial?: TotpInput;
  heading?: string;
  folders?: Array<{ id: string; name: string }>;
  initialFolderId?: string | null;
  onSubmit: (value: TotpInput, folderId: string | null) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<TotpInput>(initial ?? EMPTY);
  const [folderId, setFolderId] = React.useState<string | null>(initialFolderId);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(initial ?? EMPTY);
      setFolderId(initialFolderId);
    }
  }, [open, initial, initialFolderId]);

  const set = (k: keyof TotpInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(form, folderId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            The TOTP secret is encrypted on this device before the server sees it. Codes
            are generated locally — paste from the QR-setup screen or copy the base32 from
            your existing vault.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="totp-key">Name</Label>
            <Input
              id="totp-key"
              placeholder="github-mfa"
              value={form.key}
              onChange={set("key")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="totp-secret">Secret (base32 or otpauth:// URI)</Label>
            <Input
              id="totp-secret"
              className="font-mono"
              placeholder="JBSWY3DPEHPK3PXP — or paste otpauth://totp/..."
              value={form.secret}
              onChange={(e) => setForm((f) => maybeApplyOtpauth(f, e.target.value))}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Paste the full <code>otpauth://</code> URI from your existing app and we'll
              fill the rest of the fields for you.
            </p>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="totp-issuer">Issuer</Label>
              <Input
                id="totp-issuer"
                placeholder="GitHub"
                value={form.issuer}
                onChange={set("issuer")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="totp-account">Account</Label>
              <Input
                id="totp-account"
                placeholder="user@example.com"
                value={form.account}
                onChange={set("account")}
              />
            </div>
          </div>
          {folders.length > 0 && (
            <div className="grid gap-1.5">
              <Label>Folder</Label>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant={folderId === null ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFolderId(null)}
                >
                  None
                </Button>
                {folders.map((f) => (
                  <Button
                    key={f.id}
                    type="button"
                    variant={folderId === f.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFolderId(f.id)}
                  >
                    {f.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !form.key || !form.secret}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
