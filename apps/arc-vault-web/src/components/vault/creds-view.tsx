"use client";

import * as React from "react";
import {
  ChevronDown,
  Clock,
  Database,
  KeyRound,
  Plus,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import type { IssuedCredentialWire, VaultClient } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IconTip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/arc/copy-button";
import { MaskedField } from "@/components/arc/masked-field";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { cn } from "@/lib/utils";

/**
 * Operator Dynamic-credentials browser. Lists every dynamic-secrets mount (database,
 * AWS, GCP, GitHub App, plugin-backed engines, …), shows the configured roles per mount,
 * and ceremonially mints credentials with a session-scoped lease tracker that lets the
 * operator renew or revoke the leases they just issued.
 *
 * The lease tracker is intentionally session-scoped: persisting a global cross-session
 * lease list would need server-side lease browsing, which arc's LeaseManager doesn't
 * currently expose over HTTP. Today's leases the operator can see are the ones they
 * minted in this tab — which is the typical "issue → use → revoke" workflow.
 */

type EngineState = "loading" | "no-mount" | "error" | "ready";

interface SessionLease {
  /** arc-internal lease id (the renew/revoke handle). */
  leaseId: string;
  mount: string;
  role: string;
  /** Engine credential payload at issue time (passwords, tokens, …) — kept so the user
   *  can still copy after navigation. Cleared when revoked. */
  data: Record<string, unknown> | null;
  /** Local epoch-ms when the lease expires; recomputed on each renew. */
  expiresAt: number;
  renewable: boolean;
  /** Latest server-supplied duration (seconds) — used as the default renew increment. */
  durationSeconds: number;
  state: "active" | "revoking" | "revoked";
}

export function CredsView({ getClient }: { getClient: () => VaultClient }) {
  const [engineState, setEngineState] = React.useState<EngineState>("loading");
  const [engineError, setEngineError] = React.useState<string | null>(null);
  const [mounts, setMounts] = React.useState<Array<{ path: string; type: string }>>([]);
  const [mount, setMount] = React.useState<string>("");
  const [roles, setRoles] = React.useState<string[]>([]);
  const [rolesBusy, setRolesBusy] = React.useState(false);
  const [leases, setLeases] = React.useState<SessionLease[]>([]);
  // Tick once a second so the per-lease countdown re-renders without per-row timers.
  const [, setTick] = React.useState(0);

  const loadMount = React.useCallback(
    async (preferred?: string) => {
      setEngineState("loading");
      setEngineError(null);
      try {
        const ms = await getClient().listMounts();
        setMounts(ms);
        const dyn = ms.filter((m) => isDynamicMountType(m.type));
        if (dyn.length === 0) {
          setEngineState("no-mount");
          return;
        }
        const chosen = preferred && dyn.find((m) => m.path === preferred) ? preferred : dyn[0]!.path;
        setMount(chosen);
        setEngineState("ready");
      } catch (err) {
        setEngineError((err as Error).message);
        setEngineState("error");
      }
    },
    [getClient],
  );

  React.useEffect(() => {
    void loadMount();
  }, [loadMount]);

  // Load roles whenever the active mount changes.
  React.useEffect(() => {
    if (!mount) {
      setRoles([]);
      return;
    }
    let alive = true;
    setRolesBusy(true);
    setRoles([]);
    getClient()
      .credsListRoles(mount)
      .then((rs) => {
        if (alive) setRoles([...rs].sort());
      })
      .catch((err) => alive && toast.error((err as Error).message))
      .finally(() => alive && setRolesBusy(false));
    return () => {
      alive = false;
    };
  }, [getClient, mount]);

  // 1s tick — only runs while there's at least one active lease to count down.
  React.useEffect(() => {
    if (!leases.some((l) => l.state === "active")) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [leases]);

  const onIssue = async (role: string) => {
    try {
      const r = await getClient().credsIssue(mount, role);
      setLeases((prev) => [issuedToSession(mount, role, r), ...prev]);
      toast.success(`Minted ${role}`);
      return r;
    } catch (err) {
      toast.error((err as Error).message);
      throw err;
    }
  };

  const onRenew = async (leaseId: string) => {
    try {
      const r = await getClient().credsRenewLease(leaseId);
      setLeases((prev) =>
        prev.map((l) =>
          l.leaseId === leaseId
            ? {
                ...l,
                expiresAt: Date.now() + r.leaseDurationSeconds * 1000,
                durationSeconds: r.leaseDurationSeconds,
                renewable: r.renewable,
              }
            : l,
        ),
      );
      toast.success(`Renewed — ${formatTtl(r.leaseDurationSeconds)} left`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onRevoke = async (leaseId: string) => {
    setLeases((prev) => prev.map((l) => (l.leaseId === leaseId ? { ...l, state: "revoking" } : l)));
    try {
      await getClient().credsRevokeLease(leaseId);
      setLeases((prev) =>
        prev.map((l) => (l.leaseId === leaseId ? { ...l, state: "revoked", data: null } : l)),
      );
      toast.success("Revoked");
    } catch (err) {
      setLeases((prev) => prev.map((l) => (l.leaseId === leaseId ? { ...l, state: "active" } : l)));
      toast.error((err as Error).message);
    }
  };

  if (engineState === "loading") {
    return (
      <ChromeShell mount={mount || "—"} mounts={mounts} onSelectMount={loadMount}>
        <div className="grid min-h-[420px] place-items-center rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] text-sm text-muted-foreground">
          Loading dynamic-secrets mounts…
        </div>
      </ChromeShell>
    );
  }
  if (engineState === "no-mount") {
    return (
      <ChromeShell mount="—" mounts={mounts} onSelectMount={loadMount}>
        <EmptyEngineState
          title="No dynamic-secrets mount configured"
          body="Engine A is reachable but no database / cloud / SCM / plugin engine is mounted on this arc-server. Start a colocated OpenBao (and arc auto-mounts `database/`) or install an arc plugin that registers a dynamic engine."
          retry={() => loadMount()}
        />
      </ChromeShell>
    );
  }
  if (engineState === "error") {
    return (
      <ChromeShell mount="—" mounts={mounts} onSelectMount={loadMount}>
        <EmptyEngineState
          title="Couldn’t load the dynamic-secrets engines"
          body={engineError ?? "Most often this is the engine being temporarily unreachable."}
          retry={() => loadMount()}
        />
      </ChromeShell>
    );
  }
  return (
    <ChromeShell mount={mount} mounts={mounts} onSelectMount={loadMount}>
      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <RolesPanel
          mount={mount}
          roles={roles}
          busy={rolesBusy}
          onIssue={onIssue}
        />
        <LeasesPanel leases={leases} onRenew={onRenew} onRevoke={onRevoke} />
      </div>
      <Footer />
    </ChromeShell>
  );
}

function ChromeShell({
  mount,
  mounts,
  onSelectMount,
  children,
}: {
  mount: string;
  mounts: Array<{ path: string; type: string }>;
  onSelectMount: (path: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Engine A · infrastructure
          </span>
          <h1 className="font-display text-2xl font-medium tracking-tight">Dynamic credentials</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Mint short-lived credentials under a role — database users, cloud STS tuples,
            GitHub App tokens — governed by a lease. Revoke at any time; renew until the
            backend's max TTL.
          </p>
        </div>
        <MountSelector mount={mount} mounts={mounts} onSelect={onSelectMount} />
      </div>
      {children}
    </div>
  );
}

function MountSelector({
  mount,
  mounts,
  onSelect,
}: {
  mount: string;
  mounts: Array<{ path: string; type: string }>;
  onSelect: (path: string) => void;
}) {
  const dyn = mounts.filter((m) => isDynamicMountType(m.type));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-2.5 py-1.5 text-sm transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Database className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-[12px]">{mount}</span>
          <Badge variant="secondary" className="ml-1 text-[10px] uppercase tracking-wide">
            {mounts.find((m) => m.path === mount)?.type ?? "—"}
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[260px]">
        <DropdownMenuLabel>Dynamic-secrets mounts</DropdownMenuLabel>
        {dyn.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            No mounts.
          </DropdownMenuItem>
        ) : (
          dyn.map((m) => (
            <DropdownMenuItem
              key={m.path}
              onSelect={() => onSelect(m.path)}
              className="flex items-center gap-2"
            >
              <Database className="h-3.5 w-3.5 text-primary" />
              <span className="flex-1 truncate font-mono text-[12px]">{m.path}</span>
              <Badge variant="secondary" className="text-[10px] uppercase">
                {m.type}
              </Badge>
              {m.path === mount ? <Badge variant="secondary">current</Badge> : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyEngineState({ title, body, retry }: { title: string; body: string; retry: () => void }) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-border bg-[var(--surface-base)] p-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
        <KeyRound className="h-5 w-5" />
      </span>
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        <RotateCcw className="h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Roles panel — pick a role, click Issue, see the ceremony
// ────────────────────────────────────────────────────────────────────────────────

function RolesPanel({
  mount,
  roles,
  busy,
  onIssue,
}: {
  mount: string;
  roles: string[];
  busy: boolean;
  onIssue: (role: string) => Promise<IssuedCredentialWire>;
}) {
  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? roles.filter((r) => r.toLowerCase().includes(q)) : roles;
  }, [roles, query]);

  return (
    <aside className="flex min-h-0 flex-col rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)]">
      <div className="flex flex-col gap-2.5 border-b border-border/60 p-3.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={roles.length ? `Search ${roles.length} roles…` : "Search roles…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
            Roles · {mount}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {filtered.length}/{roles.length}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {busy ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            {roles.length === 0
              ? "No roles configured on this mount. Roles are CA-/backend-admin config (allowed grants, TTLs) — create one via OpenBao's API or your plugin's config."
              : "No matches."}
          </p>
        ) : (
          <ul className="space-y-1">
            {filtered.map((r) => (
              <li
                key={r}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-raised)] px-3 py-2.5"
              >
                <Shield className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{r}</span>
                <IssueDialog role={r} onIssue={onIssue} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function IssueDialog({
  role,
  onIssue,
}: {
  role: string;
  onIssue: (role: string) => Promise<IssuedCredentialWire>;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<IssuedCredentialWire | null>(null);

  React.useEffect(() => {
    if (open) setResult(null);
  }, [open]);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await onIssue(role);
      setResult(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          <Plus className="h-3.5 w-3.5" /> Issue
        </Button>
      </DialogTrigger>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" /> Credential minted
              </DialogTitle>
              <DialogDescription className="font-mono text-[12px]">
                {role} · expires in {formatTtl(result.leaseDurationSeconds)}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {Object.entries(result.data).map(([k, v]) => (
                <div key={k} className="grid gap-1">
                  <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {k}
                  </span>
                  {looksSecret(k) ? (
                    <MaskedField value={String(v)} />
                  ) : (
                    <div className="flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] pl-3 pr-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                        {String(v)}
                      </span>
                      <CopyButton value={String(v)} iconOnly autoClearSeconds={0} />
                    </div>
                  )}
                </div>
              ))}
              <p className="rounded-[var(--radius-md)] border border-border/60 bg-[var(--surface-inset)] p-2.5 text-[11px] text-muted-foreground">
                Lease <span className="font-mono">{result.leaseId.slice(0, 18)}…</span> tracked on
                the right — renew or revoke from the Active leases panel.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Issue under {role}?</DialogTitle>
              <DialogDescription>
                The engine will mint a fresh credential under this role and return a lease. The
                credential's lifetime is governed by the role's default TTL (you can renew or
                revoke it from the Active leases panel).
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={submit} disabled={busy}>
                <Zap className="h-3.5 w-3.5" /> {busy ? "Issuing…" : "Issue credential"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Leases panel — session-scoped active-lease tracker
// ────────────────────────────────────────────────────────────────────────────────

function LeasesPanel({
  leases,
  onRenew,
  onRevoke,
}: {
  leases: SessionLease[];
  onRenew: (leaseId: string) => Promise<void>;
  onRevoke: (leaseId: string) => Promise<void>;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)]">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <div>
          <h2 className="font-display text-base font-semibold">Active leases</h2>
          <p className="text-[11px] text-muted-foreground">
            Credentials you've minted in this session. Renew before expiry; revoke to clean up.
          </p>
        </div>
        <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
          {leases.filter((l) => l.state === "active").length} active
        </Badge>
      </div>
      {leases.length === 0 ? (
        <p className="px-5 py-12 text-center text-sm text-muted-foreground">
          No leases minted yet. Pick a role on the left and hit Issue.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {leases.map((l) => (
            <LeaseRow key={l.leaseId} lease={l} onRenew={onRenew} onRevoke={onRevoke} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LeaseRow({
  lease,
  onRenew,
  onRevoke,
}: {
  lease: SessionLease;
  onRenew: (leaseId: string) => Promise<void>;
  onRevoke: (leaseId: string) => Promise<void>;
}) {
  const remainingMs = Math.max(0, lease.expiresAt - Date.now());
  const expired = lease.state === "active" && remainingMs === 0;
  const expiresLabel = lease.state === "revoked" ? "revoked" : expired ? "expired" : formatTtl(Math.floor(remainingMs / 1000));
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <IconTip label="Lease ID" hint={lease.leaseId} side="top">
            <span className="font-mono text-[12px] font-medium">
              {lease.role}
            </span>
          </IconTip>
          <span className="font-mono text-[11px] text-muted-foreground">
            {lease.mount}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {lease.state === "revoked" ? (
            <Badge variant="secondary" className="bg-[var(--danger-subtle)] text-[var(--danger-fg)]">
              revoked
            </Badge>
          ) : expired ? (
            <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
              expired
            </Badge>
          ) : (
            <Badge variant="secondary" className="bg-[var(--success-subtle)] text-[var(--success-fg)]">
              <Clock className="mr-1 h-2.5 w-2.5" /> {expiresLabel}
            </Badge>
          )}
          {lease.renewable ? (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              renewable
            </Badge>
          ) : null}
          <IconTip label="Lease ID" hint={lease.leaseId} side="top">
            <span className="font-mono text-[10px] text-muted-foreground">
              {lease.leaseId.slice(0, 12)}…
            </span>
          </IconTip>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {lease.data && lease.state === "active" ? <CredentialPeekButton lease={lease} /> : null}
        {lease.renewable && lease.state === "active" ? (
          <IconTip label="Renew lease" hint="Ask the engine for another TTL window." side="left">
            <Button variant="ghost" size="sm" onClick={() => onRenew(lease.leaseId)}>
              <RotateCcw className="h-3.5 w-3.5" /> Renew
            </Button>
          </IconTip>
        ) : null}
        {lease.state === "active" ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onRevoke(lease.leaseId)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Revoke
          </Button>
        ) : lease.state === "revoking" ? (
          <span className="text-[11px] text-muted-foreground">revoking…</span>
        ) : null}
      </div>
    </li>
  );
}

function CredentialPeekButton({ lease }: { lease: SessionLease }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <KeyRound className="h-3.5 w-3.5" /> Peek
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {lease.role} · {lease.mount}
          </DialogTitle>
          <DialogDescription>The credential the engine minted at issue time.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {lease.data
            ? Object.entries(lease.data).map(([k, v]) => (
                <div key={k} className="grid gap-1">
                  <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {k}
                  </span>
                  {looksSecret(k) ? (
                    <MaskedField value={String(v)} />
                  ) : (
                    <div className="flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] pl-3 pr-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                        {String(v)}
                      </span>
                      <CopyButton value={String(v)} iconOnly autoClearSeconds={0} />
                    </div>
                  )}
                </div>
              ))
            : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Footer() {
  return (
    <div className="mt-6 flex items-center gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
      <TrustIndicator kind="verified">Engine A · dynamic creds</TrustIndicator>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
        <Sparkles className="h-3 w-3" /> live · leases tracked client-side this session
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

function issuedToSession(mount: string, role: string, r: IssuedCredentialWire): SessionLease {
  return {
    leaseId: r.leaseId,
    mount,
    role,
    data: r.data,
    expiresAt: Date.now() + r.leaseDurationSeconds * 1000,
    renewable: r.renewable,
    durationSeconds: r.leaseDurationSeconds,
    state: "active",
  };
}

/** Engine types that mint dynamic credentials. KV / Transit / PKI are intentionally
 *  excluded — they have their own dedicated views. Unknown types pass through; arc
 *  plugins routinely introduce new strings here. */
function isDynamicMountType(type: string): boolean {
  if (type === "kv-v2" || type === "transit" || type === "pki") return false;
  return true;
}

/** Crude "looks like a secret" classifier — drives whether the value renders as a
 *  reveal-to-see masked field or a plain copyable row. */
function looksSecret(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes("password") || k.includes("secret") || k.includes("token") || k.includes("key") || k === "private_key";
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
