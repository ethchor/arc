"use client";

import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RecoveryKeyActions } from "@/components/vault/recovery-key-actions";

export function RecoveryKeyCard({
  recoveryKey,
  onDismiss,
}: {
  recoveryKey: string;
  onDismiss: () => void;
}) {
  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> Save your recovery key
        </CardTitle>
        <CardDescription>
          Shown once. Without it <strong>and</strong> your master password, your data is
          permanently unrecoverable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="overflow-x-auto rounded-md border bg-background p-3 font-mono text-sm">
          {recoveryKey}
        </pre>
        <RecoveryKeyActions recoveryKey={recoveryKey} />
        <Button variant="outline" size="sm" onClick={onDismiss}>
          I&apos;ve saved it
        </Button>
      </CardContent>
    </Card>
  );
}
