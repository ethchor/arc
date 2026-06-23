"use client";

import { Check, Minus, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const ROLES = ["owner", "admin", "editor", "viewer"] as const;
type Role = (typeof ROLES)[number];

const CAPS: { cap: string; roles: Role[] }[] = [
  { cap: "Read & decrypt items", roles: ["owner", "admin", "editor", "viewer"] },
  { cap: "Create / edit items", roles: ["owner", "admin", "editor"] },
  { cap: "Delete items", roles: ["owner", "admin", "editor"] },
  { cap: "Manage folders", roles: ["owner", "admin", "editor"] },
  { cap: "Invite / grant members", roles: ["owner", "admin"] },
  { cap: "Rotate vault key (revoke)", roles: ["owner", "admin"] },
  { cap: "Delete vault", roles: ["owner"] },
];

export function PoliciesView({ role }: { role?: string }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Govern · policies
        </span>
        <h1 className="font-display text-2xl font-medium tracking-tight">Policies</h1>
        <p className="flex max-w-prose flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Role-based capabilities for this vault. Your role:
          <Badge variant="secondary" className="capitalize">
            {role ?? "—"}
          </Badge>
        </p>
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Capability</th>
                {ROLES.map((r) => (
                  <th
                    key={r}
                    className={cn(
                      "px-3 py-2 text-center font-medium capitalize",
                      r === role && "text-primary",
                    )}
                  >
                    {r}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPS.map(({ cap, roles }) => (
                <tr key={cap} className="border-b last:border-0">
                  <td className="px-4 py-2">{cap}</td>
                  {ROLES.map((r) => (
                    <td key={r} className="px-3 py-2 text-center">
                      {roles.includes(r) ? (
                        <Check className="mx-auto h-4 w-4 text-emerald-500" />
                      ) : (
                        <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <div className="flex gap-2 rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500" />
        <p className="text-muted-foreground">
          Write, invite, and management actions are <strong>server-enforced</strong> by role. Read
          access is <strong>cryptographic</strong>: any member holding the vault key can decrypt
          items, so revoking read access requires a key rotation (Access &rsaquo; Rotate key), not
          just a role change.
        </p>
      </div>
    </div>
  );
}
