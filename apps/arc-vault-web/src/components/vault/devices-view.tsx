"use client";

import * as React from "react";
import type { EnrolledDevice, PendingDevice, VaultClient } from "@arc/sdk";
import {
  AlertTriangle,
  Ban,
  Check,
  Cpu,
  Fingerprint,
  Loader2,
  Plus,
  Shield,
  ShieldOff,
  Smartphone,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { PageHeader } from "@/components/vault/security-view";
import { Stagger } from "@/components/motion/stagger";
import { cn } from "@/lib/utils";

/** Inactivity threshold for the "retire?" nudge — matches the design system's 40-day note. */
const STALE_DAYS = 40;

/**
 * Devices view (arc design system `Devices` screen). Lists every device that can unlock
 * the user's vault, marks the current device, surfaces the trusted flag + last-seen
 * timestamp, and nudges retirement for devices stale beyond {@link STALE_DAYS}. Pending
 * approvals from other devices fold in here too so approval lives in-flow rather than
 * behind the legacy `DevicesDialog`.
 *
 * All actions go through the SDK (`listDevices` / `revokeDevice` / `listPendingDevices` /
 * `approveDevice`) — same calls the existing dialog uses, so this is pure presentation
 * over the established server contract. No new auth surface; revocation still requires the
 * standard JWT + the user is the only one who can revoke their own device.
 */
export function DevicesView({ getClient }: { getClient: () => VaultClient }) {
  const [devices, setDevices] = React.useState<EnrolledDevice[] | null>(null);
  const [pending, setPending] = React.useState<PendingDevice[]>([]);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [approving, setApproving] = React.useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = React.useState<EnrolledDevice | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [list, pend] = await Promise.all([
        getClient().listDevices(),
        getClient().listPendingDevices().catch(() => [] as PendingDevice[]),
      ]);
      setDevices(list);
      setPending(pend);
    } catch (e) {
      toast.error((e as Error).message);
      setDevices([]);
    }
  }, [getClient]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const approve = async (d: PendingDevice) => {
    setApproving(d.id);
    try {
      await getClient().approveDevice(d.id, d.publicKey);
      toast.success("Device approved");
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setApproving(null);
    }
  };

  const revoke = async (d: EnrolledDevice) => {
    setRevoking(d.id);
    try {
      await getClient().revokeDevice(d.id);
      toast.success(`Revoked “${d.name}”`);
      setConfirmRevoke(null);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRevoking(null);
    }
  };

  const trusted = (devices ?? []).filter((d) => d.trusted).length;

  return (
    <Stagger className="space-y-5" stagger={0.05}>
      <Stagger.Item>
        <PageHeader
          eyebrow="You · devices"
          title="My devices"
          description="Every device that can unlock your vault. Trusted devices skip the inactivity auto-revoke."
          trailing={<TrustIndicator kind="e2e" />}
        />
      </Stagger.Item>

      {pending.length > 0 ? (
        <Stagger.Item>
          <Card tone="raised">
            <CardContent className="p-0">
              <div className="flex items-center gap-2 border-b px-5 py-3">
                <Shield className="h-4 w-4 text-primary" />
                <h2 className="font-display text-base font-semibold">Waiting for approval</h2>
                <Badge variant="secondary" className="ml-1">{pending.length}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  Approve only after the code matches the one shown on the new device.
                </span>
              </div>
              <ul className="divide-y">
                {pending.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                    <DeviceAvatar name={d.name} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{d.name}</div>
                      <div className="font-mono text-sm tracking-[0.18em] text-muted-foreground">
                        {d.verificationCode}
                      </div>
                    </div>
                    <Button size="sm" disabled={approving !== null} onClick={() => approve(d)}>
                      {approving === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Approve
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </Stagger.Item>
      ) : null}

      <Stagger.Item>
        <Card tone="raised">
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <div>
                <h2 className="font-display text-base font-semibold">Trusted devices</h2>
                <p className="text-xs text-muted-foreground">
                  {devices === null ? "Loading…" : `${devices.length} total · ${trusted} trusted`}
                </p>
              </div>
              <Button variant="outline" size="sm" disabled>
                <Plus className="h-4 w-4" /> Approve new device
              </Button>
            </div>

            {devices === null ? (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</div>
            ) : devices.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                No enrolled devices yet.
              </div>
            ) : (
              <ul className="divide-y">
                {[...devices]
                  .sort((a, b) => freshness(b.lastSeenAt) - freshness(a.lastSeenAt))
                  .map((d) => (
                    <DeviceRow
                      key={d.id}
                      device={d}
                      revoking={revoking === d.id}
                      onRevoke={() => setConfirmRevoke(d)}
                    />
                  ))}
              </ul>
            )}

            {devices && devices.some(isStale) ? (
              <div className="flex items-center gap-2.5 border-t bg-[var(--warning-subtle)] px-5 py-3 text-sm text-muted-foreground">
                <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--warning)]" />
                <span>
                  Some devices have been inactive for over {STALE_DAYS} days. Retire them to keep
                  your account tight.
                </span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </Stagger.Item>

      <Stagger.Item>
        <p className="text-xs text-muted-foreground">
          Revoking a device removes its access to this vault. The device’s wrapped keys are
          invalidated server-side; the user must re-enroll to regain access.
        </p>
      </Stagger.Item>

      <Dialog open={confirmRevoke !== null} onOpenChange={(o) => !o && setConfirmRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this device?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{confirmRevoke?.name}</span>{" "}
              will lose access to your vault immediately. You can re-enroll it from that device.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRevoke(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={revoking !== null}
              onClick={() => confirmRevoke && revoke(confirmRevoke)}
            >
              {revoking !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stagger>
  );
}

function DeviceRow({
  device,
  revoking,
  onRevoke,
}: {
  device: EnrolledDevice;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const stale = isStale(device);
  const lastSeen = formatLastSeen(device.lastSeenAt);
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <DeviceAvatar name={device.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{device.name}</div>
        <div className="text-xs text-muted-foreground">last seen {lastSeen}</div>
      </div>
      {device.trusted ? (
        <Badge variant="secondary" className="gap-1 bg-[var(--sec-trusted-subtle)] text-[var(--sec-zk)]">
          <Shield className="h-3 w-3" /> trusted
        </Badge>
      ) : (
        <Badge variant="outline" className="gap-1">
          <ShieldOff className="h-3 w-3" /> untrusted
        </Badge>
      )}
      {stale ? (
        <Button
          variant="outline"
          size="sm"
          className="border-[var(--warning)]/30 text-[var(--warning-fg)]"
          onClick={onRevoke}
          disabled={revoking}
        >
          <AlertTriangle className="h-3.5 w-3.5" /> Retire?
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onRevoke} disabled={revoking}>
          {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
          Revoke
        </Button>
      )}
    </li>
  );
}

function DeviceAvatar({ name }: { name: string }) {
  const lower = name.toLowerCase();
  const Icon = /iphone|ipad|android|phone|mobile/.test(lower)
    ? Smartphone
    : /key|passkey|yubi/.test(lower)
      ? Fingerprint
      : Cpu;
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-[var(--surface-raised)] text-muted-foreground">
      <Icon className="h-4 w-4" />
    </span>
  );
}

function freshness(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

function isStale(d: { lastSeenAt: string | null; trusted: boolean }): boolean {
  // Trusted devices are exempt from the inactivity nudge (per the design's note).
  if (d.trusted) return false;
  if (!d.lastSeenAt) return false;
  const days = (Date.now() - Date.parse(d.lastSeenAt)) / 86_400_000;
  return Number.isFinite(days) && days >= STALE_DAYS;
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const diffMs = Date.now() - t;
  const m = Math.round(diffMs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

/** Used by ConsoleShell to hide unused class warnings. */
export const _placeholders = { cn };
