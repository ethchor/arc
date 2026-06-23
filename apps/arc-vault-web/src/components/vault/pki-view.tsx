"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  KeyRound,
  Plus,
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { PkiIssuedCertificateWire, PkiRoleWire, VaultClient } from "@arc/sdk";
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
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { cn } from "@/lib/utils";
import { relativeAgo } from "@/lib/datetime";

/**
 * Operator PKI browser. Three tabs: roles (the issue-templates the CA accepts), issued
 * certs (the table of serials with read/revoke), and the CA chain (read-only PEM). The
 * issue ceremony is a dialog opened from the header — pick a role, fill CN + TTL + SANs,
 * get back the cert + private key one time (engine never surfaces the key again).
 *
 * Same SDK-backed state-machine shape as KV and Transit; honest "no mount" + "no roles"
 * empty states when nothing's configured server-side.
 */

type Tab = "roles" | "certs" | "ca";
type EngineState = "loading" | "no-mount" | "error" | "ready";

export function PkiView({ getClient }: { getClient: () => VaultClient }) {
  const [engineState, setEngineState] = React.useState<EngineState>("loading");
  const [engineError, setEngineError] = React.useState<string | null>(null);
  const [mounts, setMounts] = React.useState<Array<{ path: string; type: string }>>([]);
  const [mount, setMount] = React.useState<string>("");
  const [tab, setTab] = React.useState<Tab>("roles");

  const loadMount = React.useCallback(
    async (preferred?: string) => {
      setEngineState("loading");
      setEngineError(null);
      try {
        const ms = await getClient().listMounts();
        setMounts(ms);
        const pkis = ms.filter((m) => m.type === "pki");
        if (pkis.length === 0) {
          setEngineState("no-mount");
          return;
        }
        const chosen = preferred && pkis.find((m) => m.path === preferred) ? preferred : pkis[0]!.path;
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

  if (engineState === "loading") {
    return (
      <ChromeShell mount={mount || "—"} mounts={mounts} onSelectMount={loadMount} createDisabled>
        <div className="grid min-h-[480px] place-items-center rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] text-sm text-muted-foreground">
          Loading PKI mounts…
        </div>
      </ChromeShell>
    );
  }
  if (engineState === "no-mount") {
    return (
      <ChromeShell mount="—" mounts={mounts} onSelectMount={loadMount} createDisabled>
        <EmptyEngineState
          title="No PKI mount configured"
          body="Engine A is reachable but no PKI mount is registered on this arc-server. Start a colocated OpenBao (or set BAO_ADDR to point at one) and arc will auto-mount `pki/` on boot. You'll still need to generate a root or intermediate CA before issuing certs."
          retry={() => loadMount()}
        />
      </ChromeShell>
    );
  }
  if (engineState === "error") {
    return (
      <ChromeShell mount="—" mounts={mounts} onSelectMount={loadMount} createDisabled>
        <EmptyEngineState
          title="Couldn’t load the PKI engine"
          body={engineError ?? "Most often this is the engine being temporarily unreachable."}
          retry={() => loadMount()}
        />
      </ChromeShell>
    );
  }

  return (
    <ChromeShell
      mount={mount}
      mounts={mounts}
      onSelectMount={loadMount}
      getClient={getClient}
    >
      <Tabs tab={tab} onSelect={setTab} />
      <div className="rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] p-5">
        {tab === "roles" ? (
          <RolesTab mount={mount} getClient={getClient} />
        ) : tab === "certs" ? (
          <CertsTab mount={mount} getClient={getClient} />
        ) : (
          <CaTab mount={mount} getClient={getClient} />
        )}
      </div>
      <Footer />
    </ChromeShell>
  );
}

function ChromeShell({
  mount,
  mounts,
  onSelectMount,
  getClient,
  createDisabled,
  children,
}: {
  mount: string;
  mounts: Array<{ path: string; type: string }>;
  onSelectMount: (path: string) => void;
  getClient?: () => VaultClient;
  createDisabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Engine A · infrastructure
          </span>
          <h1 className="font-display text-2xl font-medium tracking-tight">PKI</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Issue and revoke short-lived X.509 certificates against an OpenBao-managed CA. The
            engine generates the keypair server-side and returns the leaf, the chain, and the
            private key — once. Persist the key the moment you issue.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MountSelector mount={mount} mounts={mounts} onSelect={onSelectMount} />
          {createDisabled || !getClient ? (
            <IconTip label="Issue certificate" hint="Pick a PKI mount first." side="bottom">
              <span tabIndex={0} className="inline-flex">
                <Button size="sm" variant="secondary" disabled>
                  <Plus className="h-3.5 w-3.5" /> Issue certificate
                </Button>
              </span>
            </IconTip>
          ) : (
            <IssueCertificateDialog mount={mount} getClient={getClient} />
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function Tabs({ tab, onSelect }: { tab: Tab; onSelect: (t: Tab) => void }) {
  const items: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "roles", label: "Roles", icon: <Shield className="h-3.5 w-3.5" /> },
    { key: "certs", label: "Issued certs", icon: <KeyRound className="h-3.5 w-3.5" /> },
    { key: "ca", label: "CA chain", icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-border/60">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onSelect(it.key)}
          className={cn(
            "inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[12px] font-medium transition-colors",
            tab === it.key
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
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
  const pkis = mounts.filter((m) => m.type === "pki");
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
            pki
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel>PKI mounts</DropdownMenuLabel>
        {pkis.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            No PKI mounts.
          </DropdownMenuItem>
        ) : (
          pkis.map((m) => (
            <DropdownMenuItem
              key={m.path}
              onSelect={() => onSelect(m.path)}
              className="flex items-center gap-2"
            >
              <Database className="h-3.5 w-3.5 text-primary" />
              <span className="flex-1 font-mono text-[12px]">{m.path}</span>
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
    <div className="flex min-h-[480px] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-border bg-[var(--surface-base)] p-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
        <Shield className="h-5 w-5" />
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
// Roles tab — list + per-role config drawer
// ────────────────────────────────────────────────────────────────────────────────

function RolesTab({ mount, getClient }: { mount: string; getClient: () => VaultClient }) {
  const [names, setNames] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [active, setActive] = React.useState<string | null>(null);
  const [role, setRole] = React.useState<PkiRoleWire | null>(null);
  const [roleBusy, setRoleBusy] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setNames(null);
    setError(null);
    getClient()
      .pkiListRoles(mount)
      .then((rs) => {
        if (!alive) return;
        const sorted = [...rs].sort();
        setNames(sorted);
        setActive(sorted[0] ?? null);
      })
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [getClient, mount]);

  React.useEffect(() => {
    if (!active) {
      setRole(null);
      return;
    }
    let alive = true;
    setRoleBusy(true);
    setRole(null);
    getClient()
      .pkiReadRole(mount, active)
      .then((r) => alive && setRole(r))
      .catch((err) => alive && toast.error((err as Error).message))
      .finally(() => alive && setRoleBusy(false));
    return () => {
      alive = false;
    };
  }, [active, getClient, mount]);

  if (error) return <p className="text-sm text-[var(--danger-fg)]">{error}</p>;
  if (names === null) return <p className="text-sm text-muted-foreground">Loading roles…</p>;
  if (names.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No PKI roles configured on this mount yet. Roles are CA-admin config (TTLs, allowed
        CNs, key params) — create one via OpenBao’s API or CLI to start issuing.
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[200px_1fr]">
      <ul className="space-y-0.5">
        {names.map((n) => (
          <li key={n}>
            <button
              type="button"
              onClick={() => setActive(n)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[12px] transition-colors",
                active === n
                  ? "bg-[var(--ds-accent-subtle)] text-[var(--ds-accent-subtle-fg)]"
                  : "text-foreground hover:bg-[var(--surface-hover)]",
              )}
            >
              <Shield className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{n}</span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        {roleBusy ? (
          <p className="text-sm text-muted-foreground">Loading {active}…</p>
        ) : role ? (
          <RoleDetails role={role} />
        ) : (
          <p className="text-sm text-muted-foreground">Pick a role on the left.</p>
        )}
      </div>
    </div>
  );
}

function RoleDetails({ role }: { role: PkiRoleWire }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[15px] font-semibold">{role.name}</span>
        {role.keyType ? <Badge variant="secondary">{role.keyType}{role.keyBits ? ` · ${role.keyBits}` : ""}</Badge> : null}
        {role.allowAnyName ? (
          <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
            allow any name
          </Badge>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Cell label="Default TTL" value={role.ttlSeconds !== undefined ? formatTtl(role.ttlSeconds) : "—"} />
        <Cell label="Max TTL" value={role.maxTtlSeconds !== undefined ? formatTtl(role.maxTtlSeconds) : "—"} />
        <Cell label="Allow subdomains" value={fmtBool(role.allowSubdomains)} />
        <Cell label="Allow bare domains" value={fmtBool(role.allowBareDomains)} />
      </div>
      {role.allowedDomains && role.allowedDomains.length > 0 ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Allowed domains
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {role.allowedDomains.map((d) => (
              <Badge key={d} variant="outline" className="font-mono text-[11px]">
                {d}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      {role.extra && Object.keys(role.extra).length > 0 ? (
        <details className="rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] p-3 text-[12px]">
          <summary className="cursor-pointer font-medium">All fields (raw)</summary>
          <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
            {JSON.stringify(role.extra, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Issued certs tab — table with search + per-row read/revoke
// ────────────────────────────────────────────────────────────────────────────────

function CertsTab({ mount, getClient }: { mount: string; getClient: () => VaultClient }) {
  const [serials, setSerials] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [statuses, setStatuses] = React.useState<Record<string, { revokedAt?: number }>>({});

  const refresh = React.useCallback(async () => {
    setSerials(null);
    setError(null);
    try {
      const all = await getClient().pkiListCertificates(mount);
      setSerials([...all].sort());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [getClient, mount]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRevoke = async (serial: string) => {
    setRevoking(serial);
    try {
      const r = await getClient().pkiRevokeCertificate(mount, serial);
      setStatuses((s) => ({ ...s, [serial]: { revokedAt: r.revocationTime } }));
      toast.success(`Revoked ${serial.slice(0, 16)}…`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRevoking(null);
    }
  };

  // Lazily fill revocation status as the page renders rows — one read per visible serial.
  React.useEffect(() => {
    if (!serials) return;
    let alive = true;
    void Promise.all(
      serials.map(async (s) => {
        if (statuses[s] !== undefined) return;
        try {
          const r = await getClient().pkiReadCertificate(mount, s);
          if (!alive) return;
          setStatuses((prev) =>
            prev[s] !== undefined ? prev : { ...prev, [s]: { revokedAt: r.revocationTime } },
          );
        } catch {
          /* leave undefined; row stays "unknown" */
        }
      }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serials, mount]);

  if (error) return <p className="text-sm text-[var(--danger-fg)]">{error}</p>;
  if (serials === null) return <p className="text-sm text-muted-foreground">Loading issued certificates…</p>;

  const filtered = query.trim()
    ? serials.filter((s) => s.toLowerCase().includes(query.trim().toLowerCase()))
    : serials;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={serials.length ? `Search ${serials.length} serials…` : "Search serials…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RotateCcw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>
      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {serials.length === 0
            ? "No certificates issued yet — try the Issue certificate button above."
            : "No matches."}
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)]">
          {filtered.map((serial) => {
            const status = statuses[serial];
            const revoked = status?.revokedAt && status.revokedAt > 0;
            return (
              <li key={serial} className="flex items-center gap-3 px-3 py-2.5">
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={serial}>
                  {serial}
                </span>
                {revoked ? (
                  <Badge variant="secondary" className="bg-[var(--danger-subtle)] text-[var(--danger-fg)]">
                    revoked · {relativeAgo(new Date(status!.revokedAt! * 1000).toISOString())}
                  </Badge>
                ) : status ? (
                  <Badge variant="secondary" className="bg-[var(--success-subtle)] text-[var(--success-fg)]">
                    active
                  </Badge>
                ) : (
                  <Badge variant="outline">loading…</Badge>
                )}
                <ReadCertButton mount={mount} serial={serial} getClient={getClient} />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={revoking !== null || Boolean(revoked)}
                  onClick={() => onRevoke(serial)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {revoked ? "Revoked" : revoking === serial ? "…" : "Revoke"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ReadCertButton({
  mount,
  serial,
  getClient,
}: {
  mount: string;
  serial: string;
  getClient: () => VaultClient;
}) {
  const [open, setOpen] = React.useState(false);
  const [pem, setPem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setPem(null);
    getClient()
      .pkiReadCertificate(mount, serial)
      .then((r) => alive && setPem(r.certificate))
      .catch((err) => alive && toast.error((err as Error).message));
    return () => {
      alive = false;
    };
  }, [open, mount, serial, getClient]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Download className="h-3.5 w-3.5" /> PEM
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{serial}</DialogTitle>
          <DialogDescription>PEM-encoded leaf certificate from the engine.</DialogDescription>
        </DialogHeader>
        {pem ? (
          <>
            <pre className="max-h-[420px] overflow-auto rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] p-3 font-mono text-[11px] leading-relaxed">
              {pem}
            </pre>
            <DialogFooter>
              <CopyButton value={pem} label="Copy PEM" autoClearSeconds={0} />
            </DialogFooter>
          </>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// CA tab — issuer + chain (read-only)
// ────────────────────────────────────────────────────────────────────────────────

function CaTab({ mount, getClient }: { mount: string; getClient: () => VaultClient }) {
  const [ca, setCa] = React.useState<string | null>(null);
  const [chain, setChain] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setCa(null);
    setChain(null);
    setError(null);
    Promise.all([getClient().pkiReadCa(mount), getClient().pkiReadCaChain(mount).catch(() => "")])
      .then(([caPem, chainPem]) => {
        if (!alive) return;
        setCa(caPem);
        setChain(chainPem);
      })
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [getClient, mount]);

  if (error) {
    return (
      <p className="text-sm text-[var(--danger-fg)]">
        {error}
        <span className="ml-2 text-muted-foreground">
          (the most common cause is the mount having no CA yet — generate a root or intermediate first)
        </span>
      </p>
    );
  }
  if (ca === null) return <p className="text-sm text-muted-foreground">Loading CA…</p>;

  return (
    <div className="space-y-4">
      <PemBlock title="Issuer (CA)" pem={ca} />
      {chain && chain.trim().length > 0 ? <PemBlock title="CA chain" pem={chain} /> : null}
    </div>
  );
}

function PemBlock({ title, pem }: { title: string; pem: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </span>
        <CopyButton value={pem} label="Copy" autoClearSeconds={0} />
      </div>
      <pre className="max-h-[280px] overflow-auto rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] p-3 font-mono text-[11px] leading-relaxed">
        {pem}
      </pre>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Issue ceremony — header dialog
// ────────────────────────────────────────────────────────────────────────────────

function IssueCertificateDialog({
  mount,
  getClient,
}: {
  mount: string;
  getClient: () => VaultClient;
}) {
  const [open, setOpen] = React.useState(false);
  const [roles, setRoles] = React.useState<string[]>([]);
  const [role, setRole] = React.useState("");
  const [commonName, setCommonName] = React.useState("");
  const [ttl, setTtl] = React.useState("24h");
  const [altNames, setAltNames] = React.useState("");
  const [ipSans, setIpSans] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [issued, setIssued] = React.useState<PkiIssuedCertificateWire | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setCommonName("");
    setAltNames("");
    setIpSans("");
    setTtl("24h");
    setIssued(null);
    void getClient()
      .pkiListRoles(mount)
      .then((rs) => {
        const sorted = [...rs].sort();
        setRoles(sorted);
        if (sorted.length > 0 && !sorted.includes(role)) setRole(sorted[0]!);
      })
      .catch(() => setRoles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mount]);

  const submit = async () => {
    if (!role || !commonName.trim()) return;
    setBusy(true);
    try {
      const ttlSeconds = parseTtl(ttl);
      const r = await getClient().pkiIssueCertificate(mount, role, {
        commonName: commonName.trim(),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        ...(altNames.trim() ? { altNames: altNames.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(ipSans.trim() ? { ipSans: ipSans.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      });
      setIssued(r);
      toast.success(`Issued ${r.serialNumber.slice(0, 16)}…`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" /> Issue certificate
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-[var(--success-fg)]" strokeWidth={2.5} />
                Certificate issued
              </DialogTitle>
              <DialogDescription className="font-mono text-[12px]">
                {issued.serialNumber}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p className="text-muted-foreground">
                The private key below is the <strong>only</strong> copy the engine will ever
                surface. Copy it now or the certificate is unusable.
              </p>
            </div>
            <div className="grid gap-3">
              <PemBlock title="Private key" pem={issued.privateKey} />
              <PemBlock title="Certificate" pem={issued.certificate} />
              {issued.caChain.length > 0 ? (
                <PemBlock title="CA chain" pem={issued.caChain.join("\n")} />
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Issue a certificate</DialogTitle>
              <DialogDescription>
                The engine generates a fresh keypair, signs a leaf cert under the chosen role,
                and returns everything — including the private key — once.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="pki-role">Role</Label>
                {roles.length === 0 ? (
                  <p className="rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-muted-foreground">
                    <ShieldAlert className="-mt-0.5 mr-1 inline-block h-3 w-3 text-amber-500" />
                    No roles configured on this mount yet — create one via OpenBao's API or CLI.
                  </p>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-2.5 text-left text-sm transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      >
                        <Shield className="h-3.5 w-3.5 text-primary" />
                        <span className="flex-1 truncate font-mono">{role || "Pick a role"}</span>
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-[260px]">
                      {roles.map((r) => (
                        <DropdownMenuItem key={r} onSelect={() => setRole(r)}>
                          <Shield className="h-3.5 w-3.5 text-muted-foreground" /> {r}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pki-cn">Common name</Label>
                <Input
                  id="pki-cn"
                  value={commonName}
                  onChange={(e) => setCommonName(e.target.value)}
                  placeholder="service.arc.test"
                  className="font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="pki-ttl">TTL</Label>
                  <Input
                    id="pki-ttl"
                    value={ttl}
                    onChange={(e) => setTtl(e.target.value)}
                    placeholder="24h"
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="pki-alt">Alt DNS names (comma)</Label>
                  <Input
                    id="pki-alt"
                    value={altNames}
                    onChange={(e) => setAltNames(e.target.value)}
                    placeholder="api.arc.test,*.svc.arc.test"
                    className="font-mono"
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pki-ipsans">IP SANs (comma)</Label>
                <Input
                  id="pki-ipsans"
                  value={ipSans}
                  onChange={(e) => setIpSans(e.target.value)}
                  placeholder="10.0.0.10,10.0.0.11"
                  className="font-mono"
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={submit} disabled={busy || !role || !commonName.trim()}>
                Issue
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-[13px]">{value}</p>
    </div>
  );
}

function Footer() {
  return (
    <div className="mt-6 flex items-center gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
      <TrustIndicator kind="verified">Engine A · PKI</TrustIndicator>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
        <Sparkles className="h-3 w-3" /> live · CA signs inside OpenBao
      </span>
    </div>
  );
}

function fmtBool(v: boolean | undefined): string {
  if (v === undefined) return "—";
  return v ? "yes" : "no";
}

function formatTtl(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function parseTtl(raw: string): number | undefined {
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}
