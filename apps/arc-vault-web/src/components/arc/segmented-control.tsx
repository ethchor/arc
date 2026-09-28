"use client";

import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

/**
 * Segmented control (HIG: a linear set of closely related, mutually exclusive choices). A
 * capsule track whose selected segment is a raised pill; segments share one width when
 * `fill` is set, as the HIG asks for consistent segment sizes. Exposed as a radio group
 * (there are no tab panels behind it), so screen readers announce "1 of 2, selected".
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = "default",
  fill = false,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly SegmentOption<T>[];
  size?: "sm" | "default";
  /** Stretch to the container and give every segment the same width. */
  fill?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "items-center gap-0.5 rounded-full border border-border/70 bg-muted/60 p-0.5",
        fill ? "grid w-full" : "inline-flex",
        className,
      )}
      style={fill ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-[background-color,color,box-shadow] [transition-duration:var(--dur-fast)] ease-out-quart",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "h-7 px-3 text-xs" : "h-8 px-3.5 text-[13px]",
              active
                ? "bg-background text-foreground shadow-[var(--shadow-xs)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon ? <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
