"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // Blurred glass scrim rather than an opaque black plate. The translucent dim
      // (`bg-background/60`) preserves theme tint instead of forcing black-on-light,
      // and `backdrop-blur-md` (12px) softens whatever's behind the dialog so the
      // dialog reads as the foreground without hiding context. Browsers without
      // `backdrop-filter` get a slightly heavier fallback (`bg-background/85`) so
      // the surface still recedes legibly.
      "fixed inset-0 z-50 bg-background/85 supports-[backdrop-filter]:bg-background/60 backdrop-blur-md",
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * Compact-width sheet affordance (HIG Sheets): a grabber at the top edge that people can drag
 * down to dismiss. Dragging translates the sheet; letting go past the threshold closes it via
 * the sheet's own Close button, so Radix still runs its exit animation and focus return.
 */
function SheetGrabber() {
  const drag = React.useRef<{ y: number; el: HTMLElement } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget.closest<HTMLElement>('[role="dialog"]');
    if (!el) return;
    drag.current = { y: e.clientY, el };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.y);
    d.el.style.transform = `translateY(${dy}px)`;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (dy > 90) d.el.querySelector<HTMLButtonElement>("[data-sheet-close]")?.click();
    else d.el.style.transform = "";
  };
  return (
    <div
      aria-hidden
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="-mb-2 -mt-3 flex touch-none justify-center pb-2 pt-1 sm:hidden"
    >
      <span className="h-[5px] w-9 rounded-full bg-foreground/25" />
    </div>
  );
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Liquid Glass sheet (docs/18 §4.4): the strong fill over the blurred scrim, with the DS
        // 22px corner. Regular widths: centered, fade + 95→100% zoom. The centering uses
        // left/top 50% + translate(-50%,-50%), and tailwindcss-animate swaps the transform for
        // translate3d(var(--tw-enter-translate-*)) during the animation, so slide-in-from-left/
        // top-[50%] set those vars to the same -50% (no corner-slide, only zoom + fade).
        // Compact widths: an inset bottom sheet above the home indicator that slides up, with a
        // grabber (see SheetGrabber) and a height cap so long forms scroll inside it.
        "glass glass-strong fixed left-[50%] top-[50%] z-50 grid w-[calc(100%-2*var(--glass-inset))] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-[var(--radius-2xl)] p-6 duration-200",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
        "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
        "data-[state=open]:slide-in-from-left-[50%] data-[state=open]:slide-in-from-top-[50%]",
        "data-[state=closed]:slide-out-to-left-[50%] data-[state=closed]:slide-out-to-top-[50%]",
        "max-sm:bottom-[calc(env(safe-area-inset-bottom)+var(--glass-inset))] max-sm:left-[var(--glass-inset)] max-sm:top-auto max-sm:max-h-[85dvh] max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:overflow-y-auto max-sm:p-5",
        "max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:zoom-out-100",
        "max-sm:data-[state=open]:slide-in-from-left-0 max-sm:data-[state=open]:slide-in-from-bottom-10",
        "max-sm:data-[state=closed]:slide-out-to-left-0 max-sm:data-[state=closed]:slide-out-to-bottom-10",
        className,
      )}
      {...props}
    >
      <SheetGrabber />
      {children}
      <DialogPrimitive.Close
        data-sheet-close
        className="absolute right-3.5 top-3.5 flex h-8 w-8 items-center justify-center rounded-full opacity-70 ring-offset-background transition-opacity hover:bg-foreground/[0.07] hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
