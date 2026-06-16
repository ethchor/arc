"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileClock,
  Fingerprint,
  GitBranch,
  KeyRound,
  Lock,
  PanelLeft,
  RefreshCw,
  Rows3,
  ScrollText,
  Search,
  Shield,
  ShieldCheck,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeCustomizer } from "@/components/theme-customizer";
import { HoneycombMark } from "@/components/brand/honeycomb-mark";
import { SegmentedControl } from "@/components/arc/segmented-control";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { CommandPalette, type CommandItem } from "@/components/vault/command-palette";
import { cn } from "@/lib/utils";

export type Persona = "person" | "operator";
export type Density = "comfortable" | "compact";

/** The full nav surface across the two personas. `preview: true` marks design screens
 *  whose engine API isn't wired yet (rendered via PreviewScreen in vault-app). */
export type ConsoleSection =
  | "home"
  | "vault"
  | "security"
  | "devices"
  | "team"
  | "kv"
  | "creds"
  | "transit"
  | "pki"
  | "policies"
  | "workflows"
  | "leases"
  | "audit"
  | "agents"
  | "tools";

type NavEntry = { group: string } | { id: ConsoleSection; label: string; icon: LucideIcon };

const NAV: Record<Persona, NavEntry[]> = {
  // Personal = Engine B (the human vault) + the shared team vault.
  person: [
    { group: "You" },
    { id: "home", label: "Home", icon: Activity },
    { id: "vault", label: "My vault", icon: Lock },
    { id: "security", label: "Security", icon: ShieldCheck },
    { id: "devices", label: "Devices", icon: Fingerprint },
    { group: "Shared" },
    { id: "team", label: "Team vault", icon: Users },
  ],
  // Operator spans two engines — labels make the architecture legible (per the IA decision):
  //   Engine A · Infrastructure, the shared Govern control plane, and Engine C · Agents.
  operator: [
    { group: "Engine A · Infrastructure" },
    { id: "kv", label: "KV secrets", icon: GitBranch },
    { id: "creds", label: "Dynamic creds", icon: KeyRound },
    { id: "transit", label: "Transit", icon: RefreshCw },
    { id: "pki", label: "PKI", icon: Shield },
    { group: "Govern" },
    { id: "policies", label: "Policies", icon: ScrollText },
    { id: "workflows", label: "Workflows", icon: Workflow },
    { id: "leases", label: "Leases", icon: Clock },
    { id: "audit", label: "Audit log", icon: FileClock },
    { group: "Engine C · Agents" },
    { id: "agents", label: "Agents · MCP", icon: Bot },
    { id: "tools", label: "Tools", icon: Wrench },
  ],
};

/** First selectable section of a persona (used when switching personas). */
export const PERSONA_HOME: Record<Persona, ConsoleSection> = { person: "home", operator: "kv" };

const ALL_ITEMS: CommandItem[] = (Object.entries(NAV) as [Persona, NavEntry[]][]).flatMap(
  ([persona, entries]) => {
    let group = "";
    const out: CommandItem[] = [];
    for (const e of entries) {
      if ("group" in e) group = e.group;
      else out.push({ id: e.id, label: e.label, group, icon: e.icon, persona });
    }
    return out;
  },
);

const LABELS = Object.fromEntries(ALL_ITEMS.map((i) => [i.id, i.label])) as Record<ConsoleSection, string>;

/**
 * Persona-aware console chrome (arc design system `shell.js`): a theme-aware nav rail with
 * engine-labeled groups, a top bar with the persona switch + density + ⌘K + lock, and a
 * collapsible rail. Presentation only — every section still runs through the same
 * zero-knowledge client.
 */
