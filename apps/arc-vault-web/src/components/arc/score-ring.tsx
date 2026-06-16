"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Big circular score ring (0-100). Theme-tinted from CSS tokens: green ≥80, ember 60-79,
 * danger <60. Track + fill come from the surface ramp so it reads the same in light + dark.
 * Animates the dash-offset on value change.
 */
export function ScoreRing({
  value,
  size = 108,
  stroke = 9,
  label,
  className,
}: {
  value: number;
  size?: number;
  stroke?: number;
  label?: string;
  className?: string;
}) {
  const safe = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - safe / 100);
  const color =
    safe >= 80
      ? "var(--success)"
      : safe >= 60
        ? "var(--ember, var(--warning))"
        : "var(--danger)";

  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-sunken)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 600ms var(--ease-out-quart), stroke var(--dur-base)" }}
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center font-mono">
        <span className="text-[34px] font-semibold leading-none tracking-tight tabular-nums">{Math.round(safe)}</span>
        {label ? (
          <span className="mt-1 text-[11px] font-sans text-muted-foreground">{label}</span>
        ) : null}
      </div>
    </div>
  );
}
