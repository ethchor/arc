"use client";

import * as React from "react";
import type { PulledItem, VaultSummary } from "@arc/sdk";
import { ArrowRight, Bot, ChevronRight, Plus, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScoreRing } from "@/components/arc/score-ring";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { CopyButton } from "@/components/arc/copy-button";
import { asLogin, itemTitle, itemSubtitle } from "@/lib/items";
import { analyseSecurity } from "@/lib/security";
import { PageHeader } from "@/components/vault/security-view";

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
  onGo,
  onAddItem,
}: {
  items: readonly PulledItem[];
  vault?: VaultSummary;
  onGo: (section: "vault" | "security" | "devices" | "agents") => void;
  onAddItem: () => void;
}) {
  const greeting = useGreeting();
  const report = React.useMemo(() => analyseSecurity(items), [items]);
  const recent = React.useMemo(() => recentLogins(items, 4), [items]);

  return (
    <div className="space-y-5">
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

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
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

        <DevicesTeaser onManage={() => onGo("devices")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RecentlyUsed items={recent} onOpenAll={() => onGo("vault")} vault={vault} />
        <AgentsTeaser onView={() => onGo("agents")} />
      </div>
    </div>
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

function DevicesTeaser({ onManage }: { onManage: () => void }) {
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
        <div className="px-5 py-5 text-sm text-muted-foreground">
          Devices list is wired in the dedicated <button type="button" onClick={onManage} className="font-medium text-primary hover:underline">Devices</button> screen.
        </div>
      </CardContent>
    </Card>
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
 * Recency proxy: `seq` is the per-vault monotonic version `pull` returns. Higher seq =
 * more recently created/updated. The wire shape doesn't carry an explicit updatedAt yet.
 */
function recentLogins(items: readonly PulledItem[], n: number): PulledItem[] {
  return [...items]
    .filter((i) => asLogin(i))
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, n);
}
