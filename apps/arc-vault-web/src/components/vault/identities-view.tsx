"use client";

import * as React from "react";
import {
  Bot,
  CheckCircle2,
  Clock,
  Pause,
  ShieldCheck,
  ShieldOff,
  Trash2,
  XCircle,
} from "lucide-react";
import type { AgentIdentity } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Non-human identity inventory (ADR-005). Surfaces every agent the operator owns: who they
 * are, what they're attested to, whether autonomy is enabled, when they were last seen,
 * and quick controls (toggle autonomy, suspend, retire). Read flow uses the same
 * zero-knowledge SDK — the server never sees keys; only the agent record's public surface.
 *
 * Controls fire SDK calls and trigger an immediate `reload()`; on failure we surface a
 * row-level error message rather than swallowing the click silently.
 */
export interface IdentitiesViewProps {
  /** Loader injected from the page so tests can pass a synchronous list. */
  load: () => Promise<AgentIdentity[]>;
  /** Update lifecycle / autonomy / label. Owner-only on the server. */
  update: (
    agentId: string,
    patch: { status?: AgentIdentity["status"]; autonomousAllowed?: boolean },
  ) => Promise<AgentIdentity>;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; rows: AgentIdentity[] }
  | { kind: "error"; message: string };

const STATUS_STYLE: Record<AgentIdentity["status"], { label: string; cls: string }> = {
  active: { label: "Active", cls: "border-emerald-500/30 text-emerald-200" },
  suspended: { label: "Suspended", cls: "border-amber-500/30 text-amber-200" },
  retired: { label: "Retired", cls: "border-zinc-500/30 text-zinc-400" },
};

export function IdentitiesView({ load, update }: IdentitiesViewProps) {
  const [state, setState] = React.useState<LoadState>({ kind: "loading" });
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<{ id: string; message: string } | null>(null);

  const reload = React.useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const rows = await load();
      setState({ kind: "ready", rows });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }, [load]);

  React.useEffect(() => {
    let live = true;
    load()
      .then((rows) => live && setState({ kind: "ready", rows }))
      .catch((err) => live && setState({ kind: "error", message: (err as Error).message }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patch(agentId: string, p: { status?: AgentIdentity["status"]; autonomousAllowed?: boolean }) {
    setPendingId(agentId);
    setRowError(null);
    try {
      await update(agentId, p);
      await reload();
    } catch (err) {
      setRowError({ id: agentId, message: (err as Error).message });
    } finally {
      setPendingId(null);
    }
  }

  if (state.kind === "loading") {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading identities…</p>;
  }
  if (state.kind === "error") {
    return (
      <p className="py-10 text-center text-sm text-destructive">
        Couldn&apos;t load identities: {state.message}
      </p>
    );
  }

  const { rows } = state;
  const total = rows.length;
  const active = rows.filter((r) => r.status === "active").length;
  const autonomous = rows.filter((r) => r.autonomousAllowed && r.status === "active").length;
  const attested = rows.filter((r) => r.attestation?.kind === "spiffe").length;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">Non-human identities</h2>
        <p className="text-sm text-muted-foreground">
          Agents and machine principals acting under your authority.
        </p>
      </header>

      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
        <Summary label="Total" value={total} />
        <Summary label="Active" value={active} accent="text-emerald-200" />
        <Summary label="Autonomous" value={autonomous} accent="text-amber-200" />
        <Summary label="Attested" value={attested} accent="text-sky-200" />
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No agents yet. Register one via the SDK or CLI.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <AgentRow
              key={r.id}
              agent={r}
              pending={pendingId === r.id}
              error={rowError?.id === r.id ? rowError.message : undefined}
              onToggleAutonomy={() => patch(r.id, { autonomousAllowed: !r.autonomousAllowed })}
              onSuspendResume={() =>
                patch(r.id, { status: r.status === "suspended" ? "active" : "suspended" })
              }
              onRetire={() => patch(r.id, { status: "retired" })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Summary({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <Card>
      <CardContent className="flex items-baseline justify-between py-3">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={cn("text-2xl font-semibold tabular-nums", accent)}>{value}</span>
      </CardContent>
    </Card>
  );
}

function AgentRow({
  agent,
  pending,
  error,
  onToggleAutonomy,
  onSuspendResume,
  onRetire,
}: {
  agent: AgentIdentity;
  pending: boolean;
  error?: string;
  onToggleAutonomy: () => void;
  onSuspendResume: () => void;
  onRetire: () => void;
}) {
  const style = STATUS_STYLE[agent.status];
  const seen = agent.lastSeenAt ? new Date(agent.lastSeenAt) : null;
  const seenLabel = seen ? formatRelative(seen) : "never";
  const created = new Date(agent.createdAt);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{agent.displayName}</span>
          <Badge variant="outline" className={cn("font-normal", style.cls)}>
            {style.label}
          </Badge>
          {agent.attestation?.kind === "spiffe" ? (
            <Badge
              variant="outline"
              className="gap-1 border-sky-500/30 font-normal text-sky-200"
              title={agent.attestation.subject ?? undefined}
            >
              <ShieldCheck className="h-3 w-3" /> SPIFFE
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 border-zinc-500/30 font-normal text-zinc-400">
              <ShieldOff className="h-3 w-3" /> No attestation
            </Badge>
          )}
          {agent.autonomousAllowed && (
            <Badge variant="outline" className="border-amber-500/30 font-normal text-amber-200">
              Autonomous
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
          <Field label="Agent id" value={agent.id} mono />
          <Field
            label="Last seen"
            value={
              <span className="flex items-center gap-1 text-foreground/80">
                <Clock className="h-3 w-3" />
                {seenLabel}
              </span>
            }
          />
          <Field label="Created" value={created.toLocaleDateString()} />
          {agent.attestation?.kind === "spiffe" ? (
            <Field label="Trust anchor" value={agent.attestation.trustAnchor ?? "—"} />
          ) : (
            <Field label="Owner" value={`user:${agent.ownerUserId}`} />
          )}
        </dl>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {agent.status !== "retired" && (
            <>
              <Button size="sm" variant="outline" onClick={onToggleAutonomy} disabled={pending}>
                {agent.autonomousAllowed ? (
                  <>
                    <XCircle className="h-3.5 w-3.5" /> Disable autonomy
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Enable autonomy
                  </>
                )}
              </Button>
              <Button size="sm" variant="outline" onClick={onSuspendResume} disabled={pending}>
                <Pause className="h-3.5 w-3.5" />
                {agent.status === "suspended" ? "Resume" : "Suspend"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onRetire}
                disabled={pending}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" /> Retire
              </Button>
            </>
          )}
          {error && (
            <span className="text-xs text-destructive">{error}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{label}</dt>
      <dd className={cn("truncate text-foreground/80", mono && "font-mono text-[11px]")}>{value}</dd>
    </div>
  );
}

/** Human-readable relative time without pulling in a date library. */
function formatRelative(d: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}
