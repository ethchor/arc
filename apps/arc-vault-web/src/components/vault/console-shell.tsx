"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Bot, Clock, FileClock, KeyRound, Lock, ScrollText, Users, Workflow, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeCustomizer } from "@/components/theme-customizer";
import { cn } from "@/lib/utils";

export type ConsoleSection =
  | "secrets"
  | "access"
  | "identities"
  | "policies"
  | "workflows"
  | "leases"
  | "audit"
  | "tools";

const NAV: { id: ConsoleSection; label: string; icon: LucideIcon }[] = [
  { id: "secrets", label: "Secrets", icon: KeyRound },
  { id: "access", label: "Access", icon: Users },
  { id: "identities", label: "Identities", icon: Bot },
  { id: "policies", label: "Policies", icon: ScrollText },
  { id: "workflows", label: "Workflows", icon: Workflow },
  { id: "leases", label: "Leases", icon: Clock },
  { id: "audit", label: "Audit", icon: FileClock },
  { id: "tools", label: "Tools", icon: Wrench },
];

/**
 * HashiCorp-Vault-style developer console chrome: a dark, always-on left nav and a
 * breadcrumb top bar. Presentation only. Every section still runs through the same
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
    <div className="flex min-h-[100dvh] bg-muted/30">
      <aside className="sticky top-0 flex h-[100dvh] w-14 shrink-0 flex-col border-r border-zinc-900/60 bg-zinc-950 text-zinc-400 md:w-56">
        <div className="flex h-14 items-center gap-2.5 px-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#FFEC6E] text-sm font-black tracking-tight text-zinc-950 shadow-[inset_0_-1px_0_rgba(0,0,0,0.18)]">
            A
          </span>
          <span className="hidden text-[15px] font-semibold tracking-tight text-zinc-50 md:inline">
            arc
            <span className="ml-1 text-zinc-400">vault</span>
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = section === id;
            return (
              <button
                key={id}
                onClick={() => onSection(id)}
                title={label}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border-l-2 border-transparent px-2.5 py-2 text-sm",
                  "transition-[background-color,color,border-color,transform] [transition-duration:var(--dur-fast)] ease-out-quart",
                  "active:scale-[0.99]",
                  "hover:bg-zinc-900/80 hover:text-zinc-100",
                  active && "border-[#FFEC6E] bg-zinc-900 text-zinc-50",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden md:inline">{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="hidden items-center gap-2 px-4 py-3 font-mono text-[11px] tracking-tight text-zinc-500 md:flex">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          {statusLabel}
        </div>
      </aside>

      <div className="flex min-h-[100dvh] flex-1 flex-col">
        <header
          className="sticky top-0 flex h-14 items-center justify-between border-b border-border/60 bg-background/75 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/55"
          style={{ zIndex: "var(--z-sticky)" as React.CSSProperties["zIndex"] }}
        >
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-medium tracking-tight">{current}</span>
            {vaultName && (
              <>
                <span className="text-muted-foreground/40">/</span>
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
