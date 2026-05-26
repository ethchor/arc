"use client";

import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

const AUTOLOCK_OPTIONS = [1, 5, 15, 30];

export function SettingsDialog({
  autolock,
  onAutolock,
}: {
  autolock: number;
  onAutolock: (minutes: number) => void;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Settings">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Stored locally on this device.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label>Auto-lock after inactivity</Label>
          <div className="grid grid-cols-4 gap-2">
            {AUTOLOCK_OPTIONS.map((m) => (
              <Button
                key={m}
                variant={autolock === m ? "default" : "outline"}
                size="sm"
                onClick={() => onAutolock(m)}
              >
                {m} min
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            The vault locks and wipes in-memory keys after this idle time.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
