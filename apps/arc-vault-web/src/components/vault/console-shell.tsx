"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  Clock,
  FileClock,
  Fingerprint,
  GitBranch,
  KeyRound,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Shield,
  ShieldCheck,
  UserRound,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { DUR, EASE } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { ThemeCustomizer } from "@/components/theme-customizer";
import { HoneycombMark } from "@/components/brand/honeycomb-mark";
import { SegmentedControl } from "@/components/arc/segmented-control";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { IconTip } from "@/components/ui/tooltip";
import { CommandPalette, type CommandItem } from "@/components/vault/command-palette";
import { CompactTabBar, type CompactTab } from "@/components/vault/compact-tab-bar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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

type NavEntry =
  | { group: string }
  | { id: ConsoleSection; label: string; icon: LucideIcon; hint: string };

const NAV: Record<Persona, NavEntry[]> = {
  // Personal = Engine B (the human vault) + the shared team vault. Each `hint` is the
  // one-line tooltip description shown beside the icon (and is the only label when the
  // rail is collapsed to icons).
  person: [
    { group: "You" },
    { id: "home", label: "Home", icon: Activity, hint: "Security score, recent items & quick actions." },
    { id: "vault", label: "My Vault", icon: Lock, hint: "Your logins, one-time codes, notes & secrets." },
    { id: "security", label: "Security", icon: ShieldCheck, hint: "Weak/reused password audit — computed on this device." },
    { id: "devices", label: "Devices", icon: Fingerprint, hint: "Devices that can unlock your vault; approve or revoke." },
    { group: "Shared" },
    { id: "team", label: "Team Vault", icon: Users, hint: "A vault shared with your team, end-to-end encrypted." },
  ],
  // Operator spans two engines — labels make the architecture legible (per the IA decision):
  //   Engine A · Infrastructure, the shared Govern control plane, and Engine C · Agents.
  operator: [
    { group: "Engine A · Infrastructure" },
    { id: "kv", label: "KV Secrets", icon: GitBranch, hint: "Versioned key/value secrets with history & diff." },
    { id: "creds", label: "Dynamic Creds", icon: KeyRound, hint: "Short-lived credentials minted on demand." },
    { id: "transit", label: "Transit", icon: RefreshCw, hint: "Encrypt/decrypt & sign as a service — keys never leave." },
    { id: "pki", label: "PKI", icon: Shield, hint: "Issue and manage short-lived certificates." },
    { group: "Govern" },
    { id: "policies", label: "Policies", icon: ScrollText, hint: "Who can do what — access rules across engines." },
    { id: "workflows", label: "Workflows", icon: Workflow, hint: "Approval and automation flows." },
    { id: "leases", label: "Leases", icon: Clock, hint: "Active leases and their time-to-live." },
    { id: "audit", label: "Audit Log", icon: FileClock, hint: "Tamper-evident record of every action." },
    { group: "Engine C · Agents" },
    { id: "agents", label: "Agents · MCP", icon: Bot, hint: "AI agents and their scoped MCP tool access." },
    { id: "tools", label: "Tools", icon: Wrench, hint: "Operator utilities and one-off actions." },
  ],
};

/** First selectable section of a persona (used when switching personas). */
export const PERSONA_HOME: Record<Persona, ConsoleSection> = { person: "home", operator: "kv" };

/**
 * Sections that read better in a centered, measure-constrained column: landing/dashboard
 * pages and the not-yet-wired preview cards. Everything else (master-detail vaults, the KV
 * browser, tables, the security grid) is a working surface that wants the full width — the
 * design kit shows those edge-to-edge, and `max-w-5xl` was visibly cramping them.
 */
const CONTAINED_SECTIONS = new Set<ConsoleSection>([
  "home",
  "tools",
  "creds",
  "transit",
  "pki",
  "leases",
]);

/**
 * Sections that render their own full-height chrome and go edge-to-edge: the master-detail
 * vault fills the viewport below the top bar with no page gutter and no outer card —
 * exactly like the design kit's `Vault` screen. The shell drops `<main>`'s padding +
 * max-width and threads a flex/min-h-0 height chain down to the view; everything else keeps
 * the padded, measure-constrained column.
 */
const FLUSH_SECTIONS = new Set<ConsoleSection>(["vault"]);

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
 * Compact-width tab sets (docs/18 D4). Five or fewer destinations per persona (HIG Tab bars),
 * single-word labels; every other section is one tap away in the "All sections" sheet.
 */
