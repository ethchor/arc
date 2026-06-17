"use client";

import * as React from "react";
import { FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TipTrigger, type TipProps } from "@/components/ui/tooltip";

const TYPES = ["team", "personal"] as const;
type VType = (typeof TYPES)[number];

const DEFAULT_TIP: TipProps = {
  label: "New vault",
  hint: "Create a personal or shared team vault — keyed to your devices.",
};

export function CreateVaultDialog({
  onCreate,
  trigger,
  tooltip = DEFAULT_TIP,
}: {
  onCreate: (type: VType, name: string) => Promise<void>;
  trigger?: React.ReactNode;
  tooltip?: TipProps;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<VType>("team");
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onCreate(type, name.trim());
      setName("");
      setType("team");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TipTrigger tip={tooltip}>
        {trigger ?? (
          <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Create new vault">
            <FolderPlus className="h-4 w-4" />
          </Button>
        )}
      </TipTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New vault</DialogTitle>
          <DialogDescription>The name is encrypted under the vault key.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="vname">Name</Label>
            <Input id="vname" placeholder="e.g. Work" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Type</Label>
            <div className="grid grid-cols-2 gap-2">
              {TYPES.map((t) => (
                <Button
                  key={t}
                  variant={type === t ? "default" : "outline"}
                  size="sm"
                  className="capitalize"
                  onClick={() => setType(t)}
                >
                  {t}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
