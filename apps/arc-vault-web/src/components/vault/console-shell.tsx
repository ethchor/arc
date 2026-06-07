"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Bot, Clock, FileClock, KeyRound, Lock, ScrollText, Users, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeCustomizer } from "@/components/theme-customizer";
import { cn } from "@/lib/utils";

export type ConsoleSection =
  | "secrets"
  | "access"
  | "identities"
  | "policies"
  | "leases"
  | "audit"
  | "tools";

const NAV: { id: ConsoleSection; label: string; icon: LucideIcon }[] = [
  { id: "secrets", label: "Secrets", icon: KeyRound },
  { id: "access", label: "Access", icon: Users },
  { id: "identities", label: "Identities", icon: Bot },
  { id: "policies", label: "Policies", icon: ScrollText },
  { id: "leases", label: "Leases", icon: Clock },
  { id: "audit", label: "Audit", icon: FileClock },
  { id: "tools", label: "Tools", icon: Wrench },
];

/**
 * HashiCorp-Vault-style developer console chrome: a dark, always-on left nav and a
 * breadcrumb top bar. Presentation only — every section still runs through the same
 * zero-knowledge client, so the server never sees keys or plaintext.
 */
export function ConsoleShell({
  section,
  onSection,
  vaultName,
  statusLabel,
  onLock,
  actions,
  children,
}: {
  section: ConsoleSection;
  onSection: (s: ConsoleSection) => void;
  vaultName?: string;
  statusLabel: string;
  onLock: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const current = NAV.find((n) => n.id === section)?.label ?? "";

  return (
    <div className="flex min-h-screen bg-muted/30">
      <aside className="sticky top-0 flex h-screen w-14 shrink-0 flex-col bg-zinc-950 text-zinc-400 md:w-56">
        <div className="flex h-14 items-center gap-2 px-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-[#FFEC6E] text-sm font-black text-zinc-950">
            A
          </span>
          <span className="hidden font-semibold text-zinc-100 md:inline">arc-vault</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onSection(id)}
              title={label}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border-l-2 border-transparent px-2.5 py-2 text-sm transition-colors hover:bg-zinc-900 hover:text-zinc-100",
                section === id && "border-[#FFEC6E] bg-zinc-900 text-zinc-50",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden md:inline">{label}</span>
            </button>
          ))}
        </nav>
        <div className="hidden items-center gap-2 px-4 py-3 text-xs text-zinc-500 md:flex">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          {statusLabel}
        </div>
      </aside>

      <div className="flex min-h-screen flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/80 px-4 backdrop-blur">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-medium">{current}</span>
            {vaultName && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <span className="truncate text-muted-foreground">{vaultName}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <Button variant="outline" size="sm" onClick={onLock}>
              <Lock className="h-4 w-4" /> Lock
            </Button>
            <ThemeCustomizer />
          </div>
        </header>
        <main className="flex-1 px-4 py-6">
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
