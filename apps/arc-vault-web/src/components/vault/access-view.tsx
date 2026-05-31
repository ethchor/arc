"use client";

import * as React from "react";
import type { ReactNode } from "react";
import { Fingerprint } from "lucide-react";
import type { VaultMember } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function AccessView({
  vaultId,
  loadMembers,
  actions,
}: {
  vaultId: string;
  loadMembers: () => Promise<VaultMember[]>;
  actions?: ReactNode;
}) {
  const [members, setMembers] = React.useState<VaultMember[]>([]);

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
            members.map((m) => (
              <div
                key={m.userId}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4 text-muted-foreground" /> User #{m.userId}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {m.role}
                  </Badge>
                  <Badge variant="outline" className="capitalize">
                    {m.status}
                  </Badge>
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
