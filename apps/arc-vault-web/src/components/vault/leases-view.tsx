"use client";

import * as React from "react";
import {
  Bot,
  Clock,
  Database,
  KeyRound,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { LeaseWire, VaultClient } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconTip } from "@/components/ui/tooltip";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { cn } from "@/lib/utils";
import { relativeAgo } from "@/lib/datetime";

/**
 * Operator Leases screen. Lists every lease the arc-server LeaseManager is tracking
 * across every engine (database / cloud / SCM / plugin-backed dynamic-secrets engines),
 * regardless of who minted it (human or agent task). Per-row renew + revoke; a state
 * filter for triaging orphans / cleanup.
 *
 * Unlike the Creds screen — which tracks just the leases *you* minted in your session —
 * this is the server-wide truth: useful for cleaning up forgotten leases minted in other
 * tabs, by agents, or by other operators.
 */

type StateFilter = "all" | "active" | "expired" | "revoked";

export function LeasesView({ getClient }: { getClient: () => VaultClient }) {
  const [leases, setLeases] = React.useState<LeaseWire[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<StateFilter>("active");
  const [pending, setPending] = React.useState<string | null>(null);
  // 1s tick — only mounted when at least one lease is active so we don't burn cycles.
  const [, setTick] = React.useState(0);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const ls = await getClient().listLeases();
      setLeases(ls);
    } catch (err) {
      setError((err as Error).message);
      setLeases([]);
    }
  }, [getClient]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!leases || !leases.some((l) => l.state === "active")) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [leases]);

  const onRenew = async (id: string) => {
    setPending(id);
    try {
      const r = await getClient().credsRenewLease(id);
      // Update the row optimistically; refresh in the background to catch any other
      // changes (e.g. someone else just minted a lease).
      setLeases((prev) =>
        prev
          ? prev.map((l) =>
              l.id === id
                ? {
                    ...l,
                    expiresAt: Date.now() + r.leaseDurationSeconds * 1000,
                    ttlSeconds: r.leaseDurationSeconds,
                    renewable: r.renewable,
                    state: "active",
                  }
                : l,
            )
          : prev,
      );
      toast.success(`Renewed — ${formatTtl(r.leaseDurationSeconds)} left`);
      void refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending((p) => (p === id ? null : p));
    }
  };

  const onRevoke = async (id: string) => {
    setPending(id);
    try {
      await getClient().credsRevokeLease(id);
      setLeases((prev) =>
        prev ? prev.map((l) => (l.id === id ? { ...l, state: "revoked", revokedAt: Date.now() } : l)) : prev,
      );
      toast.success("Revoked");
      void refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending((p) => (p === id ? null : p));
    }
  };

  const counts = React.useMemo(() => {
    const out = { all: 0, active: 0, expired: 0, revoked: 0 };
    for (const l of leases ?? []) {
      out.all++;
      out[l.state]++;
    }
    return out;
  }, [leases]);

  const filtered = React.useMemo(() => {
    if (!leases) return [];
    const q = query.trim().toLowerCase();
    return leases.filter((l) => {
      if (filter !== "all" && l.state !== filter) return false;
      if (q && !`${l.id} ${l.mount} ${l.engineType} ${l.backendLeaseId ?? ""}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [leases, query, filter]);

  return (
    <div className="space-y-5">
      <Header />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
          <FilterChip label="All" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterChip label="Active" count={counts.active} active={filter === "active"} onClick={() => setFilter("active")} tone="ok" />
          <FilterChip label="Expired" count={counts.expired} active={filter === "expired"} onClick={() => setFilter("expired")} tone="warn" />
          <FilterChip label="Revoked" count={counts.revoked} active={filter === "revoked"} onClick={() => setFilter("revoked")} tone="danger" />
          <div className="relative ml-2 flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search id, mount, engine type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 pl-8 text-sm"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RotateCcw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        {leases === null ? (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">Loading leases…</p>
        ) : error ? (
          <p className="px-6 py-12 text-center text-sm text-[var(--danger-fg)]">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">
            {leases.length === 0
              ? "No leases tracked yet. Mint credentials from the Dynamic credentials screen and they'll appear here."
              : `No ${filter === "all" ? "" : filter + " "}leases matching “${query}”.`}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {filtered.map((l) => (
              <LeaseRow
                key={l.id}
                lease={l}
                pending={pending === l.id}
                onRenew={() => onRenew(l.id)}
                onRevoke={() => onRevoke(l.id)}
              />
            ))}
          </ul>
        )}
      </Card>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <div className="space-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Govern · leases
      </span>
      <h1 className="font-display text-2xl font-medium tracking-tight">Active leases</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        Every lease the arc-server is tracking across every engine. Renew before expiry to
        extend the credential, or revoke to clean up. This is the server-wide view —
        leases minted by other tabs, other operators, or agent tasks all show up here.
      </p>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)]">
      {children}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: "ok" | "warn" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-[var(--border-strong)] hover:text-foreground",
      )}
    >
      <span className="font-medium">{label}</span>
      <span
        className={cn(
          "rounded-full bg-background/60 px-1.5 font-mono text-[10px]",
          tone === "ok" && count > 0 && !active && "text-[var(--success-fg)]",
          tone === "warn" && count > 0 && !active && "text-amber-700 dark:text-amber-300",
          tone === "danger" && count > 0 && !active && "text-[var(--danger-fg)]",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function LeaseRow({
  lease,
  pending,
  onRenew,
  onRevoke,
}: {
  lease: LeaseWire;
  pending: boolean;
  onRenew: () => void;
  onRevoke: () => void;
}) {
  const remainingMs = Math.max(0, lease.expiresAt - Date.now());
  const ageLabel =
    lease.state === "revoked"
      ? `revoked ${relativeAgo(toIso(lease.revokedAt))}`
      : lease.state === "expired"
        ? `expired ${relativeAgo(toIso(lease.expiresAt))}`
        : formatTtl(Math.floor(remainingMs / 1000));
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <EngineIcon type={lease.engineType} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <IconTip label="Lease ID" hint={lease.id} side="top">
            <span className="font-mono text-[12px] font-medium">
              {lease.id.slice(0, 14)}…
            </span>
          </IconTip>
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
            {lease.engineType}
          </Badge>
          <span className="font-mono text-[11px] text-muted-foreground">{lease.mount}</span>
          {lease.taskId ? (
            <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wide">
              <Bot className="h-3 w-3" /> task
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {lease.state === "active" ? (
            <Badge variant="secondary" className="bg-[var(--success-subtle)] text-[var(--success-fg)]">
              <Clock className="mr-1 h-2.5 w-2.5" /> {ageLabel}
            </Badge>
          ) : lease.state === "expired" ? (
            <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
              {ageLabel}
            </Badge>
          ) : (
            <Badge variant="secondary" className="bg-[var(--danger-subtle)] text-[var(--danger-fg)]">
              {ageLabel}
            </Badge>
          )}
          {lease.renewable ? (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              renewable
            </Badge>
          ) : null}
          <span className="text-[11px] text-muted-foreground">
            issued {relativeAgo(toIso(lease.issuedAt))}
          </span>
          <span className="text-[11px] text-muted-foreground">
            · max {formatTtl(lease.maxTtlSeconds)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {lease.state === "active" && lease.renewable ? (
          <IconTip label="Renew lease" hint="Ask the engine for another TTL window." side="left">
            <Button variant="ghost" size="sm" disabled={pending} onClick={onRenew}>
              <RotateCcw className="h-3.5 w-3.5" /> Renew
            </Button>
          </IconTip>
        ) : null}
        {lease.state === "active" ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={pending}
            onClick={onRevoke}
          >
            <Trash2 className="h-3.5 w-3.5" /> {pending ? "…" : "Revoke"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Tiny icon picker for the row's left badge. Keeps the table scannable when many engine
 *  types coexist (database + transit + a few plugins). */
function EngineIcon({ type }: { type: string }) {
  const Icon =
    type === "database"
      ? Database
      : type === "transit"
        ? KeyRound
        : type === "pki"
          ? KeyRound
          : Database;
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border bg-[var(--surface-raised)] text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function Footer() {
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
      <TrustIndicator kind="verified">Govern · leases</TrustIndicator>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
        <Sparkles className="h-3 w-3" /> live · arc LeaseManager
      </span>
    </div>
  );
}

function toIso(epochMs: number | undefined): string | undefined {
  return epochMs === undefined ? undefined : new Date(epochMs).toISOString();
}

function formatTtl(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds >= 86400) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}
