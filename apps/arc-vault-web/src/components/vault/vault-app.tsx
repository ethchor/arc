"use client";

import * as React from "react";
import { Clock, FileClock, KeyRound, RefreshCw, RotateCw, Shield } from "lucide-react";
import type { PulledItem, VaultFolder, VaultSummary, VaultType } from "@arc/sdk";
import type { JsonValue, TotpAlgorithm } from "@arc/types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccessView } from "@/components/vault/access-view";
import { AuditView } from "@/components/vault/audit-view";
import {
  ConsoleShell,
  type ConsoleSection,
  type Density,
  type Persona,
} from "@/components/vault/console-shell";
import { PreviewScreen } from "@/components/vault/preview-screen";
import { DevicesView } from "@/components/vault/devices-view";
import { HomeView } from "@/components/vault/home-view";
import { SecurityView } from "@/components/vault/security-view";
import { IdentitiesView } from "@/components/vault/identities-view";
import { DevicePendingView } from "@/components/vault/device-pending-view";
import { EnrollScreen } from "@/components/vault/enroll-screen";
import { DevicesDialog } from "@/components/vault/devices-dialog";
import { InfoView } from "@/components/vault/info-view";
import { KvView } from "@/components/vault/kv-view";
import type { LoginInput } from "@/components/vault/item-dialog";
import type { NoteInput } from "@/components/vault/note-dialog";
import type { SecretInput } from "@/components/vault/secret-dialog";
import type { TotpInput } from "@/components/vault/totp-dialog";
import { PoliciesView } from "@/components/vault/policies-view";
import { RecoverScreen } from "@/components/vault/recover-screen";
import { SettingsDialog } from "@/components/vault/settings-dialog";
import { ShareDialog } from "@/components/vault/share-dialog";
import { SiteHeader } from "@/components/vault/site-header";
import { ToolsView } from "@/components/vault/tools-view";
import { UnlockScreen } from "@/components/vault/unlock-screen";
import { VaultView } from "@/components/vault/vault-view";
import { WorkflowsView } from "@/components/vault/workflows-view";
import { getClient, initClient, lock } from "@/vault-store";
import { cn } from "@/lib/utils";

import {
  asLogin,
  asNote,
  asSecret,
  asTotp,
  itemSubtitle,
  itemTitle,
  type LoginData,
  type NoteData,
  type SecretData,
  type TotpData,
} from "@/lib/items";

type Phase = "login" | "account" | "device-pending" | "recover" | "enroll" | "unlocked";

/**
 * Turn a thrown value into a human-facing toast string. The SDK's `VaultApiError` carries
 * the parsed server body but its `.message` is the generic "arc-vault API error 404"; the
 * real, useful text (e.g. "no passkeys registered") lives on `body.message`, so we surface
 * that when present. Presentation only — never logs or sends anything.
 */
function errorMessage(e: unknown): string {
  const body = (e as { body?: unknown } | null | undefined)?.body;
  let raw: string | null = null;
  if (body && typeof body === "object") {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) raw = m.trim();
  }
  if (!raw) raw = e instanceof Error && e.message ? e.message : "Something went wrong";
  // Server messages are lowercase fragments; a toast reads better capitalized. The text is
  // otherwise unchanged.
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

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
      toast.error(errorMessage(e));
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
      if (announce) toast.error(errorMessage(e));
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
    return <DevicePendingView code={deviceCode} onCheck={() => pollApproval(true)} onCancel={doLock} />;
  }

  if (phase === "recover") {
    return <RecoverScreen busy={busy} onRecover={recoverWithKey} onBack={() => setPhase("account")} />;
  }

  if (phase === "enroll") {
    return (
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
    );
  }

  if (phase !== "unlocked") {
    return (
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
    );
  }

  const selectedVault = vaults.find((v) => v.id === selected);
  const canManage = !deviceMode && (selectedVault?.role === "owner" || selectedVault?.role === "admin");
  const active = items.find((i) => i.id === activeItem);
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
          <HomeView
            items={items}
            vault={selectedVault}
            getClient={getClient}
            onGo={(s) => setSection(s)}
            onAddItem={() => setSection("vault")}
          />
        )}
        {section === "security" && (
          <SecurityView
            items={items}
            onOpenItem={(id) => {
              setSection("vault");
              setActiveItem(id);
            }}
            onFixLogin={async (item, newPassword) => {
              const l = asLogin(item);
              if (!l) return;
              await saveLogin(
                { title: l.title, url: l.fields.url, username: l.fields.username, password: newPassword },
                item.folderId ?? null,
                item,
              );
            }}
          />
        )}
        {section === "devices" && <DevicesView getClient={getClient} />}
        {section === "kv" && <KvView getClient={getClient} />}
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
          <VaultView
            vaults={vaults}
            selected={selected}
            selectedVault={selectedVault}
            items={items}
            filtered={filtered}
            folders={folders}
            folderFilter={folderFilter}
            query={query}
            activeItem={activeItem}
            active={active}
            canManage={canManage}
            recoveryKey={recoveryKey}
            onSelectVault={openVault}
            onCreateVault={createVault}
            onCreateFolder={createFolder}
            onDeleteFolder={deleteFolderAction}
            onSelectFolder={setFolderFilter}
            onSelectItem={setActiveItem}
            onQueryChange={setQuery}
            onSaveLogin={saveLogin}
            onSaveTotp={saveTotp}
            onSaveNote={saveNote}
            onSaveSecret={saveSecret}
            onRequestDelete={() => setConfirmDelete(true)}
            onDismissRecoveryKey={() => setRecoveryKey(null)}
            onShareLookup={(email) => getClient().getUserIdentityKeyByEmail(email)}
            onShareGrant={async (userId, role, pub) => {
              if (!selected) return;
              await getClient().addMember(selected, userId, role, pub);
              toast.success("Access granted");
            }}
          />
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
