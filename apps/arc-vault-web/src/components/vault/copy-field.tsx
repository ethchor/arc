"use client";

import * as React from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const CLIPBOARD_CLEAR_MS = 20_000;

export function CopyField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [revealed, setRevealed] = React.useState(!secret);
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success(`${label} copied`, { description: "Clipboard auto-clears in 20s." });
      // Best-effort clipboard clear (docs/12 §12.3).
      setTimeout(() => void navigator.clipboard.writeText("").catch(() => {}), CLIPBOARD_CLEAR_MS);
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-sm">{revealed ? value || "—" : "••••••••••"}</div>
      </div>
      <div className="flex items-center gap-1">
        {secret && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? "Hide" : "Reveal"}
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
