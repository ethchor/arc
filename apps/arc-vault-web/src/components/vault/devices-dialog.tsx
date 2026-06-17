"use client";

import * as React from "react";
import { MonitorSmartphone } from "lucide-react";
import type { PendingDevice } from "@arc/sdk";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TipTrigger } from "@/components/ui/tooltip";

export function DevicesDialog({
  onLoad,
  onApprove,
}: {
  onLoad: () => Promise<PendingDevice[]>;
  onApprove: (device: PendingDevice) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [devices, setDevices] = React.useState<PendingDevice[]>([]);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(() => {
    onLoad().then(setDevices).catch(() => setDevices([]));
  }, [onLoad]);

  React.useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const approve = async (device: PendingDevice) => {
    setBusy(true);
    try {
      await onApprove(device);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TipTrigger tip={{ label: "Pending devices", hint: "Approve or reject devices waiting to join your vault." }}>
        <Button variant="outline" size="icon" aria-label="Devices">
          <MonitorSmartphone className="h-4 w-4" />
        </Button>
      </TipTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pending devices</DialogTitle>
          <DialogDescription>
            Approve only after the code matches the one shown on the new device.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {devices.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No devices waiting.</p>
          ) : (
            devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <div className="text-sm font-medium">{d.name}</div>
                  <div className="font-mono text-sm tracking-widest text-muted-foreground">
                    {d.verificationCode}
                  </div>
                </div>
                <Button size="sm" disabled={busy} onClick={() => approve(d)}>
                  Approve
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
