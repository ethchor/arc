import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Input — a content-layer control (docs/18 §4.3): never glass, so typed and revealed values
 * always sit on an opaque inset fill. Liquid Glass-era geometry: 12px corners, 44px tall on
 * touch / 40px with a pointer, an accent focus ring. Touch widths use 16px+ text so iOS
 * Safari doesn't zoom the page on focus.
 */

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-[var(--control-height)] w-full rounded-[var(--radius-lg)] border border-input bg-[var(--surface-inset)] px-3.5 py-2 text-sm max-sm:text-base",
          "outline-none",
          "transition-[border-color,box-shadow,background-color] [transition-duration:var(--dur-fast)] ease-out-quart",
          "hover:border-ring/40",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "placeholder:text-muted-foreground/70",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
