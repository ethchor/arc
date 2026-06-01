"use client";

import * as React from "react";
import { Copy } from "lucide-react";
import { totpCode } from "@arc/crypto";
import type { TotpAlgorithm } from "@arc/types";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Props {
  secret: string;
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
  issuer?: string;
  account?: string;
}

/**
 * Rolling TOTP display. Recomputes once per second (no setInterval on the code itself —
 * we run a 1s tick and re-derive, so the value is always consistent with wall-clock no
 * matter how long the tab was throttled).
 *
 * All generation is local; nothing leaves the device. The TOTP secret arrives here only
 * after the vault key has decrypted the item envelope (docs/04, ADR-002).
 */
export function TotpCard({ secret, period, digits, algorithm, issuer, account }: Props) {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const safe = React.useMemo(() => {
    try {
      return totpCode(secret, { period, digits, algorithm });
    } catch (err) {
      return { error: (err as Error).message } as const;
    }
    // tick is intentionally in the dep list so this recomputes every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret, period, digits, algorithm, tick]);

  if ("error" in safe) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
        Invalid TOTP secret: {safe.error}
      </div>
    );
  }

  const grouped = safe.code.replace(/^(\d{3})(\d{3,5})$/, "$1 $2");
  const periodSec = period ?? 30;
  const pct = (safe.secondsRemaining / periodSec) * 100;

  const copy = async () => {
    await navigator.clipboard.writeText(safe.code);
    toast.success("Code copied");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div
            className="font-mono text-3xl tabular-nums tracking-wider"
            aria-label={`TOTP code ${safe.code}`}
          >
            {grouped}
          </div>
          {(issuer ?? account) && (
            <div className="mt-1 text-xs text-muted-foreground">
              {issuer}
              {issuer && account ? " · " : ""}
              {account}
            </div>
          )}
        </div>
        <Button variant="outline" size="icon" onClick={copy} aria-label="Copy code">
          <Copy className="h-4 w-4" />
        </Button>
      </div>

      <div
        className="flex items-center gap-2 text-xs text-muted-foreground"
        aria-label={`${safe.secondsRemaining} seconds until refresh`}
      >
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-700 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-8 text-right tabular-nums">{safe.secondsRemaining}s</span>
      </div>
    </div>
  );
}
