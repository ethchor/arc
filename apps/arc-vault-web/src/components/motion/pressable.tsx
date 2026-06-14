"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

interface PressableProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Render as a child component (Radix Slot pattern). */
  asChild?: boolean;
  /** How aggressive the press feedback is. Default 0.97 — subtle and consistent with buttons. */
  scale?: number;
}

/**
 * Wrap any tappable element to give it physical press feedback (scale-down on `:active`).
 * CSS-only — no JS, no re-render — so it stays smooth even when the main thread is busy.
 *
 * Prefer this over per-component `active:scale-*` so the press feel stays consistent.
 */
export const Pressable = React.forwardRef<HTMLDivElement, PressableProps>(
  ({ asChild = false, scale = 0.97, className, style, ...props }, ref) => {
    const Comp = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref}
        data-pressable
        className={cn(
          "transition-transform [transition-duration:var(--dur-fast)] ease-out-quart active:[transform:scale(var(--press-scale))]",
          className,
        )}
        style={{ ...(style ?? {}), ["--press-scale" as string]: String(scale) }}
        {...props}
      />
    );
  },
);
Pressable.displayName = "Pressable";
