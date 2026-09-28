import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Button — Liquid Glass-era controls (docs/18 §4.3): capsule shapes that sit concentric with
 * rounded containers, 44px tall on touch / 40px with a pointer (--control-height), and two
 * glass variants for controls in the floating layer. Refined per Emil Kowalski's framework:
 *   - Transitions are scoped (transform + colors + box-shadow), never `all`.
 *   - Press feedback via `active:scale-[0.97]`; 160ms transform with the project's ease-out-quart.
 *   - Hover lift on the default variant — tinted shadow, not a generic drop.
 *   - Focus ring uses `--ring` (per theme), 2px offset for keyboard clarity.
 */

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium",
    "ring-offset-background outline-none",
    "transition-[transform,background-color,color,box-shadow,opacity]",
    "[transition-duration:var(--dur-fast)]",
    "ease-out-quart",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "active:scale-[0.97]",
    "disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[var(--shadow-sm)] hover:bg-primary/92 hover:shadow-[var(--shadow-md)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[var(--shadow-sm)] hover:bg-destructive/92",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground hover:border-ring/40",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "rounded-md text-primary underline-offset-4 hover:underline active:scale-100",
        // Floating-layer controls (toolbars, overlays on media): regular glass, monochrome label.
        glass: "glass text-foreground hover:brightness-[1.04] dark:hover:brightness-110",
        // The one primary action per view in the floating layer: the accent tints the glass.
        glassProminent: "glass glass-prominent font-semibold hover:brightness-105",
      },
      size: {
        default: "h-[var(--control-height)] px-4 py-2",
        sm: "h-[var(--control-height-sm)] px-3.5",
        lg: "h-12 px-8 text-[15px]",
        icon: "h-[var(--control-height)] w-[var(--control-height)]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * HIG Buttons: show an activity indicator inside the button while its action runs, instead
   * of a separate spinner. Disables the button and marks it aria-busy.
   */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    if (asChild) {
      // Slot forwards everything (including `disabled`) to its child, as before.
      const slotProps = { ...props, disabled } as React.HTMLAttributes<HTMLElement>;
      return (
        <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...slotProps}>
          {children}
        </Slot>
      );
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
