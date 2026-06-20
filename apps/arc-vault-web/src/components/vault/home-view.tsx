"use client";

import * as React from "react";
import type { EnrolledDevice, PulledItem, VaultClient, VaultSummary } from "@arc/sdk";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  ChevronRight,
  Fingerprint,
  KeyRound,
  Plus,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScoreRing } from "@/components/arc/score-ring";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { CopyButton } from "@/components/arc/copy-button";
import { asLogin, itemTitle, itemSubtitle } from "@/lib/items";
import { analyseSecurity } from "@/lib/security";
import { PageHeader } from "@/components/vault/security-view";
import { Stagger } from "@/components/motion/stagger";

/**
 * The persona Home (arc design system `PersonaHome`) — a calm, persona-aware landing for
 * the consumer surface. Reads only from items the caller already has decrypted; the
 * "security score" runs the same client-side analyser as the Security dashboard.
 *
 * Hand-coded against the design's grid (1.4fr / 1fr top, 1fr / 1fr bottom) so it stays
 * faithful without re-implementing the whole CSS layer. Greeting is derived from the
 * local clock — no per-user data is sent or stored.
 */
export function HomeView({
  items,
  vault,
  getClient,
  onGo,
  onAddItem,
}: {
  items: readonly PulledItem[];
  vault?: VaultSummary;
  getClient: () => VaultClient;
  onGo: (section: "vault" | "security" | "devices" | "agents") => void;
  onAddItem: () => void;
}) {
  const greeting = useGreeting();
  const report = React.useMemo(() => analyseSecurity(items), [items]);
  const recent = React.useMemo(() => recentLogins(items, 4), [items]);

  return (
    <Stagger className="space-y-5" stagger={0.05}>
      <Stagger.Item>
        <PageHeader
          eyebrow={greeting.eyebrow}
          title={greeting.title}
          description="Your account is protected by a key only you hold."
          trailing={
            <Button size="sm" onClick={onAddItem}>
              <Plus className="h-4 w-4" /> Add item
            </Button>
          }
        />
      </Stagger.Item>

      <Stagger.Item className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card tone="raised">
          <CardContent className="p-0">
            <div className="flex items-center gap-5 p-5">
              <ScoreRing value={report.score} label="Security score" />
              <div className="flex flex-1 flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  {report.flagged.length === 0 ? (
                    <>Nothing flagged across <span className="font-mono">{report.buckets.total}</span> logins.</>
                  ) : (
                    <>
                      <span className="font-mono">{report.buckets.weak}</span> weak ·{" "}
                      <span className="font-mono">{report.buckets.reused}</span> reused need attention.
                    </>
                  )}
                </p>
                {report.flagged.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() => onGo("security")}
                  >
                    Review <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            </div>
            {report.flagged.length > 0 ? (
              <>
                <hr className="border-t border-border/60" />
                <div className="flex items-center gap-2.5 px-5 py-3 text-sm text-muted-foreground">
                  <ShieldAlert className="h-4 w-4 text-[var(--warning)]" />
                  <span>
                    {report.flagged.length} {report.flagged.length === 1 ? "item" : "items"} need attention.
                  </span>
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    onClick={() => onGo("security")}
                  >
                    Open security <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>

        <DevicesTeaser getClient={getClient} onManage={() => onGo("devices")} />
      </Stagger.Item>

      <Stagger.Item className="grid gap-4 lg:grid-cols-2">
        <RecentlyUsed items={recent} onOpenAll={() => onGo("vault")} vault={vault} />
        <AgentsTeaser onView={() => onGo("agents")} />
      </Stagger.Item>
    </Stagger>
  );
}

