"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, SunMoon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTip } from "@/components/ui/tooltip";
import { SegmentedControl } from "@/components/arc/segmented-control";
import { REDUCE_TRANSPARENCY_KEY } from "@/lib/glass";
import { cn } from "@/lib/utils";

/** Retired accent presets (docs/18 D3) — cleared so a saved preset can't override arc cyan. */
const LEGACY_PRESET_KEY = "arc-vault-preset";

const MODES = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
] as const;
type Mode = (typeof MODES)[number]["value"];

export type Density = "comfortable" | "compact";

function useReduceTransparency(): [boolean, (on: boolean) => void] {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    try {
      setOn(localStorage.getItem(REDUCE_TRANSPARENCY_KEY) === "1");
      localStorage.removeItem(LEGACY_PRESET_KEY);
    } catch {
      /* storage unavailable (private mode): the switch still works for this page */
    }
    document.documentElement.removeAttribute("data-theme");
  }, []);
  const set = (next: boolean) => {
    setOn(next);
    try {
      if (next) localStorage.setItem(REDUCE_TRANSPARENCY_KEY, "1");
      else localStorage.removeItem(REDUCE_TRANSPARENCY_KEY);
    } catch {
      /* non-persistent is fine */
    }
    if (next) document.documentElement.setAttribute("data-glass", "off");
    else document.documentElement.removeAttribute("data-glass");
  };
  return [on, set];
}

/**
 * Appearance menu (docs/18 D3). Follows the system appearance by default; offers a
 * Light/Dark/System override, an optional density control, and Reduce Transparency, which
 * makes every glass surface opaque. The HIG discourages app-specific appearance settings,
 * but browsers don't all expose the OS Reduce Transparency setting, so the switch stays.
 */
export function ThemeCustomizer({
  density,
  onDensity,
  className,
}: {
  density?: Density;
  onDensity?: (d: Density) => void;
  className?: string;
}) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [reduce, setReduce] = useReduceTransparency();
  React.useEffect(() => setMounted(true), []);
  const mode = (mounted ? theme : "system") as Mode;

  return (
    <DropdownMenu>
      <IconTip label="Appearance" hint="Light, dark or system appearance, density, and transparency.">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className={cn("h-8 w-8", className)} aria-label="Appearance">
            <SunMoon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
      </IconTip>
      <DropdownMenuContent align="end" className="w-72 p-2">
        <DropdownMenuLabel className="px-1.5">Appearance</DropdownMenuLabel>
        <SegmentedControl
          aria-label="Appearance"
          fill
          value={mode}
          onChange={(v) => setTheme(v)}
          options={MODES}
        />
        {density && onDensity ? (
          <>
            <DropdownMenuLabel className="mt-2 px-1.5">Density</DropdownMenuLabel>
            <SegmentedControl
              aria-label="Density"
              fill
              value={density}
              onChange={onDensity}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          </>
        ) : null}
        <DropdownMenuSeparator className="my-2" />
        <button
          type="button"
          role="switch"
          aria-checked={reduce}
          onClick={() => setReduce(!reduce)}
          className="flex w-full items-center gap-3 rounded-[var(--radius-md)] px-1.5 py-1.5 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex-1">
            <span className="block text-sm font-medium">Reduce Transparency</span>
            <span className="block text-footnote text-muted-foreground">Makes bars, menus and sheets opaque.</span>
          </span>
          <span
            aria-hidden
            className={cn(
              "relative h-6 w-10 shrink-0 rounded-full transition-colors [transition-duration:var(--dur-fast)]",
              reduce ? "bg-primary" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-[var(--shadow-sm)] transition-transform [transition-duration:var(--dur-base)] ease-out-back",
                reduce ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            />
          </span>
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
