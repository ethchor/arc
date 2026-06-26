"use client";

import * as React from "react";
import { Loader2, ShieldCheck } from "lucide-react";
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
import { TipTrigger, type TipProps } from "@/components/ui/tooltip";
import type { IdentityLookup } from "@/components/vault/share-dialog";

type Permission = "view" | "edit";

/** Expiry presets → ms offset (0 = no expiry). */
const EXPIRY_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "Never", days: 0 },
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

/**
 * Share a **single item** with one user (ADR-007) — they decrypt only that item, never become
 * a vault member, and never receive the vault key. Same email→identity lookup as the vault
 * share dialog; the item key is `pqSeal`'d to the recipient in the browser, server only relays
 * ciphertext. `edit` lets the grantee propose write-backs; an optional TTL auto-expires the
 * share.
 */
export function ShareItemDialog({
  onLookup,
  onShare,
  trigger,
  tooltip,
}: {
  onLookup: (email: string) => Promise<IdentityLookup>;
  onShare: (userId: number, permission: Permission, expiresAtMs?: number) => Promise<void>;
  trigger: React.ReactNode;
  tooltip?: TipProps;
}) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [permission, setPermission] = React.useState<Permission>("view");
  const [expiryDays, setExpiryDays] = React.useState(0);
  const [found, setFound] = React.useState<IdentityLookup | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = () => {
    setEmail("");
    setPermission("view");
    setExpiryDays(0);
    setFound(null);
    setError(null);
  };

  const lookup = async () => {
    setBusy(true);
    setError(null);
    try {
      setFound(await onLookup(email.trim()));
    } catch (err) {
      setFound(null);
      setError(
        (err as Error)?.message?.includes("404")
          ? "No user with that email — they need to sign in once first."
          : ((err as Error)?.message ?? "Lookup failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!found) return;
    setBusy(true);
    try {
      const expiresAtMs = expiryDays > 0 ? Date.now() + expiryDays * 86_400_000 : undefined;
      await onShare(found.userId, permission, expiresAtMs);
      setOpen(false);
      reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <TipTrigger tip={tooltip}>{trigger}</TipTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this item</DialogTitle>
          <DialogDescription>
            Shares only this one item — the recipient never gets the vault key. The item key is
            wrapped to their identity in your browser; the server only relays ciphertext.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="shareItemEmail">Recipient email</Label>
            <div className="flex gap-2">
              <Input
                id="shareItemEmail"
                type="email"
                placeholder="alice@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFound(null);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && email.trim() && !busy) lookup();
                }}
              />
              <Button variant="outline" onClick={lookup} disabled={busy || !email.trim()}>
                {busy && !found ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Looking…
                  </>
                ) : (
                  "Look up"
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              They must have signed in at least once so their identity public key is published.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {found && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <ShieldCheck className="h-4 w-4 text-primary" /> Verify this fingerprint out of band
              </div>
              <code className="break-all text-xs text-muted-foreground">{found.fingerprint}</code>
              <div className="mt-2 text-xs text-muted-foreground">User #{found.userId}</div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>Permission</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["view", "edit"] as const).map((p) => (
                <Button
                  key={p}
                  variant={permission === p ? "default" : "outline"}
                  size="sm"
                  className="capitalize"
                  onClick={() => setPermission(p)}
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Expires</Label>
            <div className="grid grid-cols-4 gap-2">
              {EXPIRY_OPTIONS.map((o) => (
                <Button
                  key={o.days}
                  variant={expiryDays === o.days ? "default" : "outline"}
                  size="sm"
                  onClick={() => setExpiryDays(o.days)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={share} disabled={busy || !found}>
            {busy && found ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Sharing…
              </>
            ) : (
              "Share item"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
