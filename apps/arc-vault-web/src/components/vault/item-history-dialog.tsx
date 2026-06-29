"use client";

import * as React from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import type { ItemVersion, PulledItem } from "@arc/sdk";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relativeAgo } from "@/lib/datetime";

/** One-line, type-aware preview of a past version's decrypted payload. */
function previewVersion(data: ItemVersion["data"]): string {
  if (!data || typeof data !== "object") return "Couldn't decrypt on this device";
  const d = data as Record<string, unknown>;
  const fields = (d.fields ?? {}) as Record<string, unknown>;
  switch (d.type) {
    case "login":
      return [fields.username, fields.url].filter(Boolean).join(" · ") || "Login";
    case "totp":
      return (
        [d.issuer, d.account].filter(Boolean).join(" · ") ||
        (typeof d.key === "string" ? d.key : "One-time code")
      );
    case "note":
      return typeof d.body === "string"
        ? d.body.split("\n")[0]?.slice(0, 60) || "Secure note"
        : "Secure note";
    case "secret":
      return typeof d.key === "string" ? d.key : "Secret";
    default:
      return typeof d.type === "string" ? d.type : "Item";
  }
}

/**
 * Item version history (per-item "More actions" → "Version history"). Lists the item's past
 * versions — each archived snapshot is decrypted on this device — and lets you restore one.
 *
 * Restore is a *forward* edit: the SDK writes the chosen version's payload back as a new
 * version on top of the current one (respecting optimistic concurrency), so nothing is
 * destroyed and the displaced version itself becomes a history entry. Controlled dialog
 * because it's opened from a dropdown-menu item, which closes its own menu on select.
 */
export function ItemHistoryDialog({
  item,
  open,
  onOpenChange,
  onList,
  onRestore,
}: {
  item: PulledItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onList: (item: PulledItem) => Promise<ItemVersion[]>;
  onRestore: (item: PulledItem, version: number) => Promise<void>;
}) {
  const [versions, setVersions] = React.useState<ItemVersion[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState<number | null>(null);

  // (Re)load whenever the dialog opens. Guard against a stale resolve writing into a closed
  // dialog (or a different item) via the `cancelled` flag.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setVersions(null);
    setError(null);
    onList(item)
      .then((v) => {
        if (!cancelled) setVersions(v);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error)?.message ?? "Couldn't load history");
      });
    return () => {
      cancelled = true;
    };
  }, [open, item, onList]);

  const restore = async (version: number) => {
    setRestoring(version);
    setError(null);
    try {
      await onRestore(item, version);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error)?.message ?? "Restore failed");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Version history
          </DialogTitle>
          <DialogDescription>
            Previous versions of this item, newest first — each decrypted on your device.
            Restoring writes that version back as a new edit, so nothing is lost.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {versions === null && !error ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
          </div>
        ) : versions && versions.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No previous versions yet — edit this item and its prior contents show up here.
          </div>
        ) : (
          <ul className="max-h-[360px] divide-y overflow-y-auto rounded-md border">
            {versions?.map((v) => {
              const undecryptable = v.data === null;
              return (
                <li key={v.version} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>Version {v.version}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {relativeAgo(v.savedAt)} · user #{v.authorUserId}
                      </span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {previewVersion(v.data)}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={undecryptable || restoring !== null}
                    onClick={() => restore(v.version)}
                  >
                    {restoring === v.version ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Restoring…
                      </>
                    ) : (
                      <>
                        <RotateCcw className="h-3.5 w-3.5" /> Restore
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
