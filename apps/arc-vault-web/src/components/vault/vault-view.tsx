"use client";

import * as React from "react";
import {
  ChevronDown,
  ExternalLink,
  FileText,
  Folder,
  KeyRound,
  KeySquare,
  MoreHorizontal,
  Pencil,
  Search,
  Share2,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import type { PulledItem, VaultFolder, VaultSummary, VaultType } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/arc/copy-button";
import { MaskedField } from "@/components/arc/masked-field";
import { TotpRing } from "@/components/arc/totp-ring";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { CreateVaultDialog } from "@/components/vault/create-vault-dialog";
import { ItemDialog, type LoginInput } from "@/components/vault/item-dialog";
import { NewFolderDialog } from "@/components/vault/new-folder-dialog";
import { NoteDialog, type NoteInput } from "@/components/vault/note-dialog";
import { RecoveryKeyCard } from "@/components/vault/recovery-key-card";
import { SecretDialog, type SecretInput } from "@/components/vault/secret-dialog";
import {
  ShareDialog,
  type IdentityLookup,
  type Role,
} from "@/components/vault/share-dialog";
import { TotpDialog, type TotpInput } from "@/components/vault/totp-dialog";
import { asLogin, asNote, asSecret, asTotp, itemSubtitle, itemTitle } from "@/lib/items";
import { cn } from "@/lib/utils";

/**
 * Personal-vault master-detail surface — implements the arc-console design-system kit
 * (`ui_kits/arc-console/screens-consumer.js` → `Vault`). Left rail = vault switcher +
 * search + folder chips + item list; right pane = item hero, typed fields, and the
 * e2e trust indicator + edit/delete footer.
 *
 * Presentation only. All decryption + key management still runs through the same SDK
 * paths in `vault-app.tsx`; this view is a callback surface over that state. No new
 * network calls, no new persisted state, no change to the zero-knowledge invariant.
 */
export interface VaultViewProps {
  vaults: VaultSummary[];
  selected: string | null;
  selectedVault?: VaultSummary;
  items: PulledItem[];
  filtered: PulledItem[];
  folders: VaultFolder[];
  folderFilter: string | null;
  query: string;
  activeItem: string | null;
  active?: PulledItem;
  canManage: boolean;
  recoveryKey: string | null;
  onSelectVault: (id: string) => void;
  onCreateVault: (type: VaultType, name: string) => Promise<void>;
  onCreateFolder: (name: string) => Promise<void>;
  onDeleteFolder: () => void;
  onSelectFolder: (id: string | null) => void;
  onSelectItem: (id: string | null) => void;
  onQueryChange: (q: string) => void;
  onSaveLogin: (v: LoginInput, folderId: string | null, existing?: PulledItem) => Promise<void>;
  onSaveTotp: (v: TotpInput, folderId: string | null, existing?: PulledItem) => Promise<void>;
  onSaveNote: (v: NoteInput, folderId: string | null, existing?: PulledItem) => Promise<void>;
  onSaveSecret: (v: SecretInput, folderId: string | null, existing?: PulledItem) => Promise<void>;
  onRequestDelete: () => void;
  onDismissRecoveryKey: () => void;
  onShareLookup: (email: string) => Promise<IdentityLookup>;
  onShareGrant: (
    userId: number,
    role: Role,
    identity: { identityPubB64: string; identityPubMlkemB64: string },
  ) => Promise<void>;
}

export function VaultView(props: VaultViewProps) {
  const { recoveryKey, onDismissRecoveryKey, selected } = props;
  return (
    <div className="space-y-6">
      {recoveryKey ? (
        <RecoveryKeyCard recoveryKey={recoveryKey} onDismiss={onDismissRecoveryKey} />
      ) : null}

      {selected ? (
        <MasterDetail {...props} />
      ) : (
        <EmptyVaults
          onCreate={props.onCreateVault}
          vaults={props.vaults}
          onSelectVault={props.onSelectVault}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Master-detail (matches the kit's `.vault` layout: 340px list + 1fr detail)
// ────────────────────────────────────────────────────────────────────────────────

function MasterDetail(props: VaultViewProps) {
  return (
    <div className="grid min-h-[560px] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] md:grid-cols-[340px_1fr]">
      <ItemList {...props} />
      <DetailPane {...props} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Left rail: vault switcher + search + folder chips + item list
// ────────────────────────────────────────────────────────────────────────────────

function ItemList(props: VaultViewProps) {
  const {
    vaults,
    selected,
    selectedVault,
    items,
    filtered,
    folders,
    folderFilter,
    query,
    activeItem,
    canManage,
    onSelectVault,
    onCreateVault,
    onCreateFolder,
    onDeleteFolder,
    onSelectFolder,
    onSelectItem,
    onQueryChange,
    onSaveLogin,
    onSaveTotp,
    onSaveNote,
    onSaveSecret,
    onShareLookup,
    onShareGrant,
  } = props;
  const addDisabled = !selected;

  return (
    <aside className="flex min-h-0 flex-col border-b border-border bg-[var(--surface-base)] md:border-b-0 md:border-r">
      <div className="flex flex-col gap-2.5 border-b border-border/60 p-3.5">
        <VaultSwitcher
          vaults={vaults}
          selected={selected}
          selectedName={selectedVault?.name ?? selectedVault?.type}
          onSelect={onSelectVault}
          onCreate={onCreateVault}
        />

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={items.length ? `Search ${items.length} items…` : "Search items…"}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="h-9 pl-8 text-sm"
          />
        </div>

        {selected ? (
          <FolderStrip
            folders={folders}
            folderFilter={folderFilter}
            onSelectFolder={onSelectFolder}
            onCreateFolder={onCreateFolder}
            onDeleteFolder={onDeleteFolder}
          />
        ) : null}

        <div className="flex items-center justify-between gap-1.5">
          <AddMenu
            disabled={addDisabled}
            folders={folders}
            initialFolderId={folderFilter}
            onSaveLogin={onSaveLogin}
            onSaveTotp={onSaveTotp}
            onSaveNote={onSaveNote}
            onSaveSecret={onSaveSecret}
          />
          {canManage ? (
            <ShareDialog onLookup={onShareLookup} onShare={onShareGrant} />
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            {items.length === 0
              ? "No items yet. Add a login, TOTP, note, or secret."
              : "No matches."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((item) => (
              <li key={item.id}>
                <ItemRow
                  item={item}
                  active={activeItem === item.id}
                  onSelect={() => onSelectItem(item.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function VaultSwitcher({
  vaults,
  selected,
  selectedName,
  onSelect,
  onCreate,
}: {
  vaults: VaultSummary[];
  selected: string | null;
  selectedName?: string;
  onSelect: (id: string) => void;
  onCreate: (type: VaultType, name: string) => Promise<void>;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex flex-1 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-2.5 py-2 text-left transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-primary/12 text-primary ring-1 ring-primary/20">
              <Shield className="h-3 w-3" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {selectedName ?? "Select a vault"}
              </span>
              {selected ? (
                <span className="block truncate text-[11px] text-muted-foreground">
                  {vaults.length} {vaults.length === 1 ? "vault" : "vaults"} available
                </span>
              ) : null}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[260px]">
          <DropdownMenuLabel>Open a vault</DropdownMenuLabel>
          {vaults.map((v) => (
            <DropdownMenuItem
              key={v.id}
              onSelect={() => onSelect(v.id)}
              className="flex items-center gap-2"
            >
              <Shield className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={cn("flex-1 truncate", !v.name && "capitalize")}>
                {v.name ?? v.type}
              </span>
              <Badge variant="secondary" className="ml-1 capitalize">
                {v.role}
              </Badge>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* CreateVaultDialog renders its own trigger (icon button), placed next to the
          switcher so "new vault" stays one click away whichever vault is open. */}
      <CreateVaultDialog onCreate={onCreate} />
    </div>
  );
}

function FolderStrip({
  folders,
  folderFilter,
  onSelectFolder,
  onCreateFolder,
  onDeleteFolder,
}: {
  folders: VaultFolder[];
  folderFilter: string | null;
  onSelectFolder: (id: string | null) => void;
  onCreateFolder: (name: string) => Promise<void>;
  onDeleteFolder: () => void;
}) {
  if (folders.length === 0) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
          Folders
        </span>
        <NewFolderDialog onCreate={onCreateFolder} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <FolderChip active={folderFilter === null} onClick={() => onSelectFolder(null)}>
        All
      </FolderChip>
      {folders.map((f) => (
        <FolderChip
          key={f.id}
          active={folderFilter === f.id}
          onClick={() => onSelectFolder(f.id)}
          icon={<Folder className="h-3 w-3" />}
        >
          {f.name}
        </FolderChip>
      ))}
      <NewFolderDialog onCreate={onCreateFolder} />
      {folderFilter ? (
        <button
          type="button"
          onClick={onDeleteFolder}
          className="ml-auto inline-flex h-6 items-center gap-0.5 rounded-full px-1.5 text-[11px] text-destructive transition-colors hover:bg-destructive/10"
          aria-label="Delete folder"
          title="Delete folder"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function FolderChip({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors",
        active
          ? "border-primary/40 bg-primary/12 text-primary"
          : "border-border bg-[var(--surface-inset)] text-muted-foreground hover:border-[var(--border-strong)] hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function AddMenu({
  disabled,
  folders,
  initialFolderId,
  onSaveLogin,
  onSaveTotp,
  onSaveNote,
  onSaveSecret,
}: {
  disabled: boolean;
  folders: VaultFolder[];
  initialFolderId: string | null;
  onSaveLogin: VaultViewProps["onSaveLogin"];
  onSaveTotp: VaultViewProps["onSaveTotp"];
  onSaveNote: VaultViewProps["onSaveNote"];
  onSaveSecret: VaultViewProps["onSaveSecret"];
}) {
  // Each `*Dialog` owns its trigger + open state — so we render four small icon triggers
  // rather than a dropdown that would need controlled `open` props the dialogs don't
  // expose. Keeps every dialog's existing flow (validation, generators) untouched.
  const triggerCls =
    "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-border bg-[var(--surface-raised)] text-[12px] font-medium text-foreground transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50";
  const trig = (icon: React.ReactNode, label: string, title: string) => (
    <button type="button" disabled={disabled} className={triggerCls} title={title}>
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
  return (
    <div className="flex w-full items-stretch gap-1.5">
      <ItemDialog
        folders={folders}
        initialFolderId={initialFolderId}
        onSubmit={(v, f) => onSaveLogin(v, f)}
        trigger={trig(<Shield className="h-3.5 w-3.5" />, "Login", "Add login")}
      />
      <TotpDialog
        folders={folders}
        initialFolderId={initialFolderId}
        onSubmit={(v, f) => onSaveTotp(v, f)}
        trigger={trig(<KeyRound className="h-3.5 w-3.5" />, "TOTP", "Add TOTP")}
      />
      <NoteDialog
        folders={folders}
        initialFolderId={initialFolderId}
        onSubmit={(v, f) => onSaveNote(v, f)}
        trigger={trig(<FileText className="h-3.5 w-3.5" />, "Note", "Add secure note")}
      />
      <SecretDialog
        folders={folders}
        initialFolderId={initialFolderId}
        onSubmit={(v, f) => onSaveSecret(v, f)}
        trigger={trig(<KeySquare className="h-3.5 w-3.5" />, "Secret", "Add generic secret")}
      />
    </div>
  );
}

function ItemRow({
  item,
  active,
  onSelect,
}: {
  item: PulledItem;
  active: boolean;
  onSelect: () => void;
}) {
  const totp = asTotp(item);
  const note = asNote(item);
  const secret = asSecret(item);
  const login = asLogin(item);
  const title = itemTitle(item);
  const sub = itemSubtitle(item);
  const weak = login ? isWeakPassword(login.fields.password) : false;
  const typeIcon = totp ? <KeyRound className="h-3.5 w-3.5" /> : note ? <FileText className="h-3.5 w-3.5" /> : secret ? <KeySquare className="h-3.5 w-3.5" /> : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left",
        "transition-colors [transition-duration:var(--dur-fast)]",
        active
          ? "bg-[var(--ds-accent-subtle)] text-[var(--ds-accent-subtle-fg)]"
          : "hover:bg-[var(--surface-hover)]",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border bg-[var(--surface-raised)] font-mono text-[13px] font-semibold text-muted-foreground">
        {typeIcon ?? title.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
      {weak ? (
        <Badge variant="secondary" className="bg-[var(--danger-subtle)] text-[var(--danger-fg)]">
          weak
        </Badge>
      ) : null}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Right pane: item detail
// ────────────────────────────────────────────────────────────────────────────────

function DetailPane(props: VaultViewProps) {
  const { active, folders, folderFilter, onSaveLogin, onSaveTotp, onSaveNote, onSaveSecret, onRequestDelete } = props;
  if (!active) {
    return (
      <section className="flex min-h-0 items-center justify-center bg-[var(--surface-sunken)] p-10 text-center">
        <div className="max-w-xs space-y-2">
          <h3 className="font-display text-base font-semibold">Pick an item</h3>
          <p className="text-sm text-muted-foreground">
            Select something on the left to see its fields. Everything is decrypted on this device.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="min-h-0 overflow-y-auto bg-[var(--surface-sunken)]">
      <div className="mx-auto max-w-[560px] px-7 py-7">
        <DetailHero item={active} />
        <DetailFields item={active} />
        <DetailFooter
          item={active}
          folders={folders}
          folderId={active.folderId ?? folderFilter}
          onSaveLogin={onSaveLogin}
          onSaveTotp={onSaveTotp}
          onSaveNote={onSaveNote}
          onSaveSecret={onSaveSecret}
          onRequestDelete={onRequestDelete}
        />
      </div>
    </section>
  );
}

function DetailHero({ item }: { item: PulledItem }) {
  const totp = asTotp(item);
  const note = asNote(item);
  const secret = asSecret(item);
  const login = asLogin(item);
  const title = itemTitle(item);
  const kindLabel = totp ? "One-time code" : note ? "Secure note" : secret ? "Secret" : login ? "Login" : "Item";
  const icon = totp ? (
    <KeyRound className="h-5 w-5" />
  ) : note ? (
    <FileText className="h-5 w-5" />
  ) : secret ? (
    <KeySquare className="h-5 w-5" />
  ) : null;
  return (
    <div className="mb-6 flex items-center gap-4">
      <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-border bg-[var(--surface-raised)] font-display text-[20px] font-semibold text-muted-foreground">
        {icon ?? title.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-display text-[22px] font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{kindLabel}</p>
      </div>
      <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Share" disabled>
        <Share2 className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="More" disabled>
        <MoreHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}

function DetailFields({ item }: { item: PulledItem }) {
  const login = asLogin(item);
  const totp = asTotp(item);
  const note = asNote(item);
  const secret = asSecret(item);

  if (login) {
    const { url, username, password } = login.fields;
    const weak = isWeakPassword(password);
    return (
      <div className="space-y-4">
        {username ? (
          <Field label="Username">
            <ValueRow mono value={username}>
              <CopyButton value={username} iconOnly autoClearSeconds={0} />
            </ValueRow>
          </Field>
        ) : null}
        <Field
          label={
            <span className="flex items-center gap-2">
              Password
              {weak ? (
                <Badge variant="secondary" className="bg-[var(--danger-subtle)] text-[var(--danger-fg)]">
                  weak
                </Badge>
              ) : null}
            </span>
          }
        >
          <MaskedField value={password} />
        </Field>
        {url ? (
          <Field label="Website">
            <ValueRow value={url}>
              <a
                href={url.startsWith("http") ? url : `https://${url}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground"
                aria-label="Open in new tab"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </ValueRow>
          </Field>
        ) : null}
      </div>
    );
  }

  if (totp) {
    return (
      <div className="space-y-4">
        <Field label="One-time code (2FA)">
          <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-3 py-2.5">
            <TotpRing code={"••••••"} period={totp.period ?? 30} />
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              refreshes every {totp.period ?? 30}s
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Code is computed on this device from the stored secret. Open Edit to update the
            seed.
          </p>
        </Field>
        {totp.issuer ? <Field label="Issuer"><ValueRow value={totp.issuer} /></Field> : null}
        {totp.account ? <Field label="Account"><ValueRow value={totp.account} /></Field> : null}
      </div>
    );
  }

  if (note) {
    return (
      <Field label="Note">
        <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] p-3.5 font-mono text-sm leading-relaxed">
          {note.body}
        </pre>
      </Field>
    );
  }

  if (secret) {
    return (
      <div className="space-y-4">
        <Field label="Key">
          <ValueRow mono value={secret.key}>
            <CopyButton value={secret.key} iconOnly autoClearSeconds={0} />
          </ValueRow>
        </Field>
        <Field label="Value">
          <MaskedField value={secret.value} />
        </Field>
      </div>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">This item type has no detail panel yet.</p>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ValueRow({
  value,
  mono,
  children,
}: {
  value: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-10 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] pl-3.5 pr-1.5">
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm text-foreground",
          mono && "font-mono",
        )}
      >
        {value}
      </span>
      {children}
    </div>
  );
}

function DetailFooter({
  item,
  folders,
  folderId,
  onSaveLogin,
  onSaveTotp,
  onSaveNote,
  onSaveSecret,
  onRequestDelete,
}: {
  item: PulledItem;
  folders: VaultFolder[];
  folderId: string | null;
  onSaveLogin: VaultViewProps["onSaveLogin"];
  onSaveTotp: VaultViewProps["onSaveTotp"];
  onSaveNote: VaultViewProps["onSaveNote"];
  onSaveSecret: VaultViewProps["onSaveSecret"];
  onRequestDelete: () => void;
}) {
  const login = asLogin(item);
  const totp = asTotp(item);
  const note = asNote(item);
  const secret = asSecret(item);

  const editTrigger = (
    <Button variant="secondary" size="sm">
      <Pencil className="h-3.5 w-3.5" /> Edit
    </Button>
  );

  return (
    <div className="mt-6 flex items-center gap-2 border-t border-border/60 pt-4">
      <TrustIndicator kind="e2e" />
      <span className="ml-auto" />
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onRequestDelete}
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </Button>
      {login ? (
        <ItemDialog
          heading="Edit login"
          initial={{
            title: login.title,
            url: login.fields.url,
            username: login.fields.username,
            password: login.fields.password,
          }}
          folders={folders}
          initialFolderId={folderId}
          trigger={editTrigger}
          onSubmit={(v, f) => onSaveLogin(v, f, item)}
        />
      ) : null}
      {totp ? (
        <TotpDialog
          heading="Edit TOTP"
          initial={{
            key: totp.key,
            secret: totp.secret,
            issuer: totp.issuer ?? "",
            account: totp.account ?? "",
          }}
          folders={folders}
          initialFolderId={folderId}
          trigger={editTrigger}
          onSubmit={(v, f) => onSaveTotp(v, f, item)}
        />
      ) : null}
      {note ? (
        <NoteDialog
          heading="Edit note"
          initial={{ title: note.title, body: note.body }}
          folders={folders}
          initialFolderId={folderId}
          trigger={editTrigger}
          onSubmit={(v, f) => onSaveNote(v, f, item)}
        />
      ) : null}
      {secret ? (
        <SecretDialog
          heading="Edit secret"
          initial={{ key: secret.key, value: secret.value }}
          folders={folders}
          initialFolderId={folderId}
          trigger={editTrigger}
          onSubmit={(v, f) => onSaveSecret(v, f, item)}
        />
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Empty state when there is literally no selected/existing vault
// ────────────────────────────────────────────────────────────────────────────────

function EmptyVaults({
  vaults,
  onSelectVault,
  onCreate,
}: {
  vaults: VaultSummary[];
  onSelectVault: (id: string) => void;
  onCreate: (type: VaultType, name: string) => Promise<void>;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-[var(--surface-raised)] p-10 text-center">
      <h3 className="font-display text-lg font-semibold">Open or create a vault</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Vaults hold logins, TOTPs, notes, and secrets — encrypted under a key only your
        devices know.
      </p>
      <div className="mt-5 flex items-center justify-center gap-2">
        {vaults.slice(0, 3).map((v) => (
          <Button key={v.id} variant="outline" size="sm" onClick={() => onSelectVault(v.id)}>
            <Shield className="h-3.5 w-3.5" />
            <span className={cn(!v.name && "capitalize")}>{v.name ?? v.type}</span>
          </Button>
        ))}
        <CreateVaultDialog onCreate={onCreate} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

/** Lightweight "is this password weak" heuristic for the inline badge — matches the
 *  Security dashboard's classifier shape (short, dictionary-ish, all-letter or all-digit).
 *  We don't import the real analyser here because it operates over the whole item set;
 *  this is a fast per-item glance. */
function isWeakPassword(p: string): boolean {
  if (!p) return false;
  if (p.length < 10) return true;
  if (!/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/[0-9]/.test(p)) return true;
  return false;
}
