"use client";

import * as React from "react";
import { ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const ROLES = ["viewer", "editor", "admin"] as const;
type Role = (typeof ROLES)[number];

export interface IdentityLookup {
  identityPublicKey: string;
  fingerprint: string;
}

export function ShareDialog({
  onLookup,
  onShare,
}: {
  onLookup: (userId: number) => Promise<IdentityLookup>;
  onShare: (userId: number, role: Role, identityPubB64: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [userId, setUserId] = React.useState("");
  const [role, setRole] = React.useState<Role>("viewer");
  const [found, setFound] = React.useState<IdentityLookup | null>(null);
  const [busy, setBusy] = React.useState(false);

  const reset = () => {
    setUserId("");
    setRole("viewer");
    setFound(null);
  };

  const lookup = async () => {
    setBusy(true);
    try {
      setFound(await onLookup(Number(userId)));
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!found) return;
    setBusy(true);
    try {
      await onShare(Number(userId), role, found.identityPublicKey);
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
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <UserPlus className="h-4 w-4" /> Share
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this vault</DialogTitle>
          <DialogDescription>
            The vault key is wrapped to the member&apos;s identity key in your browser — the
            server only relays ciphertext.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="memberId">Member user ID</Label>
            <div className="flex gap-2">
              <Input
                id="memberId"
                inputMode="numeric"
                value={userId}
                onChange={(e) => {
                  setUserId(e.target.value);
                  setFound(null);
                }}
              />
              <Button variant="outline" onClick={lookup} disabled={busy || !userId}>
                Look up
              </Button>
            </div>
          </div>

          {found && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <ShieldCheck className="h-4 w-4 text-primary" /> Verify this fingerprint out of band
              </div>
              <code className="break-all text-xs text-muted-foreground">{found.fingerprint}</code>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>Role</Label>
            <div className="grid grid-cols-3 gap-2">
              {ROLES.map((r) => (
                <Button
                  key={r}
                  variant={role === r ? "default" : "outline"}
                  size="sm"
                  className={cn("capitalize")}
                  onClick={() => setRole(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={share} disabled={busy || !found}>
            Grant access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
