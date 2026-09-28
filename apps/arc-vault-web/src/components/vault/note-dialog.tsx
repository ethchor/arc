"use client";

import * as React from "react";
import {
  Dialog,
  DialogClose,
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
import { useControllableOpen } from "@/lib/use-controllable-open";

export interface NoteInput {
  title: string;
  body: string;
}

const EMPTY: NoteInput = { title: "", body: "" };

export function NoteDialog({
  trigger,
  tooltip,
  open: openProp,
  onOpenChange,
  initial,
  heading = "Add Note",
  folders = [],
  initialFolderId = null,
  onSubmit,
}: {
  trigger: React.ReactNode;
  tooltip?: TipProps;
  /** Controlled open state, for opening the dialog from elsewhere (a row's context menu). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initial?: NoteInput;
  heading?: string;
  folders?: Array<{ id: string; name: string }>;
  initialFolderId?: string | null;
  onSubmit: (value: NoteInput, folderId: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useControllableOpen(openProp, onOpenChange);
  const [form, setForm] = React.useState<NoteInput>(initial ?? EMPTY);
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
            Plaintext is encrypted on this device before the server sees it. Free-form
            body — keep it under a few KB so the encrypted envelope stays cache-friendly.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="note-title">Title</Label>
            <Input
              id="note-title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="note-body">Body</Label>
            <textarea
              id="note-body"
              rows={8}
              className="min-h-[10rem] rounded-[var(--radius-lg)] border border-input bg-[var(--surface-inset)] px-3.5 py-2.5 font-mono text-sm outline-none transition-[border-color,box-shadow] [transition-duration:var(--dur-fast)] hover:border-ring/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 max-sm:text-base"
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
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
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button onClick={submit} disabled={busy || !form.title}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
