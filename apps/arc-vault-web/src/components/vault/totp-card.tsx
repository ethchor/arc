"use client";

import * as React from "react";
import { totpCode } from "@arc/crypto";
import type { TotpAlgorithm } from "@arc/types";
import { CopyButton } from "@/components/arc/copy-button";
import { TotpRing } from "@/components/arc/totp-ring";

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

  const periodSec = period ?? 30;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {/* TotpRing derives its own wall-clock countdown; the displayed code stays the
            locally-generated `safe.code` so nothing about TOTP derivation changes. */}
        <TotpRing code={safe.code} period={periodSec} size={44} />
        <CopyButton value={safe.code} label="Copy code" />
      </div>
      {(issuer ?? account) && (
        <div className="text-xs text-muted-foreground">
          {issuer}
          {issuer && account ? " · " : ""}
          {account}
        </div>
      )}
    </div>
  );
}
