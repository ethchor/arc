"use client";

import * as React from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

/** Wide enough for the list and a 360 px inspector side by side, next to the sidebar. */
const SPLIT_QUERY = "(min-width: 1024px)";

/**
 * List plus inspector (HIG Split views; docs/18 §4.1). At regular widths the inspector is a
 * content-layer panel beside the list, never glass, so the list keeps its selection
 * highlight. It stays in view while the page scrolls. Narrower than 1024 px, choosing a row
 * pushes the inspector in place of the list, and Back returns to the list.
 */
export function InspectorSplit({
  list,
  inspector,
  placeholder,
  hasSelection,
  onBack,
  backLabel,
  inspectorLabel,
}: {
  list: React.ReactNode;
  /** The selected row's details. Rendered only while `hasSelection` is true. */
  inspector: React.ReactNode;
  /** What the inspector shows when nothing is selected (regular widths only). */
  placeholder: React.ReactNode;
  hasSelection: boolean;
  /** Clears the selection: the Back button at compact widths. */
  onBack: () => void;
  /** Names the list Back returns to ("Leases"). */
  backLabel: string;
  /** Accessible name for the inspector region ("Lease details"). */
  inspectorLabel: string;
}) {
  const split = useMediaQuery(SPLIT_QUERY);
  const pushedRef = React.useRef<HTMLElement>(null);
  const pushed = !split && hasSelection;

  // Push navigation starts at the top of the pushed page, not wherever the row was tapped.
  React.useEffect(() => {
    if (pushed) pushedRef.current?.scrollIntoView({ block: "start" });
  }, [pushed]);

  if (!split) {
    if (!hasSelection) return <>{list}</>;
    return (
      <section ref={pushedRef} aria-label={inspectorLabel} className="scroll-mt-20 space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-primary hover:text-primary">
          <ChevronLeft className="h-4 w-4" /> {backLabel}
        </Button>
        <div className="rounded-[var(--radius-xl)] border border-border/70 bg-[var(--surface-base)]">{inspector}</div>
      </section>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4">
      <div className="min-w-0">{list}</div>
      <section
        aria-label={inspectorLabel}
        className={cn(
          "sticky top-[4.5rem] max-h-[calc(100dvh-5.5rem)] overflow-y-auto rounded-[var(--radius-xl)] border border-border/70",
          hasSelection ? "bg-[var(--surface-base)]" : "bg-[var(--surface-sunken)]",
        )}
      >
        {hasSelection ? inspector : placeholder}
      </section>
    </div>
  );
}

/** A labelled value in an inspector: the label above, the value (and any actions) below. */
export function InspectorField({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-footnote font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("flex min-w-0 items-center gap-2 break-all text-sm", mono && "font-mono text-[13px]")}>
        {children}
      </dd>
    </div>
  );
}

/** Placeholder for an empty inspector: what it will show and how to fill it. */
export function InspectorPlaceholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-headline font-semibold">{title}</p>
      <p className="mt-1 text-subhead text-muted-foreground">{body}</p>
    </div>
  );
}
