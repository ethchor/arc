import type { SVGProps } from "react";

/**
 * The arc logomark — an arc spanning two nodes (the "bridge" between machine secrets
 * and human secrets), with a third node at the apex. Drawn in `currentColor` so it
 * inherits the brand accent (arc cyan) wherever it's placed; size via `className`
 * (`h-* w-*`). Source: arc design system `assets/arc-logomark.svg`.
 */
export function ArcMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      className={className}
      role="img"
      aria-label="arc"
      {...props}
    >
      <path
        d="M8 30 A 12 18 0 0 1 32 30"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="30" r="3.6" fill="currentColor" />
      <circle cx="32" cy="30" r="3.6" fill="currentColor" />
      <circle cx="20" cy="11.6" r="2.8" fill="currentColor" />
    </svg>
  );
}
