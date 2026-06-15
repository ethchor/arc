"use client";

import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

/**
 * Compact segmented control (the persona switch + density-style toggles in the design's
 * top bar). Single-select; the active segment gets a raised pill. Presentation only.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = "default",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly SegmentOption<T>[];
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/60 p-0.5",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] font-medium transition-colors [transition-duration:var(--dur-fast)] ease-out-quart",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
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
