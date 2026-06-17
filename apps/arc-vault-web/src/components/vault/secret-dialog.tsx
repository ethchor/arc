"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TipTrigger, type TipProps } from "@/components/ui/tooltip";

export interface SecretInput {
  key: string;
  value: string;
}

const EMPTY: SecretInput = { key: "", value: "" };

/**
 * Generic key/value secret — what the CLI calls a `SecretItem` (`arc-vault set <k> <v>`).
 * Useful for API keys, raw tokens, database URLs — anything that doesn't fit the
 * login/totp/note shapes.
 */
export function SecretDialog({
  trigger,
  tooltip,
  initial,
  heading = "Add secret",
  folders = [],
  initialFolderId = null,
  onSubmit,
}: {
  trigger: React.ReactNode;
  tooltip?: TipProps;
  initial?: SecretInput;
  heading?: string;
  folders?: Array<{ id: string; name: string }>;
  initialFolderId?: string | null;
  onSubmit: (value: SecretInput, folderId: string | null) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<SecretInput>(initial ?? EMPTY);
  const [folderId, setFolderId] = React.useState<string | null>(initialFolderId);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(initial ?? EMPTY);
      setFolderId(initialFolderId);
    }
  }, [open, initial, initialFolderId]);

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(form, folderId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TipTrigger tip={tooltip}>{trigger}</TipTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            Encrypted on this device before save. Same shape as
            <code className="ml-1 rounded bg-muted px-1 py-0.5 text-xs">arc-vault set</code>
            on the CLI.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="secret-key">Key</Label>
            <Input
              id="secret-key"
              placeholder="DATABASE_URL"
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              id="secret-value"
              className="font-mono"
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {folders.length > 0 && (
            <div className="grid gap-1.5">
              <Label>Folder</Label>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant={folderId === null ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFolderId(null)}
                >
                  None
                </Button>
                {folders.map((f) => (
                  <Button
                    key={f.id}
                    type="button"
                    variant={folderId === f.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFolderId(f.id)}
                  >
                    {f.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !form.key || !form.value}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
