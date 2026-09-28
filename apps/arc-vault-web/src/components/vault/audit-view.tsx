"use client";

import * as React from "react";
import { RotateCw } from "lucide-react";
import type { AuditEvent } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/arc/copy-button";
import { InspectorField, InspectorPlaceholder, InspectorSplit } from "@/components/arc/inspector-split";
import { relativeAgo } from "@/lib/datetime";
import { cn } from "@/lib/utils";

/**
 * Map of `action` codes the server writes into the audit log. Adding a new code on the
 * server doesn't break this — the fallback case renders the raw code in monospace.
 */
const ACTION_LABEL: Record<string, string> = {
  vault_created: "Vault Created",
  member_added: "Member Added",
  item_created: "Item Created",
  item_updated: "Item Updated",
  item_deleted: "Item Deleted",
  folder_created: "Folder Created",
  folder_deleted: "Folder Deleted",
  vault_key_rotated: "Vault Key Rotated",
  device_added: "Device Added",
  device_approved: "Device Approved",
  device_revoked: "Device Revoked",
  unlock_failed: "Unlock Failed",
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
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

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
    setSelectedId(null);
    void fetchPage();
  }, [vaultId, fetchPage]);

  const selected = events.find((e) => e.id === selectedId) ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Govern · audit
          </span>
          <h1 className="font-display text-2xl font-medium tracking-tight">Audit Log</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Metadata-only record of activity on this vault. Item contents and key material
            never appear here — only who did what and when. Newest first.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchPage()} disabled={busy}>
          <RotateCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      )}

      {!error && events.length === 0 && !busy && (
        <p className="rounded-[var(--radius-md)] border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
          No audit events yet. Activity on this vault will show up here.
        </p>
      )}

      {events.length > 0 && (
        <InspectorSplit
          list={
            <div className="space-y-4">
              <div className="overflow-hidden rounded-[var(--radius-xl)] border border-border/70">
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
                      const isSelected = e.id === selectedId;
                      // The whole row selects the event; the button in the first cell is the
                      // keyboard and screen-reader target for the same action.
                      return (
                        <tr
                          key={e.id}
                          onClick={() => setSelectedId(e.id)}
                          className={cn(
                            "cursor-pointer border-t transition-colors [transition-duration:var(--dur-fast)]",
                            isSelected ? "bg-[var(--ds-accent-subtle)]" : "hover:bg-[var(--surface-hover)]",
                          )}
                        >
                          <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground [@media(pointer:coarse)]:py-3">
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setSelectedId(e.id);
                              }}
                              aria-current={isSelected ? "true" : undefined}
                              aria-label={`${label}, ${formatTs(e.ts)}`}
                              className="rounded-[var(--radius-sm)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {formatTs(e.ts)}
                            </button>
                          </td>
                          <td className="px-3 py-2.5 [@media(pointer:coarse)]:py-3">
                            <Badge variant={tone === "warn" ? "destructive" : "secondary"}>{label}</Badge>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground [@media(pointer:coarse)]:py-3">
                            {e.actorUserId !== null ? `user ${e.actorUserId}` : "—"}
                          </td>
                          <td className="max-w-[16rem] truncate px-3 py-2.5 font-mono text-xs text-muted-foreground [@media(pointer:coarse)]:py-3">
                            {e.targetId ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {hasMore && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchPage(events.at(-1)?.ts)}
                    disabled={busy}
                  >
                    Load Older
                  </Button>
                </div>
              )}
            </div>
          }
          hasSelection={selected !== null}
          inspector={selected ? <AuditInspector event={selected} /> : null}
          placeholder={
            <InspectorPlaceholder
              title="No Event Selected"
              body="Select an event to see its full target and event IDs."
            />
          }
          onBack={() => setSelectedId(null)}
          backLabel="Audit Log"
          inspectorLabel="Event details"
        />
      )}
    </div>
  );
}

/** One audit event in full. Metadata only: the log never holds item contents or keys. */
function AuditInspector({ event }: { event: AuditEvent }) {
  const label = ACTION_LABEL[event.action] ?? event.action;
  const tone = ACTION_TONE[event.action] ?? "neutral";
  return (
    <div className="space-y-5 p-5">
      <div className="space-y-1.5">
        <h2 className="text-title-3 font-semibold">{label}</h2>
        <Badge variant={tone === "warn" ? "destructive" : "secondary"} className="font-mono text-[10px]">
          {event.action}
        </Badge>
      </div>
      <dl className="space-y-3.5">
        <InspectorField label="When">
          {formatTs(event.ts)} ({relativeAgo(event.ts)})
        </InspectorField>
        <InspectorField label="Actor">
          {event.actorUserId !== null ? `User ${event.actorUserId}` : "The server (no user)"}
        </InspectorField>
        <InspectorField label="Target" mono={event.targetId !== null}>
          {event.targetId ? (
            <>
              <span className="min-w-0 flex-1">{event.targetId}</span>
              <CopyButton value={event.targetId} iconOnly autoClearSeconds={0} />
            </>
          ) : (
            "None"
          )}
        </InspectorField>
        <InspectorField label="Event ID" mono>
          <span className="min-w-0 flex-1">{event.id}</span>
          <CopyButton value={event.id} iconOnly autoClearSeconds={0} />
        </InspectorField>
      </dl>
    </div>
  );
}
