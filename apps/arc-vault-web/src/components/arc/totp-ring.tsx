"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Animated TOTP countdown ring + grouped code. Ported from the arc design system
 * (`security/TotpRing`). The ring drains over the period and turns amber (`--sec-expiring`)
 * in the final `warnAt` seconds. Presentation only — the caller computes `code`/`period`.
 * Styling: `.arc-totp*`.
 */
export function TotpRing({
  code = "000000",
  period = 30,
  size = 40,
  stroke = 3,
  warnAt = 5,
  showCode = true,
  className,
}: {
  code?: string;
  period?: number;
  size?: number;
  stroke?: number;
  warnAt?: number;
  showCode?: boolean;
  className?: string;
}) {
  const [remaining, setRemaining] = React.useState(period - (Math.floor(Date.now() / 1000) % period));

  React.useEffect(() => {
    const id = setInterval(() => setRemaining(period - (Math.floor(Date.now() / 1000) % period)), 1000);
    return () => clearInterval(id);
  }, [period]);

  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - remaining / period);
  const warn = remaining <= warnAt;
  const grouped = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

  return (
    <span className={cn("arc-totp", warn && "arc-totp--warn", className)}>
      <span className="arc-totp__ring" style={{ width: size, height: size }}>
        <svg width={size} height={size}>
          <circle className="arc-totp__track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
          <circle
            className="arc-totp__bar"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeDasharray={circ}
            strokeDashoffset={offset}
          />
        </svg>
        <span className="arc-totp__num">{remaining}</span>
      </span>
      {showCode ? <span className="arc-totp__code">{grouped}</span> : null}
    </span>
  );
}
