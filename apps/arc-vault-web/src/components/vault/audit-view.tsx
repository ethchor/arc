"use client";

import * as React from "react";
import { FileClock, RotateCw } from "lucide-react";
import type { AuditEvent } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Map of `action` codes the server writes into the audit log. Adding a new code on the
 * server doesn't break this — the fallback case renders the raw code in monospace.
 */
const ACTION_LABEL: Record<string, string> = {
  vault_created: "Vault created",
  member_added: "Member added",
  item_created: "Item created",
  item_updated: "Item updated",
  item_deleted: "Item deleted",
  folder_created: "Folder created",
  folder_deleted: "Folder deleted",
  vault_key_rotated: "Vault key rotated",
  device_added: "Device added",
  device_approved: "Device approved",
  device_revoked: "Device revoked",
  unlock_failed: "Unlock failed",
};

const ACTION_TONE: Record<string, "neutral" | "warn"> = {
  unlock_failed: "warn",
  device_revoked: "warn",
  item_deleted: "warn",
  vault_key_rotated: "warn",
};

const PAGE = 50;

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AuditView({
  vaultId,
  loadAudit,
}: {
  vaultId: string;
  loadAudit: (opts: { limit: number; before?: string }) => Promise<AuditEvent[]>;
}) {
  const [events, setEvents] = React.useState<AuditEvent[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);

  const fetchPage = React.useCallback(
    async (before?: string) => {
      setBusy(true);
      setError(null);
      try {
        const page = await loadAudit({ limit: PAGE, ...(before ? { before } : {}) });
        setEvents((prev) => (before ? [...prev, ...page] : page));
        setHasMore(page.length === PAGE);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [loadAudit],
  );

  React.useEffect(() => {
    setEvents([]);
    void fetchPage();
  }, [vaultId, fetchPage]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileClock className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Audit log</h2>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchPage()} disabled={busy}>
          <RotateCw className="h-4 w-4" /> Refresh
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Metadata-only record of activity on this vault. Item contents and key material
        never appear here — only who did what and when. Newest first.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      )}

      {!error && events.length === 0 && !busy && (
        <p className="rounded-md border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
          No audit events yet. Activity on this vault will show up here.
        </p>
      )}

      {events.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">When</th>
                <th className="px-3 py-2 text-left font-medium">Action</th>
                <th className="px-3 py-2 text-left font-medium">Actor</th>
                <th className="px-3 py-2 text-left font-medium">Target</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const label = ACTION_LABEL[e.action] ?? e.action;
                const tone = ACTION_TONE[e.action] ?? "neutral";
                return (
                  <tr key={e.id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {formatTs(e.ts)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={tone === "warn" ? "destructive" : "secondary"}>
                        {label}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {e.actorUserId !== null ? `user ${e.actorUserId}` : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {e.targetId ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchPage(events.at(-1)?.ts)}
            disabled={busy}
          >
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}
