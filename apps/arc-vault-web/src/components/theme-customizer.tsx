"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { applyPreset, DEFAULT_PRESET, PRESET_STORAGE_KEY, THEME_PRESETS } from "@/lib/themes";

const MODES = [
  { key: "light", icon: Sun, label: "Light" },
  { key: "dark", icon: Moon, label: "Dark" },
  { key: "system", icon: Monitor, label: "System" },
] as const;

export function ThemeCustomizer() {
  const { theme, setTheme } = useTheme();
  const [preset, setPreset] = React.useState(DEFAULT_PRESET);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem(PRESET_STORAGE_KEY) ?? DEFAULT_PRESET;
    setPreset(saved);
    applyPreset(saved);
  }, []);

  const choosePreset = (name: string) => {
    setPreset(name);
    localStorage.setItem(PRESET_STORAGE_KEY, name);
    applyPreset(name);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Customize theme" title="Customize theme — accent & appearance">
          <Palette className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Mode</DropdownMenuLabel>
        <div className="grid grid-cols-3 gap-2 p-2">
          {MODES.map(({ key, icon: Icon, label }) => (
            <Button
              key={key}
              variant={mounted && theme === key ? "default" : "outline"}
              size="sm"
              className="h-auto flex-col gap-1 py-2"
              onClick={() => setTheme(key)}
            >
              <Icon className="h-4 w-4" />
              <span className="text-xs">{label}</span>
            </Button>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Color preset</DropdownMenuLabel>
        <div className="grid grid-cols-2 gap-2 p-2">
          {THEME_PRESETS.map((p) => (
            <Button
              key={p.name}
              variant="outline"
              size="sm"
              className={cn("justify-start gap-2", preset === p.name && "border-primary ring-1 ring-primary")}
              onClick={() => choosePreset(p.name)}
            >
              <span
                className="h-4 w-4 shrink-0 rounded-full border"
                style={{ backgroundColor: `hsl(${p.swatch})` }}
              />
              <span className="truncate text-xs">{p.label}</span>
              {preset === p.name && <Check className="ml-auto h-3 w-3 shrink-0" />}
            </Button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
