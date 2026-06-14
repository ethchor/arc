import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Input — refined focus + hover. Border subtly warms on hover so the field
 * reads as targettable, then snaps to the brand ring on focus with a 2px offset
 * (keyboard-clear). Transitions are scoped so the active-press scale of the
 * surrounding button row doesn't bleed in.
 */

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
          "ring-offset-background outline-none",
          "transition-[border-color,box-shadow,background-color] [transition-duration:var(--dur-fast)] ease-out-quart",
          "hover:border-ring/40",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "placeholder:text-muted-foreground/70",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
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
