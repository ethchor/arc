"use client";

import * as React from "react";
import { Loader2, ShieldCheck, UserPlus } from "lucide-react";
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
  /** Resolved arc user id — set by the email lookup, used in the grant call. */
  userId: number;
  identityPublicKey: string;
  identityPublicKeyMlkem: string;
  fingerprint: string;
}

/**
 * Share-vault dialog. Member lookup is by email (the address the member signed in with);
 * the dialog calls onLookup which hits `/vault/users/by-email/<email>` server-side and
 * returns the resolved {userId, identity public keys, fingerprint}. The owner verifies
 * the fingerprint out of band, picks a role, and grants — the VK gets sealed to the
 * member's hybrid identity key in the owner's browser (server only relays ciphertext).
 *
 * Previously this asked for a raw integer "Member user ID" which was a UX dead-end —
 * arc never surfaces that id anywhere in the UI. Email is what the user knows.
 */
export function ShareDialog({
  onLookup,
  onShare,
}: {
  onLookup: (email: string) => Promise<IdentityLookup>;
  onShare: (
    userId: number,
    role: Role,
    identity: { identityPubB64: string; identityPubMlkemB64: string },
  ) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("viewer");
  const [found, setFound] = React.useState<IdentityLookup | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = () => {
    setEmail("");
    setRole("viewer");
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
          ? "No user with that email — they need to sign in once before being added."
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
      await onShare(found.userId, role, {
        identityPubB64: found.identityPublicKey,
        identityPubMlkemB64: found.identityPublicKeyMlkem,
      });
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
            <Label htmlFor="memberEmail">Member email</Label>
            <div className="flex gap-2">
              <Input
                id="memberEmail"
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
              The member must have signed in at least once so their identity public key is
              published.
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
            {busy && found ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Granting…
              </>
            ) : (
              "Grant access"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