const COMPACT_TABS: Record<Persona, CompactTab<ConsoleSection>[]> = {
  person: [
    { id: "home", label: "Home", icon: Activity },
    { id: "vault", label: "Vault", icon: Lock },
    { id: "security", label: "Security", icon: ShieldCheck },
    { id: "devices", label: "Devices", icon: Fingerprint },
  ],
  operator: [
    { id: "kv", label: "KV", icon: GitBranch },
    { id: "creds", label: "Creds", icon: KeyRound },
    { id: "leases", label: "Leases", icon: Clock },
    { id: "audit", label: "Audit", icon: FileClock },
  ],
};

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

/** Scroll-down minimizes, scroll-up (or reaching the top) restores — HIG tab bar behavior. */
function useMinimizeOnScroll(enabled: boolean): boolean {
  const [minimized, setMinimized] = React.useState(false);
  React.useEffect(() => {
    if (!enabled) {
      setMinimized(false);
      return;
    }
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y < 24) setMinimized(false);
      else if (y > last + 6) setMinimized(true);
      else if (y < last - 6) setMinimized(false);
      last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [enabled]);
  return minimized;
}

/**
 * Persona-aware console chrome in the Liquid Glass layout (docs/18 §4.1–4.2). Functional layer:
 * a floating glass sidebar (regular widths) or a floating glass tab bar plus an "All sections"
 * sheet (compact widths), and a floating glass toolbar over a scroll-edge effect. Content
 * layer: the arc mesh and every view beneath them. Presentation only — every section still
 * runs through the same zero-knowledge client.
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
  const [sectionsOpen, setSectionsOpen] = React.useState(false);
  const compact = useMediaQuery("(max-width: 639px)");
  const minimized = useMinimizeOnScroll(compact);

  // HIG (Sidebars, macOS): collapse the sidebar automatically as the window narrows, and
  // restore it when there's room again. A manual toggle still wins until the next crossing.
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 1099px)");
    const sync = () => setCollapsed(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // ⌃⌘S — the macOS-standard Show/Hide Sidebar shortcut.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.metaKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = LABELS[section] ?? "";
  const flush = FLUSH_SECTIONS.has(section);

  const selectFromPalette = (item: CommandItem) => {
    if (item.persona !== persona) onPersona(item.persona);
    onSection(item.id as ConsoleSection);
  };

  const switchPersona = (p: Persona) => {
    onPersona(p);
    onSection(PERSONA_HOME[p]);
  };

  return (
    <div
      className="bg-arc-mesh flex min-h-[100dvh]"
      data-density={density}
      // The mesh is content-layer color that the glass picks up; keep it put while content scrolls.
      style={{ backgroundAttachment: "fixed" }}
    >
      <aside
        aria-label="Sidebar"
        className={cn(
          "sticky top-0 hidden h-[100dvh] shrink-0 pb-[max(var(--glass-inset),env(safe-area-inset-bottom))] pl-[max(var(--glass-inset),env(safe-area-inset-left))] pt-[max(var(--glass-inset),env(safe-area-inset-top))] transition-[width] [transition-duration:var(--dur-base)] ease-out-quart sm:block",
          collapsed ? "w-[76px]" : "w-[256px]",
        )}
        style={{ zIndex: "var(--z-sticky)" as React.CSSProperties["zIndex"] }}
      >
        <div className="glass glass-strong flex h-full flex-col overflow-hidden rounded-[var(--radius-2xl)]">
          <div className={cn("flex h-14 shrink-0 items-center gap-2.5", collapsed ? "justify-center" : "px-4")}>
            <BrandTile />
            {!collapsed ? <span className="font-display text-lg font-semibold tracking-tight">arc</span> : null}
          </div>
          <SidebarBody
            collapsed={collapsed}
            persona={persona}
            section={section}
            statusLabel={statusLabel}
            onSection={onSection}
            onPersona={switchPersona}
          />
        </div>
      </aside>

      <div className="flex min-h-[100dvh] min-w-0 flex-1 flex-col">
        {/* Floating toolbar (HIG Toolbars): at most three glass groups — navigation + title on
            the leading edge, search and actions on the trailing edge — above a scroll-edge
            effect instead of a solid bar. Icon-only items carry accessible names. On compact
            widths search moves to the tab bar. */}
        <header
          className="sticky top-0 pb-3 pl-[max(var(--glass-inset),env(safe-area-inset-left))] pr-[max(var(--glass-inset),env(safe-area-inset-right))] pt-[max(var(--glass-inset),env(safe-area-inset-top))]"
          style={{ zIndex: "var(--z-sticky)" as React.CSSProperties["zIndex"] }}
        >
          <div aria-hidden className="scroll-edge pointer-events-none absolute inset-x-0 -bottom-4 top-0" />
          <div className="relative flex items-center gap-2">
            <div className="glass flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-full pl-4 pr-4 sm:flex-none sm:pl-1">
              <IconTip
                label={collapsed ? "Show Sidebar" : "Hide Sidebar"}
                hint="Switch the sidebar between labels and icons."
                shortcut="⌃⌘S"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden h-9 w-9 shrink-0 rounded-full sm:inline-flex"
                  aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsed((c) => !c)}
                >
                  {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
              </IconTip>
              <h1 className="truncate text-headline tracking-tight">{current}</h1>
              {vaultName ? (
                <span className="hidden truncate text-callout text-muted-foreground sm:inline">· {vaultName}</span>
              ) : null}
            </div>

            <div className="hidden flex-1 sm:block" />

            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search secrets, paths and actions"
              className="glass hidden h-11 w-11 shrink-0 items-center justify-center gap-2.5 rounded-full text-sm text-muted-foreground transition-colors hover:text-foreground sm:flex md:w-[min(340px,32vw)] md:justify-start md:px-4"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="hidden flex-1 truncate text-left md:inline">Search secrets, paths, actions…</span>
              <kbd className="hidden rounded-md border border-border/60 bg-background/40 px-1.5 font-mono text-[10px] lg:inline">
                ⌘K
              </kbd>
            </button>

            <div className="glass flex h-11 shrink-0 items-center gap-0.5 rounded-full px-1">
              {actions}
              <ThemeCustomizer density={density} onDensity={onDensity} className="rounded-full" />
              <IconTip label="Lock" hint="Wipe the keys from memory and lock the vault.">
                <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full" aria-label="Lock vault" onClick={onLock}>
                  <Lock className="h-4 w-4" />
                </Button>
              </IconTip>
            </div>
          </div>
        </header>

        <main
          className={cn(
            "flex-1",
            // Flush sections fill the viewport below the toolbar (flex column, no page gutter);
            // every other section keeps the padded, density-aware rhythm. On compact widths the
            // floating tab bar needs clearance at the bottom.
            flush
              ? "flex min-h-0 flex-col max-sm:pb-[calc(env(safe-area-inset-bottom)+5.5rem)]"
              : "px-4 pb-6 pt-2 data-[density=compact]:pb-4 max-sm:pb-[calc(env(safe-area-inset-bottom)+6.5rem)] lg:px-6",
          )}
          data-density={density}
        >
          <div
            className={cn(
              "mx-auto w-full",
              flush
                ? "flex min-h-0 flex-1 flex-col"
                : // Contained pages keep a reading measure; working surfaces fill the width
                  // (capped on ultra-wide displays so content doesn't sprawl past ~1760px).
                  CONTAINED_SECTIONS.has(section)
                  ? density === "compact"
                    ? "max-w-6xl"
                    : "max-w-5xl"
                  : "max-w-[1760px]",
            )}
          >
            {/* Section crossfade. `mode="wait"` keeps the leaving + entering views from
                stacking in flow (no layout jump); `initial={false}` skips the fade on the
                first paint after unlock so it doesn't double up with the unlock→vault
                transition. Reduced-motion users get an instant swap via MotionConfig. */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={section}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: DUR.fast, ease: EASE.outQuart }}
                className={cn(flush && "flex min-h-0 flex-1 flex-col")}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      {compact ? (
        <CompactTabBar
          tabs={COMPACT_TABS[persona]}
          current={section}
          onSelect={onSection}
          onShowAll={() => setSectionsOpen(true)}
          onSearch={() => setPaletteOpen(true)}
          minimized={minimized}
        />
      ) : null}

      {/* The adaptable sidebar on compact widths: every section, the persona switch and status,
          presented as a sheet from the tab bar's leading button. */}
      <Dialog open={sectionsOpen} onOpenChange={setSectionsOpen}>
        <DialogContent className="max-h-[80dvh] gap-0 overflow-y-auto p-0 pb-2 sm:max-w-sm">
          <div className="flex items-center gap-2.5 px-5 pb-1 pt-5">
            <BrandTile />
            <DialogTitle className="font-display text-lg font-semibold tracking-tight">All Sections</DialogTitle>
          </div>
          <DialogDescription className="sr-only">Every section of the console, and the persona switch.</DialogDescription>
          <SidebarBody
            collapsed={false}
            persona={persona}
            section={section}
            statusLabel={statusLabel}
            onSection={(s) => {
              onSection(s);
              setSectionsOpen(false);
            }}
            onPersona={(p) => switchPersona(p)}
          />
        </DialogContent>
      </Dialog>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        items={ALL_ITEMS}
        onSelect={selectFromPalette}
      />
    </div>
  );
}

