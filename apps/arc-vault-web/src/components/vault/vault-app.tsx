"use client";

import * as React from "react";
import { Clock, Cpu, FileClock, FileText, Folder, GitBranch, House, KeyRound, KeySquare, Pencil, Plus, RefreshCw, RotateCw, Search, Shield, ShieldCheck, Trash2, Vault, X } from "lucide-react";
import type { PulledItem, VaultFolder, VaultSummary, VaultType } from "@arc/sdk";
import type { JsonValue, TotpAlgorithm } from "@arc/types";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { AccessView } from "@/components/vault/access-view";
import { AuditView } from "@/components/vault/audit-view";
import {
  ConsoleShell,
  type ConsoleSection,
  type Density,
  type Persona,
} from "@/components/vault/console-shell";
import { PreviewScreen } from "@/components/vault/preview-screen";
import { IdentitiesView } from "@/components/vault/identities-view";
import { CopyField } from "@/components/vault/copy-field";
import { CreateVaultDialog } from "@/components/vault/create-vault-dialog";
import { DevicePendingView } from "@/components/vault/device-pending-view";
import { EnrollScreen } from "@/components/vault/enroll-screen";
import { DevicesDialog } from "@/components/vault/devices-dialog";
import { InfoView } from "@/components/vault/info-view";
import { ItemDialog, type LoginInput } from "@/components/vault/item-dialog";
import { NoteDialog, type NoteInput } from "@/components/vault/note-dialog";
import { SecretDialog, type SecretInput } from "@/components/vault/secret-dialog";
import { TotpCard } from "@/components/vault/totp-card";
import { TotpDialog, type TotpInput } from "@/components/vault/totp-dialog";
import { NewFolderDialog } from "@/components/vault/new-folder-dialog";
import { PoliciesView } from "@/components/vault/policies-view";
import { RecoverScreen } from "@/components/vault/recover-screen";
import { RecoveryKeyCard } from "@/components/vault/recovery-key-card";
import { SettingsDialog } from "@/components/vault/settings-dialog";
import { ShareDialog } from "@/components/vault/share-dialog";
import { SiteHeader } from "@/components/vault/site-header";
import { ToolsView } from "@/components/vault/tools-view";
import { UnlockScreen } from "@/components/vault/unlock-screen";
import { WorkflowsView } from "@/components/vault/workflows-view";
import { getClient, initClient, lock } from "@/vault-store";
import { cn } from "@/lib/utils";

interface LoginData {
  type: "login";
  title: string;
  fields: { url: string; username: string; password: string };
}
interface TotpData {
  type: "totp";
  key: string;
  secret: string;
  issuer?: string;
  account?: string;
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}
interface NoteData {
  type: "note";
  title: string;
  body: string;
}
interface SecretData {
  type: "secret";
  key: string;
  value: string;
}
type Phase = "login" | "account" | "device-pending" | "recover" | "enroll" | "unlocked";

// PulledItem.data is JsonValue | null. The strict union doesn't structurally overlap with
// our concrete item shapes, so we cast through `unknown` after discriminating on `type`.
const asLogin = (i: PulledItem): LoginData | null => {
  const d = i.data as unknown as { type?: string } | null;
  return d?.type === "login" ? (i.data as unknown as LoginData) : null;
};
const asTotp = (i: PulledItem): TotpData | null => {
  const d = i.data as unknown as { type?: string } | null;
  return d?.type === "totp" ? (i.data as unknown as TotpData) : null;
};
const asNote = (i: PulledItem): NoteData | null => {
  const d = i.data as unknown as { type?: string } | null;
  return d?.type === "note" ? (i.data as unknown as NoteData) : null;
};
const asSecret = (i: PulledItem): SecretData | null => {
  const d = i.data as unknown as { type?: string } | null;
  return d?.type === "secret" ? (i.data as unknown as SecretData) : null;
};
const itemTitle = (i: PulledItem): string =>
  asLogin(i)?.title ?? asTotp(i)?.key ?? asNote(i)?.title ?? asSecret(i)?.key ?? i.id;
