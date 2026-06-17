"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * shadcn/Radix tooltip. Replaces the native `title=""` attribute we used across the app —
 * which renders an unstyled, slow (~1.5s), OS-drawn bubble with no room for a description.
 * These are theme-aware (the `popover` surface tokens), animate in/out, and carry a bold
 * label + an optional muted one-line "what this does" description.
 *
 * Three layers:
 *   • {@link TooltipProvider}/{@link Tooltip}/{@link TooltipTrigger}/{@link TooltipContent}
 *     — the raw shadcn primitives (escape hatch for custom content).
 *   • {@link IconTip} — wrap any standalone control (icon buttons, links) in a rich tip.
 *   • {@link TipTrigger} — the Dialog-trigger variant: nests `TooltipTrigger > DialogTrigger`
 *     correctly so a dialog-opening icon (e.g. "Add login") can carry a tooltip without
 *     breaking the click-to-open. Render it inside a `<Dialog>` (it needs that context).
 */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 max-w-[260px] overflow-hidden rounded-[var(--radius-md)] border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md",
        "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export type TipSide = "top" | "right" | "bottom" | "left";

export interface TipProps {
  /** Bold first line — the name of the action ("Add login"). */
  label: React.ReactNode;
  /** Optional muted second line — what the control actually does. */
  hint?: React.ReactNode;
  /** Optional keyboard shortcut chip rendered next to the label. */
  shortcut?: string;
  side?: TipSide;
}

/** The two-line label + description body shared by {@link IconTip} and {@link TipTrigger}. */
function TipBody({ label, hint, shortcut }: Pick<TipProps, "label" | "hint" | "shortcut">) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-semibold leading-snug">{label}</span>
        {shortcut ? (
          <kbd className="rounded border border-border/60 bg-background/50 px-1 font-mono text-[10px] leading-none text-muted-foreground">
            {shortcut}
          </kbd>
        ) : null}
      </div>
      {hint ? <p className="text-[11.5px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * Wrap a single interactive element (icon button, link) in a rich tooltip. The child is the
 * trigger and must forward ref/props (a DOM element or a component using `asChild`/`Slot`).
 */
export function IconTip({
  label,
  hint,
  shortcut,
  side = "bottom",
  children,
}: TipProps & { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <TipBody label={label} hint={hint} shortcut={shortcut} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Dialog-trigger with an optional rich tooltip. Drop-in replacement for
 * `<DialogTrigger asChild>{trigger}</DialogTrigger>` inside a `<Dialog>`: when `tip` is set
 * it nests `TooltipTrigger asChild → DialogTrigger asChild → trigger`, which is the only
 * composition where both the hover tooltip *and* the click-to-open survive (Radix `Slot`s
 * forward props/ref straight through to the underlying button).
 */
export function TipTrigger({ tip, children }: { tip?: TipProps; children: React.ReactNode }) {
  if (!tip) return <DialogTrigger asChild>{children}</DialogTrigger>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DialogTrigger asChild>{children}</DialogTrigger>
      </TooltipTrigger>
      <TooltipContent side={tip.side ?? "bottom"}>
        <TipBody label={tip.label} hint={tip.hint} shortcut={tip.shortcut} />
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
