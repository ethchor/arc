"use client";

import * as React from "react";
import type { ReactNode } from "react";
import { Fingerprint } from "lucide-react";
import type { VaultMember } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RoleBadge } from "@/components/arc/role-badge";

export function AccessView({
  vaultId,
  loadMembers,
  actions,
  onRevoke,
  currentUserId,
}: {
  vaultId: string;
  loadMembers: () => Promise<VaultMember[]>;
  actions?: ReactNode;
  /** Revoke a member's access (re-keys the vault). Omit to hide the per-row revoke action. */
  onRevoke?: (userId: number) => Promise<void>;
  /** The signed-in user — never offered a "revoke" button against their own row. */
  currentUserId?: number;
}) {
  const [members, setMembers] = React.useState<VaultMember[]>([]);
  const [confirming, setConfirming] = React.useState<number | null>(null);
  const [revoking, setRevoking] = React.useState<number | null>(null);

  const reload = React.useCallback(() => {
    loadMembers()
      .then(setMembers)
      .catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  React.useEffect(() => {
    let live = true;
    loadMembers()
      .then((m) => live && setMembers(m))
      .catch(() => live && setMembers([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  const doRevoke = async (userId: number) => {
    if (!onRevoke) return;
    setRevoking(userId);
    try {
      await onRevoke(userId);
      setConfirming(null);
      reload();
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Access</h1>
          <p className="text-sm text-muted-foreground">Identities that can decrypt this vault.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Members ({members.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {members.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No members.</p>
          ) : (
            members.map((m) => {
              const canRevoke =
                !!onRevoke && m.status === "active" && m.userId !== currentUserId;
              return (
                <div
                  key={m.userId}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Fingerprint className="h-4 w-4 text-muted-foreground" /> User #{m.userId}
                  </span>
                  <span className="flex items-center gap-2">
                    <RoleBadge role={m.role} />
                    <Badge variant="outline" className="capitalize">
                      {m.status}
                    </Badge>
                    {canRevoke &&
                      (confirming === m.userId ? (
                        <span className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={revoking === m.userId}
                            onClick={() => doRevoke(m.userId)}
                          >
                            {revoking === m.userId ? "Revoking…" : "Confirm revoke"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={revoking === m.userId}
                            onClick={() => setConfirming(null)}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(m.userId)}>
                          Revoke
                        </Button>
                      ))}
                  </span>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