export function ConsoleShell({
  persona,
  onPersona,
  section,
  onSection,
  density,
  onDensity,
  vaultName,
  statusLabel,
  onLock,
  actions,
  children,
}: {
  persona: Persona;
  onPersona: (p: Persona) => void;
  section: ConsoleSection;
  onSection: (s: ConsoleSection) => void;
  density: Density;
  onDensity: (d: Density) => void;
  vaultName?: string;
  statusLabel: string;
  onLock: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const current = LABELS[section] ?? "";

  const selectFromPalette = (item: CommandItem) => {
    if (item.persona !== persona) onPersona(item.persona);
    onSection(item.id as ConsoleSection);
  };

  return (
    <div className="flex min-h-[100dvh] bg-muted/20" data-density={density}>
      <aside
        className={cn(
          "sticky top-0 flex h-[100dvh] shrink-0 flex-col border-r border-border bg-background transition-[width] [transition-duration:var(--dur-base)] ease-out-quart",
          collapsed ? "w-[60px]" : "w-[232px]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border/60 px-4">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/25">
            <HoneycombMark className="h-[18px] w-[18px]" />
          </span>
          {!collapsed ? <span className="font-display text-lg font-semibold tracking-tight">arc</span> : null}
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 py-2.5">
          {NAV[persona].map((e, i) =>
            "group" in e ? (
              !collapsed ? (
                <div
                  key={`g${i}`}
                  className="px-2 pb-1.5 pt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70"
                >
                  {e.group}
                </div>
              ) : (
                <div key={`g${i}`} className="mx-2 my-2 border-t border-border/50" />
              )
            ) : (
              <NavItem
                key={e.id}
                icon={e.icon}
                label={e.label}
                active={section === e.id}
                collapsed={collapsed}
                onClick={() => onSection(e.id)}
              />
            ),
          )}
        </nav>

        <div className="shrink-0 border-t border-border/60 px-3 py-3">
          <div className={cn("flex items-center gap-2 font-mono text-[11px] text-muted-foreground", collapsed && "justify-center")}>
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            {!collapsed ? statusLabel : null}
          </div>
        </div>
      </aside>

      <div className="flex min-h-[100dvh] flex-1 flex-col">
        <header
          className="sticky top-0 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/60"
          style={{ zIndex: "var(--z-sticky)" as React.CSSProperties["zIndex"] }}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label="Toggle navigation"
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 max-w-[420px] flex-1 items-center gap-2.5 rounded-md border border-input bg-[var(--surface-inset)] px-3 text-sm text-muted-foreground transition-colors hover:border-ring/40"
          >
            <Search className="h-4 w-4" />
            <span className="flex-1 truncate text-left">Search secrets, paths, actions…</span>
            <kbd className="rounded border bg-background px-1.5 font-mono text-[10px]">⌘K</kbd>
          </button>

          <div className="hidden items-center gap-1.5 text-sm md:flex">
            <span className="font-medium tracking-tight">{current}</span>
            {vaultName ? (
              <>
                <span className="text-muted-foreground/40">/</span>
                <span className="truncate text-muted-foreground">{vaultName}</span>
              </>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {actions}
            <span className="hidden xl:inline">
              <TrustIndicator kind="zk" />
            </span>
            <SegmentedControl
              size="sm"
              value={persona}
              onChange={(p) => {
                onPersona(p);
                onSection(PERSONA_HOME[p]);
              }}
              options={[
                { value: "person", label: "Personal" },
                { value: "operator", label: "Operator" },
              ]}
            />
            <Button
              variant="ghost"
              size="icon"
              className="hidden h-8 w-8 lg:inline-flex"
              aria-label="Toggle density"
              title={density === "compact" ? "Comfortable" : "Compact"}
              onClick={() => onDensity(density === "compact" ? "comfortable" : "compact")}
            >
              {density === "compact" ? <PanelLeft className="h-4 w-4" /> : <Rows3 className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="sm" onClick={onLock}>
              <Lock className="h-4 w-4" /> Lock
            </Button>
            <ThemeCustomizer />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 data-[density=compact]:py-4" data-density={density}>
          <div className={cn("mx-auto", density === "compact" ? "max-w-6xl" : "max-w-5xl")}>{children}</div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        items={ALL_ITEMS}
        onSelect={selectFromPalette}
      />
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm",
        "transition-[background-color,color] [transition-duration:var(--dur-fast)] ease-out-quart",
        collapsed && "justify-center px-0",
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {active ? (
        <span className="absolute -left-2.5 top-1.5 bottom-1.5 w-[3px] rounded-r bg-primary" />
      ) : null}
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!collapsed ? <span className="truncate">{label}</span> : null}
    </button>
  );
}
