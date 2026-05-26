"use client";

import * as React from "react";
import { RotateCw, Users } from "lucide-react";
import type { VaultMember } from "@arc-vault/sdk";
import { Badge } from "@/components/ui/badge";
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

export function MembersDialog({
  canManage,
  onLoad,
  onRotate,
}: {
  canManage: boolean;
  onLoad: () => Promise<VaultMember[]>;
  onRotate: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [members, setMembers] = React.useState<VaultMember[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) onLoad().then(setMembers).catch(() => setMembers([]));
  }, [open, onLoad]);

  const rotate = async () => {
    setBusy(true);
    try {
      await onRotate();
      setMembers(await onLoad());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Users className="h-4 w-4" /> Members
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vault members</DialogTitle>
          <DialogDescription>Who can decrypt this vault.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          {members.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No members loaded.</p>
          ) : (
            members.map((m) => (
              <div key={m.userId} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>User #{m.userId}</span>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {m.role}
                  </Badge>
                  <Badge variant="outline" className="capitalize">
                    {m.status}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </div>
        {canManage && (
          <DialogFooter className="sm:justify-between">
            <p className="self-center text-xs text-muted-foreground">
              Rotation re-wraps item keys and re-grants current members.
            </p>
            <Button variant="outline" onClick={rotate} disabled={busy}>
              <RotateCw className="h-4 w-4" /> Rotate key
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