const itemSubtitle = (i: PulledItem): string => {
  const l = asLogin(i);
  if (l) return l.fields.username;
  const t = asTotp(i);
  if (t) return t.issuer ? `${t.issuer}${t.account ? ` · ${t.account}` : ""}` : (t.account ?? "TOTP");
  const n = asNote(i);
  if (n) return n.body.split("\n")[0]?.slice(0, 60) ?? "Note";
  if (asSecret(i)) return "Secret";
  return "";
};

export function VaultApp() {
  const [phase, setPhase] = React.useState<Phase>("login");
  const [busy, setBusy] = React.useState(false);
  const [recoveryKey, setRecoveryKey] = React.useState<string | null>(null);
  const [vaults, setVaults] = React.useState<VaultSummary[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<PulledItem[]>([]);
  const [activeItem, setActiveItem] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [autolock, setAutolock] = React.useState(5);
  const [deviceMode, setDeviceMode] = React.useState(false);
  const [deviceId, setDeviceId] = React.useState<string | null>(null);
  const [deviceCode, setDeviceCode] = React.useState("");
  const [folders, setFolders] = React.useState<VaultFolder[]>([]);
  const [folderFilter, setFolderFilter] = React.useState<string | null>(null);
  const [section, setSection] = React.useState<ConsoleSection>("vault");
  const [persona, setPersona] = React.useState<Persona>("person");
  const [density, setDensity] = React.useState<Density>("comfortable");

  React.useEffect(() => {
    const stored = Number(localStorage.getItem("arc-vault-autolock"));
    if (stored) setAutolock(stored);
  }, []);

  const setAutolockPersist = (minutes: number) => {
    setAutolock(minutes);
    localStorage.setItem("arc-vault-autolock", String(minutes));
  };

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
    setFolderFilter(null);
    const { items } = await getClient().pull(id, 0);
    setItems(items.filter((i) => !i.deleted));
    try {
      setFolders(await getClient().listFolders(id));
    } catch {
      setFolders([]);
    }
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

  const unlockWithPasskey = () =>
    guard(async () => {
      const { browserPasskeyAuthenticator } = await import("@arc/sdk");
      await getClient().unlockWithPasskey(browserPasskeyAuthenticator());
      await loadVaults();
      setPhase("unlocked");
      toast.success("Vault unlocked with passkey");
    });

  // Enrollment ceremony (design system `enroll.html`): create the vault + keys, then hold
  // on the "enroll" phase so EnrollScreen can run the recovery-key ceremony BEFORE the
  // vault opens. Same enroll() crypto + same recovery key — only the moment it's surfaced
  // moves (forced acknowledge-before-proceed). `completeEnroll` then loads + unlocks.
  const enroll = (password: string) =>
    guard(async () => {
      const result = await getClient().enroll(password);
      setRecoveryKey(result.recoveryKey);
      // stay on phase "enroll"; the ceremony advances once recoveryKey is set.
    });

  const completeEnroll = () =>
    guard(async () => {
      await loadVaults();
      setRecoveryKey(null); // already shown + acknowledged in the ceremony
      setPhase("unlocked");
      toast.success("Vault created");
    });

  // ADR-006: recover with the recovery key + a new password. On success the client is
  // unlocked with the same identity; we surface the *new* recovery key for the user to save.
  const recoverWithKey = (recoveryKeyInput: string, newPassword: string) =>
    guard(async () => {
      const result = await getClient().recoverWithKey(recoveryKeyInput, newPassword);
      setRecoveryKey(result.recoveryKey);
      await loadVaults();
      setPhase("unlocked");
      toast.success("Vault recovered — your new recovery key is shown below");
    });

  const startNewDevice = () =>
    guard(async () => {
      const r = await getClient().registerDevice("Web device");
      setDeviceId(r.deviceId);
      setDeviceCode(r.verificationCode);
      setPhase("device-pending");
    });

  const pollApproval = async (announce: boolean) => {
    if (!deviceId) return;
    try {
      const granted = await getClient().loadDeviceGrants(deviceId);
      if (granted.length > 0) {
        setDeviceMode(true);
        const dv = await getClient().listDeviceVaults();
        setVaults(dv);
        if (dv[0]) await openVault(dv[0].id);
        setPhase("unlocked");
        toast.success("Device approved");
      } else if (announce) {
        toast("Not approved yet");
      }
    } catch (e) {
      if (announce) toast.error((e as Error).message);
    }
  };

  const createVault = (type: VaultType, name: string) =>
    guard(async () => {
      const v = await getClient().createVault(type, name);
      await loadVaults();
      await openVault(v.id);
      toast.success("Vault created");
    });

  const saveLogin = (value: LoginInput, folderId: string | null, existing?: PulledItem) =>
    guard(async () => {
      if (!selected) return;
      const data = { type: "login", title: value.title, fields: { url: value.url, username: value.username, password: value.password } };
      const opts = existing
        ? { id: existing.id, baseVersion: existing.version, type: "login", folderId }
        : { type: "login", folderId };
      await getClient().putItem(selected, data, opts);
      await openVault(selected);
      if (existing) setActiveItem(existing.id);
      toast.success("Saved");
    });

  const saveTotp = (value: TotpInput, folderId: string | null, existing?: PulledItem) =>
    guard(async () => {
      if (!selected) return;
      const payload: TotpData = {
        type: "totp",
        key: value.key,
        secret: value.secret,
        ...(value.issuer ? { issuer: value.issuer } : {}),
        ...(value.account ? { account: value.account } : {}),
      };
      const opts = existing
        ? { id: existing.id, baseVersion: existing.version, type: "totp", folderId }
        : { type: "totp", folderId };
      // Concrete item shapes are structurally JsonValue; the cast satisfies the SDK's
      // broader parameter type (same pattern as the CLI's totp-add).
      await getClient().putItem(selected, payload as unknown as JsonValue, opts);
      await openVault(selected);
      if (existing) setActiveItem(existing.id);
      toast.success("Saved");
    });

  const saveNote = (value: NoteInput, folderId: string | null, existing?: PulledItem) =>
    guard(async () => {
      if (!selected) return;
      const payload: NoteData = { type: "note", title: value.title, body: value.body };
      const opts = existing
        ? { id: existing.id, baseVersion: existing.version, type: "note", folderId }
        : { type: "note", folderId };
      await getClient().putItem(selected, payload as unknown as JsonValue, opts);
      await openVault(selected);
      if (existing) setActiveItem(existing.id);
      toast.success("Saved");
    });

  const saveSecret = (value: SecretInput, folderId: string | null, existing?: PulledItem) =>
    guard(async () => {
      if (!selected) return;
      const payload: SecretData = { type: "secret", key: value.key, value: value.value };
      const opts = existing
        ? { id: existing.id, baseVersion: existing.version, type: "secret", folderId }
        : { type: "secret", folderId };
      await getClient().putItem(selected, payload as unknown as JsonValue, opts);
      await openVault(selected);
      if (existing) setActiveItem(existing.id);
      toast.success("Saved");
    });

  const createFolder = (name: string) =>
    guard(async () => {
      if (!selected) return;
      await getClient().createFolder(selected, name);
      setFolders(await getClient().listFolders(selected));
      toast.success("Folder created");
    });

  const deleteFolderAction = () =>
    guard(async () => {
      if (!selected || !folderFilter) return;
      await getClient().deleteFolder(selected, folderFilter);
      setFolderFilter(null);
      setFolders(await getClient().listFolders(selected));
      toast.success("Folder deleted");
    });

  const deleteItem = (item: PulledItem) =>
    guard(async () => {
      if (!selected) return;
      await getClient().deleteItem(selected, item.id);
      setConfirmDelete(false);
      await openVault(selected);
      toast.success("Deleted");
    });

  const rotateVaultKey = () =>
    guard(async () => {
      if (!selected) return;
      await getClient().rotateForAllMembers(selected);
      setVaults(await getClient().listVaults());
      await openVault(selected);
      toast.success("Vault key rotated");
    });

  const doLock = () => {
    lock();
    setPhase("login");
    setVaults([]);
    setItems([]);
    setSelected(null);
    setRecoveryKey(null);
    setActiveItem(null);
    setQuery("");
    setDeviceMode(false);
    setDeviceId(null);
    setDeviceCode("");
    setFolders([]);
    setFolderFilter(null);
    setSection("vault");
    setPersona("person");
  };

  // Poll for device approval while waiting (docs/06 §6.3).
  React.useEffect(() => {
    if (phase !== "device-pending") return;
    const t = setInterval(() => void pollApproval(false), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, deviceId]);

  // Idle auto-lock (docs/12 §12.3): wipe in-memory keys after `autolock` minutes of inactivity.
  React.useEffect(() => {
    if (phase !== "unlocked") return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        doLock();
        toast("Locked due to inactivity");
      }, autolock * 60_000);
    };
    const events = ["mousemove", "keydown", "click", "scroll"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, autolock]);

  // Desktop shell (Tauri): mirror the autolock setting into the Rust session and listen
  // for the shell-emitted lock event so the OS-level idle TTL drives the same UX as the
  // browser-side input listeners above. No-op in the regular browser.
  React.useEffect(() => {
    let unlistenLocked: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const tauri = await import("@/lib/tauri");
      if (!tauri.isDesktop()) return;
      try {
        await tauri.setAutolock(autolock * 60);
        unlistenLocked = await tauri.onLocked(() => {
          if (cancelled) return;
          doLock();
          toast("Locked due to inactivity");
        });
      } catch {
        /* shell not actually wired (browser build); ignore */
      }
    })();
    return () => {
      cancelled = true;
      unlistenLocked?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, autolock]);

  if (phase === "device-pending") {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <DevicePendingView code={deviceCode} onCheck={() => pollApproval(true)} onCancel={doLock} />
      </div>
    );
  }

  if (phase === "recover") {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <RecoverScreen busy={busy} onRecover={recoverWithKey} onBack={() => setPhase("account")} />
      </div>
    );
  }

  if (phase === "enroll") {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <EnrollScreen
          busy={busy}
          recoveryKey={recoveryKey}
          onEnroll={enroll}
          onComplete={completeEnroll}
          onBack={() => {
            setRecoveryKey(null);
            setPhase("account");
          }}
        />
      </div>
    );
  }

  if (phase !== "unlocked") {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <UnlockScreen
          phase={phase}
          busy={busy}
          onSignIn={signIn}
          onUnlock={unlock}
          onStartEnroll={() => setPhase("enroll")}
          onNewDevice={startNewDevice}
          onPasskeyUnlock={unlockWithPasskey}
          onForgotPassword={phase === "account" ? () => setPhase("recover") : undefined}
        />
      </div>
    );
  }

  const selectedVault = vaults.find((v) => v.id === selected);
  const canManage = !deviceMode && (selectedVault?.role === "owner" || selectedVault?.role === "admin");
  const active = items.find((i) => i.id === activeItem);
  const activeLogin = active ? asLogin(active) : null;
  const activeTotp = active ? asTotp(active) : null;
  const activeNote = active ? asNote(active) : null;
  const activeSecret = active ? asSecret(active) : null;
  const activeTitle = active ? itemTitle(active) : null;
  const q = query.trim().toLowerCase();
  const filtered = items.filter((i) => {
    if (folderFilter && i.folderId !== folderFilter) return false;
    if (!q) return true;
    const l = asLogin(i);
    if (l) return [l.title, l.fields.username, l.fields.url].some((s) => s?.toLowerCase().includes(q));
    const t = asTotp(i);
    if (t) return [t.key, t.issuer, t.account].some((s) => s?.toLowerCase().includes(q));
    const n = asNote(i);
    if (n) return [n.title, n.body].some((s) => s?.toLowerCase().includes(q));
    const s = asSecret(i);
    if (s) return [s.key, s.value].some((str) => str?.toLowerCase().includes(q));
    return i.id.toLowerCase().includes(q);
  });

  return (
    <>
      <ConsoleShell
        persona={persona}
        onPersona={setPersona}
        section={section}
        onSection={setSection}
        density={density}
        onDensity={setDensity}
        vaultName={selectedVault?.name ?? selectedVault?.type}
        statusLabel={deviceMode ? "Device session" : "Unlocked"}
        onLock={doLock}
        actions={
          <>
            {!deviceMode && (
              <DevicesDialog
                onLoad={() => getClient().listPendingDevices()}
                onApprove={async (d) => {
                  await getClient().approveDevice(d.id, d.publicKey);
                  toast.success("Device approved");
                }}
              />
            )}
            <SettingsDialog
              autolock={autolock}
              onAutolock={setAutolockPersist}
              client={getClient()}
            />
          </>
        }
      >
        {section === "home" && (
          <PreviewScreen
            eyebrow="You · home"
            title="Home"
            description="Your security score, recent activity, devices, and the governed-agents teaser — one persona-aware landing."
            icon={House}
            engine="Engine B"
          />
        )}
        {section === "security" && (
          <PreviewScreen
            eyebrow="You · security"
            title="Security dashboard"
            description="Weak, reused, old and exposed items, passkey coverage, and device hygiene — a motivating security score."
            icon={ShieldCheck}
            engine="Engine B"
          />
        )}
        {section === "devices" && (
          <PreviewScreen
            eyebrow="You · devices"
            title="My devices"
            description="Every device that can unlock your vault, with last-seen, the trusted flag, and the inactivity auto-revoke nudge."
            icon={Cpu}
            engine="Engine B"
          />
        )}
        {section === "kv" && (
          <PreviewScreen
            eyebrow="Engine A · infrastructure"
            title="KV secrets"
            description="The secret/app/prod/db path tree, version history, soft-delete/undelete, metadata, and a version diff."
            icon={GitBranch}
            engine="Engine A"
          />
        )}
        {section === "creds" && (
          <PreviewScreen
            eyebrow="Engine A · infrastructure"
            title="Dynamic credentials"
            description="Per-mount roles (AWS STS, GCP, GitHub App, database…) with an issue-credential ceremony and live lease TTL."
            icon={KeyRound}
            engine="Engine A"
          />
        )}
        {section === "transit" && (
          <PreviewScreen
            eyebrow="Engine A · infrastructure"
            title="Transit"
            description="Encryption-as-a-service: key list, encrypt/decrypt playground, rotate-key, and key versions."
            icon={RefreshCw}
            engine="Engine A"
          />
        )}
        {section === "pki" && (
          <PreviewScreen
            eyebrow="Engine A · infrastructure"
            title="PKI"
            description="CA chain, roles, an issue-certificate flow, the issued-certs table, and revoke with serial/expiry."
            icon={Shield}
            engine="Engine A"
          />
        )}

        {section === "vault" && (
          <div className="space-y-6">
            {recoveryKey && (
              <RecoveryKeyCard recoveryKey={recoveryKey} onDismiss={() => setRecoveryKey(null)} />
            )}
            <div className="grid gap-6 md:grid-cols-[220px_1fr]">
          <aside className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">Vaults</h2>
              <CreateVaultDialog onCreate={createVault} />
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
                  <span className={cn("truncate", !v.name && "capitalize")}>{v.name ?? v.type}</span>
                  <Badge variant="secondary" className="ml-auto">
                    {v.role}
                  </Badge>
                </button>
              ))}
            </div>
          </aside>

          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-lg font-semibold">Items</h1>
              <div className="flex items-center gap-2">
                {selected && (
                  <>
                    <ItemDialog
                      trigger={
                        <Button size="sm">
                          <Plus className="h-4 w-4" /> Add login
                        </Button>
                      }
                      folders={folders}
                      initialFolderId={folderFilter}
                      onSubmit={(v, f) => saveLogin(v, f)}
                    />
                    <TotpDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          <KeyRound className="h-4 w-4" /> Add TOTP
                        </Button>
                      }
                      folders={folders}
                      initialFolderId={folderFilter}
                      onSubmit={(v, f) => saveTotp(v, f)}
                    />
                    <NoteDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          <FileText className="h-4 w-4" /> Add note
                        </Button>
                      }
                      folders={folders}
                      initialFolderId={folderFilter}
                      onSubmit={(v, f) => saveNote(v, f)}
                    />
                    <SecretDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          <KeySquare className="h-4 w-4" /> Add secret
                        </Button>
                      }
                      folders={folders}
                      initialFolderId={folderFilter}
                      onSubmit={(v, f) => saveSecret(v, f)}
                    />
                    {canManage && (
                      <ShareDialog
                        onLookup={(email) => getClient().getUserIdentityKeyByEmail(email)}
                        onShare={async (userId, role, pub) => {
                          await getClient().addMember(selected, userId, role, pub);
                          toast.success("Access granted");
                        }}
                      />
                    )}
                  </>
                )}
              </div>
            </div>

            {selected && (
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant={folderFilter === null ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFolderFilter(null)}
                >
                  All
                </Button>
                {folders.map((f) => (
                  <Button
                    key={f.id}
                    variant={folderFilter === f.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFolderFilter(f.id)}
                  >
                    <Folder className="h-3.5 w-3.5" /> {f.name}
                  </Button>
                ))}
                <NewFolderDialog onCreate={createFolder} />
                {folderFilter && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={deleteFolderAction}
                    aria-label="Delete folder"
                  >
                    <X className="h-3.5 w-3.5" /> Delete folder
                  </Button>
                )}
              </div>
            )}

            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search items"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Separator />

            {filtered.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {items.length === 0 ? "No items yet. Add a login, TOTP, note, or secret." : "No matches."}
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  {filtered.map((i) => {
                    const title = itemTitle(i);
                    const icon = asTotp(i) ? (
                      <KeyRound className="h-4 w-4" />
                    ) : asNote(i) ? (
                      <FileText className="h-4 w-4" />
                    ) : asSecret(i) ? (
                      <KeySquare className="h-4 w-4" />
                    ) : (
                      title.slice(0, 1).toUpperCase()
                    );
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
                          {icon}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{title}</div>
                          <div className="truncate text-xs text-muted-foreground">{itemSubtitle(i)}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <Card>
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-base">{activeTitle ?? "Select an item"}</CardTitle>
                    {active && (activeLogin || activeTotp || activeNote || activeSecret) && (
                      <div className="flex items-center gap-1">
                        {activeLogin && (
                          <ItemDialog
                            heading="Edit login"
                            initial={{
                              title: activeLogin.title,
                              url: activeLogin.fields.url,
                              username: activeLogin.fields.username,
                              password: activeLogin.fields.password,
                            }}
                            folders={folders}
                            initialFolderId={active.folderId}
                            trigger={
                              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit">
                                <Pencil className="h-4 w-4" />
                              </Button>
                            }
                            onSubmit={(v, f) => saveLogin(v, f, active)}
                          />
                        )}
                        {activeTotp && (
                          <TotpDialog
                            heading="Edit TOTP"
                            initial={{
                              key: activeTotp.key,
                              secret: activeTotp.secret,
                              issuer: activeTotp.issuer ?? "",
                              account: activeTotp.account ?? "",
                            }}
                            folders={folders}
                            initialFolderId={active.folderId}
                            trigger={
                              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit">
                                <Pencil className="h-4 w-4" />
                              </Button>
                            }
                            onSubmit={(v, f) => saveTotp(v, f, active)}
                          />
                        )}
                        {activeNote && (
                          <NoteDialog
                            heading="Edit note"
                            initial={{ title: activeNote.title, body: activeNote.body }}
                            folders={folders}
                            initialFolderId={active.folderId}
                            trigger={
                              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit">
                                <Pencil className="h-4 w-4" />
                              </Button>
                            }
                            onSubmit={(v, f) => saveNote(v, f, active)}
                          />
                        )}
                        {activeSecret && (
                          <SecretDialog
                            heading="Edit secret"
                            initial={{ key: activeSecret.key, value: activeSecret.value }}
                            folders={folders}
                            initialFolderId={active.folderId}
                            trigger={
                              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit">
                                <Pencil className="h-4 w-4" />
                              </Button>
                            }
                            onSubmit={(v, f) => saveSecret(v, f, active)}
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          aria-label="Delete"
                          onClick={() => setConfirmDelete(true)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {activeLogin ? (
                      <>
                        <CopyField label="URL" value={activeLogin.fields.url} />
                        <CopyField label="Username" value={activeLogin.fields.username} />
                        <CopyField label="Password" value={activeLogin.fields.password} secret />
                      </>
                    ) : activeTotp ? (
                      <TotpCard
                        secret={activeTotp.secret}
                        period={activeTotp.period}
                        digits={activeTotp.digits}
                        algorithm={activeTotp.algorithm}
                        issuer={activeTotp.issuer}
                        account={activeTotp.account}
                      />
                    ) : activeNote ? (
                      <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-sm">
                        {activeNote.body}
                      </pre>
                    ) : activeSecret ? (
                      <>
                        <CopyField label="Key" value={activeSecret.key} />
                        <CopyField label="Value" value={activeSecret.value} secret />
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
          </div>
        )}

        {section === "team" &&
          (selected ? (
            <AccessView
              vaultId={selected}
              loadMembers={() => getClient().listMembers(selected)}
              actions={
                <>
                  {canManage && (
                    <ShareDialog
                      onLookup={(email) => getClient().getUserIdentityKeyByEmail(email)}
                      onShare={async (userId, role, pub) => {
                        await getClient().addMember(selected, userId, role, pub);
                        toast.success("Access granted");
                      }}
                    />
                  )}
                  {canManage && (
                    <Button variant="outline" size="sm" onClick={rotateVaultKey} disabled={busy}>
                      <RotateCw className="h-4 w-4" /> Rotate key
                    </Button>
                  )}
                </>
              }
            />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Select a vault under Secrets first.
            </p>
          ))}

        {section === "policies" && <PoliciesView role={selectedVault?.role} />}

        {section === "workflows" && (
          <WorkflowsView vaultId={selected} canManage={canManage} getClient={getClient} />
        )}

        {section === "leases" && (
          <InfoView
            icon={Clock}
            title="Leases"
            description="Time-boxed access grants and break-glass sessions."
            points={[
              "Active time-boxed member grants and their expiry",
              "Break-glass / emergency sessions with a server-enforced TTL",
              "Manual revoke before expiry",
              "Backed by signed grants — see docs/14 (developer platform)",
            ]}
          />
        )}

        {section === "audit" &&
          (selected ? (
            <AuditView
              vaultId={selected}
              loadAudit={(opts) => getClient().listAudit(selected, opts)}
            />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Select a vault under Secrets first.
            </p>
          ))}

        {section === "agents" && (
          <IdentitiesView
            load={() => getClient().listAgents()}
            update={(agentId, patch) => getClient().updateAgent(agentId, patch)}
          />
        )}

        {section === "tools" && <ToolsView />}
      </ConsoleShell>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this item?</DialogTitle>
            <DialogDescription>
              This removes &quot;{activeTitle}&quot; from the vault. It is soft-deleted and
              syncs to your other devices.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => active && deleteItem(active)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
