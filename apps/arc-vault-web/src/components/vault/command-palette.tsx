"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { CornerDownLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  /** Which persona this item belongs to (shown as a hint). */
  persona: "person" | "operator";
}

/**
 * ⌘K command palette — the operator's home base. Filters the full nav across both personas
 * and jumps to a screen (switching persona if needed). Keyboard: ↑/↓ to move, Enter to go,
 * Esc to close. Opens on ⌘K / Ctrl-K globally.
 */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly CommandItem[];
  onSelect: (item: CommandItem) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Global ⌘K / Ctrl-K to toggle.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === "Escape" && open) onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint
      const t = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
  }, [open]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q));
  }, [items, query]);

  React.useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  if (!open) return null;

  const choose = (i: CommandItem) => {
    onSelect(i);
    onOpenChange(false);
  };

  return (
    <div
      className="fixed inset-0 flex items-start justify-center p-4 pt-[14vh]"
      style={{ zIndex: "var(--z-modal)" as React.CSSProperties["zIndex"] }}
      onMouseDown={() => onOpenChange(false)}
    >
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-label="Command palette"
        className="relative w-full max-w-lg overflow-hidden rounded-xl border bg-popover shadow-[var(--shadow-lg)]"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && filtered[active]) {
            e.preventDefault();
            choose(filtered[active]);
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-b px-4">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search secrets, paths, actions…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</p>
          ) : (
            filtered.map((i, idx) => {
              const Icon = i.icon;
              return (
                <button
                  key={i.id}
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(i)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                    idx === active ? "bg-accent text-accent-foreground" : "text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{i.label}</span>
                  <span className="text-[11px] capitalize text-muted-foreground">{i.group}</span>
                  {idx === active ? <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" /> : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
