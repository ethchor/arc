import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The arc honeycomb halftone mark — the design system's primary logo (`arc-mark.svg`),
 * used everywhere a brand mark appears (nav rail, auth chips, brand panel). Rendered via
 * CSS `mask` so it tints to `currentColor` and the 35 KB SVG stays out of the JS bundle.
 *
 * Size it with `className` (e.g. `h-5 w-5`). Colour follows `currentColor`, so wrap it in
 * a `text-primary` (or any text-colour) container.
 */
export function HoneycombMark({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden
      className={cn("inline-block bg-current", className)}
      style={{
        WebkitMask: "url(/arc-honeycomb.svg) center / contain no-repeat",
        mask: "url(/arc-honeycomb.svg) center / contain no-repeat",
      }}
      {...props}
    />
  );
}
