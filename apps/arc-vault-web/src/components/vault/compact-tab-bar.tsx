"use client";

import type { LucideIcon } from "lucide-react";
import { PanelLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CompactTab<T extends string> {
  id: T;
  /** One word (HIG Tab bars: "use single words whenever possible"). */
  label: string;
  icon: LucideIcon;
}

/**
 * The compact-width navigation (docs/18 §4.2, HIG Tab bars): a floating glass tab bar at the
 * bottom, inset from the edges and above the home indicator. It holds the persona's most-used
 * sections, a leading button that opens every section as a sheet (the adaptable-sidebar
 * pattern), and a trailing search button. It minimizes while people scroll down.
 */
export function CompactTabBar<T extends string>({
  tabs,
  current,
  onSelect,
  onShowAll,
  onSearch,
  minimized,
}: {
  tabs: readonly CompactTab<T>[];
  current: string;
  onSelect: (id: T) => void;
  onShowAll: () => void;
  onSearch: () => void;
  minimized: boolean;
}) {
  const active = tabs.find((t) => t.id === current);
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 flex items-end gap-2 px-[max(var(--glass-inset),env(safe-area-inset-left))] pb-[calc(env(safe-area-inset-bottom)+var(--glass-inset))] sm:hidden"
      style={{ zIndex: "var(--z-sticky)" as React.CSSProperties["zIndex"] }}
    >
      <button
        type="button"
        onClick={onShowAll}
        aria-label="All sections"
        className={cn(
          "glass flex shrink-0 items-center justify-center rounded-full text-foreground/80 transition-[width,height,opacity] [transition-duration:var(--dur-base)] ease-out-quart",
          minimized ? "pointer-events-none h-11 w-0 border-0 opacity-0" : "h-14 w-14",
        )}
      >
        <PanelLeft className="h-5 w-5" />
      </button>

      <div
        className={cn(
          "glass flex items-center rounded-full p-1 transition-[height] [transition-duration:var(--dur-base)] ease-out-quart",
          minimized ? "h-11" : "h-14 flex-1",
        )}
      >
        {(minimized && active ? [active] : tabs).map((t) => {
          const isActive = t.id === current;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              aria-current={isActive ? "page" : undefined}
              aria-label={t.label}
              className={cn(
                "flex h-full flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-2 text-[10px] font-medium",
                "transition-[background-color,color] [transition-duration:var(--dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? "bg-foreground/[0.08] text-primary" : "text-foreground/75",
                minimized && "w-11 flex-none",
              )}
            >
              <Icon className={cn("h-5 w-5", isActive && "fill-primary/15")} />
              {!minimized ? <span className="leading-none">{t.label}</span> : null}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onSearch}
        aria-label="Search"
        className={cn(
          "glass flex shrink-0 items-center justify-center rounded-full text-foreground/80 transition-[width,height] [transition-duration:var(--dur-base)] ease-out-quart",
          minimized ? "ml-auto h-11 w-11" : "h-14 w-14",
        )}
      >
        <Search className="h-5 w-5" />
      </button>
    </nav>
  );
}
