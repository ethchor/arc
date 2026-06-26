"use client";

import * as React from "react";
import { Camera, Upload, X } from "lucide-react";
import { parseOtpauthUri } from "@arc/crypto";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TipTrigger, type TipProps } from "@/components/ui/tooltip";
import { decodeQrFromFile } from "@/lib/qr/decode";
import { QrCameraScanner } from "@/components/vault/qr-camera-scanner";

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
  tooltip,
  initial,
  heading = "Add TOTP",
  folders = [],
  initialFolderId = null,
  onSubmit,
}: {
  trigger: React.ReactNode;
  tooltip?: TipProps;
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
  const [scanning, setScanning] = React.useState(false);
  const [qrError, setQrError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setForm(initial ?? EMPTY);
      setFolderId(initialFolderId);
    }
    // Always tear down the camera + clear any decode error on an open/close transition.
    setScanning(false);
    setQrError(null);
  }, [open, initial, initialFolderId]);

  const set = (k: keyof TotpInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  // A decoded QR is just an `otpauth://…` (or bare base32) string — run it through the same
  // parser the paste path uses so issuer/account/name auto-fill identically.
  const applyDecoded = (text: string) => {
    setForm((f) => maybeApplyOtpauth(f, text));
    setQrError(null);
    setScanning(false);
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the user re-pick the same file after a miss
    if (!file) return;
    setQrError(null);
    try {
      const text = await decodeQrFromFile(file);
      if (text) applyDecoded(text);
      else setQrError("No QR code found in that image.");
    } catch {
      setQrError("Couldn't read that image.");
    }
  };

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
      <TipTrigger tip={tooltip}>{trigger}</TipTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            The TOTP secret is encrypted on this device before the server sees it. Codes are
            generated locally — scan or upload the setup QR, paste the <code>otpauth://</code>
            URI, or enter the base32 secret. QR images are decoded on-device, never uploaded.
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
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onPickFile}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" /> Upload QR
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQrError(null);
                  setScanning((s) => !s);
                }}
              >
                {scanning ? (
                  <>
                    <X className="h-3.5 w-3.5" /> Stop camera
                  </>
                ) : (
                  <>
                    <Camera className="h-3.5 w-3.5" /> Scan camera
                  </>
                )}
              </Button>
            </div>
            {qrError ? <p className="text-xs text-destructive">{qrError}</p> : null}
            {scanning ? (
              <QrCameraScanner
                onResult={applyDecoded}
                onError={(m) => {
                  setQrError(m);
                  setScanning(false);
                }}
              />
            ) : null}
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
