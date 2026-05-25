"use client";

import { Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeCustomizer } from "@/components/theme-customizer";

export function SiteHeader({ onLock }: { onLock?: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="h-5 w-5 text-primary" />
          arc-vault
        </div>
        <div className="flex items-center gap-2">
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