function BrandTile() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/15 text-primary ring-1 ring-primary/25">
      <HoneycombMark className="h-[19px] w-[19px]" />
    </span>
  );
}

/** Persona switch, engine-labeled groups and status — shared by the sidebar and the compact sheet. */
function SidebarBody({
  collapsed,
  persona,
  section,
  statusLabel,
  onSection,
  onPersona,
}: {
  collapsed: boolean;
  persona: Persona;
  section: ConsoleSection;
  statusLabel: string;
  onSection: (s: ConsoleSection) => void;
  onPersona: (p: Persona) => void;
}) {
  return (
    <>
      <div className={cn("shrink-0 pb-1", collapsed ? "flex justify-center" : "px-3")}>
        {collapsed ? (
          <IconTip
            label={persona === "person" ? "Switch to Operator" : "Switch to Personal"}
            hint="Personal is your vault; Operator is infrastructure, governance and agents."
            side="right"
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full"
              aria-label={persona === "person" ? "Switch to Operator" : "Switch to Personal"}
              onClick={() => onPersona(persona === "person" ? "operator" : "person")}
            >
              {persona === "person" ? <UserRound className="h-4 w-4" /> : <Server className="h-4 w-4" />}
            </Button>
          </IconTip>
        ) : (
          <SegmentedControl
            aria-label="Persona"
            size="sm"
            fill
            value={persona}
            onChange={onPersona}
            options={[
              { value: "person", label: "Personal" },
              { value: "operator", label: "Operator" },
            ]}
          />
        )}
      </div>

      <nav aria-label="Sections" className="flex-1 overflow-y-auto px-2.5 pb-2.5">
        {NAV[persona].map((e, i) =>
          "group" in e ? (
            !collapsed ? (
              <div key={`g${i}`} className="px-2.5 pb-1 pt-4 text-footnote font-semibold text-muted-foreground">
                {e.group}
              </div>
            ) : (
              <div key={`g${i}`} className="mx-2 my-2.5 border-t border-border/50" />
            )
          ) : (
            <NavItem
              key={e.id}
              icon={e.icon}
              label={e.label}
              hint={e.hint}
              active={section === e.id}
              collapsed={collapsed}
              onClick={() => onSection(e.id)}
            />
          ),
        )}
      </nav>

      <div className={cn("shrink-0 px-3.5 py-3", collapsed && "flex justify-center px-0")}>
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inset-0 rounded-full bg-emerald-500/60 motion-safe:animate-ping" />
            <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          {!collapsed ? statusLabel : null}
        </div>
        {!collapsed ? <TrustIndicator kind="zk" className="mt-2" /> : null}
      </div>
    </>
  );
}

function NavItem({
  icon: Icon,
  label,
  hint,
  active,
  collapsed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  // HIG Sidebars: icons carry the accent color; the selected row is a filled, concentric
  // highlight (sidebar radius 22px minus the 10px inset) rather than an edge marker.
  return (
    <IconTip label={label} hint={hint} side="right">
      <button
        onClick={onClick}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-[12px] px-2.5 py-2 text-sm",
          "transition-[background-color,color] [transition-duration:var(--dur-fast)] ease-out-quart",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          collapsed && "justify-center px-0",
          active
            ? "bg-primary/[0.14] font-medium text-foreground"
            : "text-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground",
        )}
      >
        <Icon className="h-[18px] w-[18px] shrink-0 text-primary" />
        {!collapsed ? <span className="truncate">{label}</span> : null}
      </button>
    </IconTip>
  );
}
