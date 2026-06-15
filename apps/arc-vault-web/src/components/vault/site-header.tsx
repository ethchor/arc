"use client";

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeCustomizer } from "@/components/theme-customizer";
import { ArcMark } from "@/components/brand/arc-mark";

/**
 * Top chrome for unauth + recovery flows. The unlocked dashboard uses ConsoleShell instead.
 * Sticky, semi-transparent with backdrop blur so the mesh background bleeds through; height
 * capped at 56px so it never eats into the hero. Brand mark is a tight wordmark with the
 * icon glyph (no full padlock SVG) — keeps the unlocked-state chrome calm.
 */
export function SiteHeader({ onLock, actions }: { onLock?: () => void; actions?: ReactNode }) {
  return (
    <header
      className="sticky top-0 border-b border-border/60 bg-background/75 backdrop-blur-md supports-[backdrop-filter]:bg-background/55"
      style={{ zIndex: "var(--z-sticky)" as React.CSSProperties["zIndex"] }}
    >
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <a href="/" className="group flex items-center gap-2.5 outline-none">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20 transition-colors [transition-duration:var(--dur-fast)] ease-out-quart group-hover:bg-primary/15">
            <ArcMark className="h-4 w-4" />
          </span>
          <span className="font-display text-[15px] font-medium tracking-tight">arc</span>
          <span className="hidden text-[13px] font-medium text-muted-foreground sm:inline">vault</span>
        </a>
        <div className="flex items-center gap-2">
          {actions}
          {onLock && (
            <Button variant="outline" size="sm" onClick={onLock}>
              <Lock className="h-4 w-4" /> Lock
            </Button>
          )}
          <ThemeCustomizer />
        </div>
      </div>
    </header>
  );
}
