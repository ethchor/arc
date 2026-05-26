"use client";

import { Loader2, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function DevicePendingView({
  code,
  onCheck,
  onCancel,
}: {
  code: string;
  onCheck: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Smartphone className="h-5 w-5 text-primary" />
          </div>
          <CardTitle className="text-xl">Approve this device</CardTitle>
          <CardDescription>
            On a device that is already unlocked, open Devices, confirm this code matches, and
            approve. Your master password is never sent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border bg-muted/40 p-4 text-center">
            <div className="text-xs text-muted-foreground">Verification code</div>
            <div className="font-mono text-2xl tracking-widest">{code}</div>
          </div>
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for approval…
          </div>
        </CardContent>
        <CardFooter className="flex-col gap-2">
          <Button className="w-full" onClick={onCheck}>
            <RefreshCw className="h-4 w-4" /> Check now
          </Button>
          <Button variant="ghost" className="w-full" onClick={onCancel}>
            Cancel
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
