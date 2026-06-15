"use client";

import * as React from "react";
import { AlertCircle, Timer } from "lucide-react";
import { cn } from "@/lib/utils";

function fmt(s: number): string {
  if (s <= 0) return "expired";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/**
 * Live TTL countdown that shifts colour from healthy → expiring → expired at a glance.
 * Ported from the arc design system (`security/LeaseTimer`). Drive it with `expiresAt`
 * (epoch ms) for a wall-clock countdown, or `seconds` for a fixed start. `variant="block"`
 * renders the big display-face number for stat cards. Styling: `.arc-lease*`.
 */
export function LeaseTimer({
  expiresAt,
  seconds,
  ttl,
  warnAt = 120,
  label,
  variant = "inline",
  showBar = false,
  className,
}: {
  expiresAt?: number;
  seconds?: number;
  ttl?: number;
  warnAt?: number;
  label?: string;
  variant?: "inline" | "block";
  showBar?: boolean;
  className?: string;
}) {
  const initial = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : (seconds ?? 0);
  const [left, setLeft] = React.useState(initial);

  React.useEffect(() => {
    const id = setInterval(() => {
      setLeft((n) => (expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : Math.max(0, n - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const state = left <= 0 ? "expired" : left <= warnAt ? "expiring" : "healthy";
  const total = ttl || initial || 1;
  const pct = Math.max(0, Math.min(100, (left / total) * 100));

  return (
    <span
      className={cn("arc-lease", `arc-lease--${state}`, variant === "block" && "arc-lease--block", className)}
      role="timer"
    >
      <span className="flex items-center gap-[7px]">
        <span className="arc-lease__icon">
          {state === "expired" ? (
            <AlertCircle className={variant === "block" ? "h-[18px] w-[18px]" : "h-[15px] w-[15px]"} />
          ) : (
            <Timer className={variant === "block" ? "h-[18px] w-[18px]" : "h-[15px] w-[15px]"} />
          )}
        </span>
        <span className="arc-lease__time">{fmt(left)}</span>
        {label ? <span className="arc-lease__label">{label}</span> : null}
      </span>
      {showBar ? (
        <span className="arc-lease__bar">
          <span className="arc-lease__fill" style={{ width: `${pct}%` }} />
        </span>
      ) : null}
    </span>
  );
}
