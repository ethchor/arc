import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * Button — refined per Emil Kowalski's framework:
 *   - Transitions are scoped (transform + colors + box-shadow), never `all`.
 *   - Press feedback via `active:scale-[0.97]`; 160ms transform with the project's ease-out-quart.
 *   - Hover lift on the default variant — tinted shadow, not a generic drop.
 *   - Focus ring uses `--ring` (per theme), 2px offset for keyboard clarity.
 */

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
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
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8 text-[15px]",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
