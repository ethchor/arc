"use client";

import * as React from "react";
import type { PulledItem } from "@arc/sdk";
import { AlertCircle, AlertTriangle, KeyRound, ShieldCheck, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { Stagger } from "@/components/motion/stagger";
import { analyseSecurity, type FlaggedItem } from "@/lib/security";

/**
 * Security dashboard (arc design system `SecurityDashboard`). Reads from the items the
 * caller already has decrypted — every score, breakdown, and flag is computed on this
 * device. Nothing here is sent to or fetched from the server. The "fix" action focuses
 * the offending item back in the vault list.
 *
 * Why this can be honest: `analyseSecurity` runs over `items` already unwrapped under the
 * vault key (docs/04). The server never sees plaintext, password material, or this
 * report; truth-of-security stays on the client.
 */
export function SecurityView({
  items,
  onOpenItem,
}: {
  items: readonly PulledItem[];
  onOpenItem: (id: string) => void;
}) {
  const report = React.useMemo(() => analyseSecurity(items), [items]);
  const { score, buckets, flagged } = report;

  // Distinct items that carry at least one flag (flagged[] has one entry per issue, so an
  // item that's both weak and reused appears twice — count people, not problems, for the
  // headline number).
  const flaggedItemCount = React.useMemo(
    () => new Set(flagged.map((f) => f.id)).size,
    [flagged],
  );
  const twoFactorPct = buckets.total > 0 ? Math.round((buckets.twoFactor / buckets.total) * 100) : 0;
  const firstWeakId = flagged.find((f) => f.kind === "weak")?.id ?? null;

  const breakdown = [
    { t: "Strong & unique", n: buckets.strong, color: "var(--success)" },
    { t: "Weak", n: buckets.weak, color: "var(--danger)" },
    { t: "Reused", n: buckets.reused, color: "var(--warning)" },
  ];
  const denom = Math.max(1, buckets.total);

  return (
    <Stagger className="space-y-5" stagger={0.05}>
      <Stagger.Item>
        <PageHeader
          eyebrow="You · security"
          title="Your security, at a glance"
          description="A clear picture of what's strong and what needs attention — computed on this device. Nothing leaves the vault."
          trailing={
            <div className="flex items-center gap-2">
              {buckets.weak > 0 && firstWeakId ? (
                <Button
                  size="sm"
                  onClick={() => onOpenItem(firstWeakId)}
                  title="Open the first weak login in your vault to fix it"
                >
                  <ShieldCheck className="h-4 w-4" /> Fix weak logins
                </Button>
              ) : null}
              <TrustIndicator kind="zk" />
            </div>
          }
        />
      </Stagger.Item>

      {/* Four headline stats — every number is derived from items already decrypted on this
          device. We deliberately don't surface a breach-exposure or password-age card: with
          no remote breach list and no per-item rotation timestamp on the wire, those would
          be fabricated. Coverage + strength below are real. */}
      <Stagger.Item className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          big={score}
          label="Security score"
          sub="computed on this device"
          tone={score >= 80 ? "ok" : score >= 50 ? "warn" : "danger"}
        />
        <StatCard
          big={flaggedItemCount}
          label="Need attention"
          sub={subForFlags(buckets)}
          tone={flaggedItemCount > 0 ? "warn" : "ok"}
        />
        <StatCard
          big={`${twoFactorPct}%`}
          label="2FA coverage"
          sub={`${buckets.twoFactor} of ${buckets.total} ${buckets.total === 1 ? "login" : "logins"}`}
          tone={twoFactorPct >= 80 ? "ok" : "muted"}
          icon={<KeyRound className="h-3.5 w-3.5" />}
        />
        <StatCard
          big={buckets.strong}
          label="Strong & unique"
          sub={`of ${buckets.total} ${buckets.total === 1 ? "login" : "logins"}`}
          tone="ok"
        />
      </Stagger.Item>

      {/* Strength breakdown — the detail behind the score */}
      <Stagger.Item>
        <Card tone="raised">
          <CardContent className="grid gap-3 p-5 sm:grid-cols-3">
            {breakdown.map((b) => (
              <div key={b.t} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-muted-foreground">{b.t}</span>
                  <span className="font-mono text-sm tabular-nums">{b.n}</span>
                </div>
                <span className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="h-full rounded-full transition-[width] [transition-duration:var(--dur-slow)] ease-out-quart"
                    style={{ width: `${Math.round((b.n / denom) * 100)}%`, background: b.color }}
                  />
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </Stagger.Item>

      {/* Needs-attention list with per-row Fix */}
      <Stagger.Item>
        <Card tone="raised">
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <div>
                <h2 className="font-display text-base font-semibold">Needs attention</h2>
                <p className="text-xs text-muted-foreground">
                  {flagged.length} {flagged.length === 1 ? "issue" : "issues"} across {flaggedItemCount}{" "}
                  {flaggedItemCount === 1 ? "login" : "logins"}
                </p>
              </div>
              {buckets.weak > 0 ? (
                <Badge variant="secondary" className="gap-1.5 bg-[var(--danger-subtle)] text-[var(--danger-fg)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {buckets.weak} weak
                </Badge>
              ) : null}
            </div>

            {flagged.length === 0 ? (
              <div className="flex flex-col items-center gap-3 p-12 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--success-subtle)] text-[var(--success-fg)]">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold">Nothing flagged</p>
                  <p className="mt-1 max-w-md text-sm text-muted-foreground">
                    Every login is strong and unique. Keep an eye on this dashboard as your vault
                    grows.
                  </p>
                </div>
              </div>
            ) : (
              <ul className="divide-y">
                {flagged.map((f) => (
                  <li
                    key={`${f.id}-${f.kind}`}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-accent/40"
                  >
                    <ItemAvatar title={f.title} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{f.title}</div>
                      <FlagLine f={f} />
                    </div>
                    <Badge variant="outline" className="hidden capitalize sm:inline-flex">
                      {f.kind}
                    </Badge>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onOpenItem(f.id)}
                      title={`Open ${f.title} in your vault to fix`}
                    >
                      <Wrench className="h-3.5 w-3.5" /> Fix
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </Stagger.Item>
    </Stagger>
  );
}

function StatCard({
  big,
  label,
  sub,
  tone,
  icon,
}: {
  big: number | string;
  label: string;
  sub: string;
  tone: "ok" | "warn" | "danger" | "muted";
  icon?: React.ReactNode;
}) {
  const color =
    tone === "warn"
      ? "var(--warning)"
      : tone === "danger"
        ? "var(--danger)"
        : tone === "ok"
          ? "var(--success-fg)"
          : "var(--content-primary)";
  return (
    <Card tone="raised">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div
            className="font-mono text-[30px] font-semibold leading-none tabular-nums"
            style={{ color: tone === "muted" ? "var(--content-primary)" : color }}
          >
            {big}
          </div>
          {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        </div>
        <div className="mt-2.5 text-[13px] font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

function FlagLine({ f }: { f: FlaggedItem }) {
  const isHigh = f.severity === "high";
  const Icon = isHigh ? AlertCircle : AlertTriangle;
  return (
    <div
      className="mt-0.5 flex items-center gap-1.5 text-xs"
      style={{ color: isHigh ? "var(--danger-fg)" : "var(--warning-fg)" }}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="truncate">{f.reason}</span>
    </div>
  );
}

function ItemAvatar({ title }: { title: string }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-[var(--surface-raised)] font-mono text-sm font-semibold">
      {(title || "·").slice(0, 1).toUpperCase()}
    </span>
  );
}

function subForFlags(b: { weak: number; reused: number }): string {
  const parts: string[] = [];
  if (b.weak) parts.push(`${b.weak} weak`);
  if (b.reused) parts.push(`${b.reused} reused`);
  return parts.length ? parts.join(" · ") : "all clear";
}

/** Shared page header for the consumer screens. */
export function PageHeader({
  eyebrow,
  title,
  description,
  trailing,
}: {
  eyebrow: string;
  title: string;
  description: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 pb-1">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {eyebrow}
        </span>
        <h1 className="font-display text-2xl font-medium tracking-tight">{title}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      </div>
      {trailing}
    </div>
  );
}
