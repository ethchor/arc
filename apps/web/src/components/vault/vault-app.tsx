"use client";

import * as React from "react";
import { FolderPlus, Vault } from "lucide-react";
import type { PulledItem, VaultSummary } from "@arc-vault/sdk";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AddItemDialog, type LoginInput } from "@/components/vault/add-item-dialog";
import { CopyField } from "@/components/vault/copy-field";
import { RecoveryKeyCard } from "@/components/vault/recovery-key-card";
import { SiteHeader } from "@/components/vault/site-header";
import { UnlockScreen } from "@/components/vault/unlock-screen";
import { getClient, initClient, lock } from "@/vault-store";
import { cn } from "@/lib/utils";

interface LoginData {
  type: "login";
  title: string;
  fields: { url: string; username: string; password: string };
}
type Phase = "login" | "account" | "unlocked";

export function VaultApp() {
  const [phase, setPhase] = React.useState<Phase>("login");
  const [busy, setBusy] = React.useState(false);
  const [recoveryKey, setRecoveryKey] = React.useState<string | null>(null);
  const [vaults, setVaults] = React.useState<VaultSummary[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<PulledItem[]>([]);
  const [activeItem, setActiveItem] = React.useState<string | null>(null);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openVault = async (id: string) => {
    setSelected(id);
    setActiveItem(null);
    const { items } = await getClient().pull(id, 0);
    setItems(items.filter((i) => !i.deleted));
  };

  const loadVaults = async () => {
    const vs = await getClient().listVaults();
    setVaults(vs);
    if (vs[0]) await openVault(vs[0].id);
  };

  const signIn = (baseUrl: string, email: string) =>
    guard(async () => {
      initClient(baseUrl);
      await getClient().devLogin(email);
      setPhase("account");
    });

  const unlock = (password: string) =>
    guard(async () => {
      await getClient().unlock(password);
      await loadVaults();
      setPhase("unlocked");
      toast.success("Vault unlocked");
    });

  const enroll = (password: string) =>
    guard(async () => {
      const result = await getClient().enroll(password);
      setRecoveryKey(result.recoveryKey);
      await loadVaults();
      setPhase("unlocked");
    });

  const createVault = () =>
    guard(async () => {
      const v = await getClient().createVault("team");
      await loadVaults();
      await openVault(v.id);
      toast.success("Vault created");
    });

  const addLogin = async (value: LoginInput) => {
    if (!selected) return;
    await getClient().putItem(
      selected,
      { type: "login", title: value.title, fields: { url: value.url, username: value.username, password: value.password } },
      { type: "login" },
    );
    await openVault(selected);
    toast.success("Saved");
  };

  const doLock = () => {
    lock();
    setPhase("login");
    setVaults([]);
    setItems([]);
    setSelected(null);
    setRecoveryKey(null);
    setActiveItem(null);
  };

  if (phase !== "unlocked") {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <UnlockScreen phase={phase} busy={busy} onSignIn={signIn} onUnlock={unlock} onEnroll={enroll} />
      </div>
    );
  }

  const active = items.find((i) => i.id === activeItem);
  const activeData = active?.data as LoginData | null | undefined;

  return (
    <div className="min-h-screen">
      <SiteHeader onLock={doLock} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        {recoveryKey && (
          <div className="mb-6">
            <RecoveryKeyCard recoveryKey={recoveryKey} onDismiss={() => setRecoveryKey(null)} />
          </div>
        )}
        <div className="grid gap-6 md:grid-cols-[220px_1fr]">
          <aside className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">Vaults</h2>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={createVault} aria-label="New vault">
                <FolderPlus className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-1">
              {vaults.map((v) => (
                <button
                  key={v.id}
                  onClick={() => openVault(v.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    selected === v.id && "bg-accent font-medium",
                  )}
                >
                  <Vault className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate capitalize">{v.type}</span>
                  <Badge variant="secondary" className="ml-auto">
                    {v.role}
                  </Badge>
                </button>
              ))}
            </div>
          </aside>

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-semibold">Items</h1>
              {selected && <AddItemDialog onAdd={addLogin} />}
            </div>
            <Separator />
            {items.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No items yet. Add your first login.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  {items.map((i) => {
                    const d = i.data as LoginData | null;
                    return (
                      <button
                        key={i.id}
                        onClick={() => setActiveItem(i.id)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-accent",
                          activeItem === i.id && "border-primary",
                        )}
                      >
                        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
                          {(d?.title ?? "?").slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{d?.title ?? i.id}</div>
                          <div className="truncate text-xs text-muted-foreground">{d?.fields.username}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{activeData?.title ?? "Select an item"}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {activeData ? (
                      <>
                        <CopyField label="URL" value={activeData.fields.url} />
                        <CopyField label="Username" value={activeData.fields.username} />
                        <CopyField label="Password" value={activeData.fields.password} secret />
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Choose an item to view its fields.</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