function RecentlyUsed({
  items,
  vault,
  onOpenAll,
}: {
  items: readonly PulledItem[];
  vault?: VaultSummary;
  onOpenAll: () => void;
}) {
  return (
    <Card tone="raised">
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h2 className="font-display text-base font-semibold">Recently used</h2>
            <p className="text-xs text-muted-foreground">{vault?.name ?? vault?.type ?? "Personal vault"}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onOpenAll}>
            Open vault
          </Button>
        </div>
        {items.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            No logins yet. Add one to get started.
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((i) => {
              const l = asLogin(i);
              const password = l?.fields.password ?? "";
              return (
                <li key={i.id} className="flex items-center gap-3 px-5 py-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-[var(--surface-raised)] font-mono text-sm font-semibold">
                    {itemTitle(i).slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{itemTitle(i)}</div>
                    <div className="truncate text-xs text-muted-foreground">{itemSubtitle(i)}</div>
                  </div>
                  {password ? (
                    <CopyButton iconOnly value={password} autoClearSeconds={20} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Devices stale beyond this many days get the inactivity nudge (matches DevicesView). */
const INACTIVE_DAYS = 40;

function isInactive(d: EnrolledDevice): boolean {
  // Trusted devices are exempt from the inactivity policy, so we don't nag about them.
  if (d.trusted || !d.lastSeenAt) return false;
  const days = (Date.now() - Date.parse(d.lastSeenAt)) / 86_400_000;
  return Number.isFinite(days) && days >= INACTIVE_DAYS;
}

/**
 * Real device posture, loaded from the same SDK calls the dedicated Devices screen uses
 * (`listDevices` + `listPasskeys`) — no server-trust change, just surfacing what the user
 * can already see. Replaces the old "wired elsewhere" placeholder with live counts:
 * total devices, how many are trusted, registered passkeys, and an inactivity nudge.
 */
function DevicesTeaser({
  getClient,
  onManage,
}: {
  getClient: () => VaultClient;
  onManage: () => void;
}) {
  const [devices, setDevices] = React.useState<EnrolledDevice[] | null>(null);
  const [passkeys, setPasskeys] = React.useState<number | null>(null);

  React.useEffect(() => {
    let alive = true;
    getClient()
      .listDevices()
      .then((d) => alive && setDevices(d))
      .catch(() => alive && setDevices([]));
    getClient()
      .listPasskeys()
      .then((p) => alive && setPasskeys(p.length))
      .catch(() => alive && setPasskeys(0));
    return () => {
      alive = false;
    };
  }, [getClient]);

  const total = devices?.length ?? 0;
  const trusted = devices?.filter((d) => d.trusted).length ?? 0;
  const inactive = devices?.filter(isInactive).length ?? 0;

  return (
    <Card tone="raised">
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h2 className="font-display text-base font-semibold">Your devices</h2>
            <p className="text-xs text-muted-foreground">Every device that can unlock your vault</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onManage}>
            Manage
          </Button>
        </div>
        {devices === null ? (
          <div className="px-5 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-3 px-5 py-4">
            <div className="grid grid-cols-3 gap-2">
              <DeviceStat icon={<Fingerprint className="h-3.5 w-3.5" />} n={total} label={total === 1 ? "device" : "devices"} />
              <DeviceStat icon={<ShieldCheck className="h-3.5 w-3.5" />} n={trusted} label="trusted" tone="ok" />
              <DeviceStat icon={<KeyRound className="h-3.5 w-3.5" />} n={passkeys ?? 0} label={passkeys === 1 ? "passkey" : "passkeys"} />
            </div>
            {inactive > 0 ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--warning-subtle)] px-3 py-2 text-xs text-[var(--warning-fg)]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {inactive} {inactive === 1 ? "device" : "devices"} inactive {INACTIVE_DAYS}+ days — consider
                  retiring{" "}
                  <button type="button" onClick={onManage} className="font-medium underline">
                    in Devices
                  </button>
                  .
                </span>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceStat({
  icon,
  n,
  label,
  tone,
}: {
  icon: React.ReactNode;
  n: number;
  label: string;
  tone?: "ok";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-3 py-2.5">
      <span
        className="font-mono text-xl font-semibold leading-none tabular-nums"
        style={tone === "ok" && n > 0 ? { color: "var(--success-fg)" } : undefined}
      >
        {n}
      </span>
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </span>
    </div>
  );
}

function AgentsTeaser({ onView }: { onView: () => void }) {
  return (
    <Card tone="raised" className="bg-[var(--ds-accent-subtle)]/30">
      <CardContent className="p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/12 text-primary ring-1 ring-primary/20">
            <Bot className="h-4 w-4" />
          </span>
          <h2 className="font-display text-base font-semibold">Governed agents</h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          arc brokers secrets to AI agents as audited, revocable tool calls — never your
          master key.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onView}>
            <Bot className="h-4 w-4" /> View agents
          </Button>
          <TrustIndicator kind="zk" />
        </div>
      </CardContent>
    </Card>
  );
}

function useGreeting(): { eyebrow: string; title: string } {
  // SSR-safe: render a neutral greeting on the server, hydrate the time-of-day variant on
  // the client (no Date.now() in the initializer → no hydration mismatch).
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!now) return { eyebrow: "Home", title: "Welcome back" };
  const h = now.getHours();
  const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  const day = now.toLocaleDateString(undefined, { weekday: "long" });
  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return { eyebrow: `${day} · ${time}`, title: `Good ${part}` };
}

/**
 * Order by server `updatedAt` (ISO) — the real "most recently touched" signal. Falls back
 * to `seq` if the timestamp is unparseable (shouldn't happen now that the SDK threads it,
 * but keeps the sort total in pathological cases).
 */
function recentLogins(items: readonly PulledItem[], n: number): PulledItem[] {
  const ts = (i: PulledItem): number => {
    const t = Date.parse(i.updatedAt);
    return Number.isFinite(t) ? t : i.seq ?? 0;
  };
  return [...items]
    .filter((i) => asLogin(i))
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, n);
}
