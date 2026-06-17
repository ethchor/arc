"use client";

import * as React from "react";
import {
  ChevronDown,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  KeyRound,
  KeySquare,
  Lock,
  MoreHorizontal,
  Pencil,
  Search,
  Share2,
  Shield,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { totpCode } from "@arc/crypto";
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
import { IconTip } from "@/components/ui/tooltip";
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
import type { TotpData } from "@/lib/items";
import { asLogin, asNote, asSecret, asTotp, itemSubtitle, itemTitle } from "@/lib/items";
import { isWeakPassword } from "@/lib/security";
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
  const { recoveryKey, onDismissRecoveryKey, selected, items } = props;
  // The shell renders this section flush (no page gutter, full height), so the
  // master-detail fills the viewport below the top bar. The recovery banner and the empty
  // states keep their own padding so their cards don't butt against the window edges.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {recoveryKey ? (
        <div className="p-4 pb-0">
          <RecoveryKeyCard recoveryKey={recoveryKey} onDismiss={onDismissRecoveryKey} />
        </div>
      ) : null}

      {selected ? (
        items.length === 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <EmptyVaultHero {...props} />
          </div>
        ) : (
          <MasterDetail {...props} />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <EmptyVaults
            onCreate={props.onCreateVault}
            vaults={props.vaults}
            onSelectVault={props.onSelectVault}
          />
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Master-detail (matches the kit's `.vault` layout: 340px list + 1fr detail)
// ────────────────────────────────────────────────────────────────────────────────

function MasterDetail(props: VaultViewProps) {
  // Full-bleed, full-height: no outer card border/rounding and no fixed min-height. Flex
  // (not grid) so the panes reliably stretch to the section height and scroll *internally*
  // via their own `min-h-0 overflow-y-auto` — a long item list never overflows the clipped
  // container. The rail's `md:border-r` is the only divider.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface-base)] md:flex-row">
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
    <aside className="flex min-h-0 flex-col border-b border-border bg-[var(--surface-base)] md:w-[340px] md:shrink-0 md:border-b-0 md:border-r">
      <div className="flex flex-col gap-2 border-b border-border/60 p-3">
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

        <RailActions
          disabled={addDisabled}
          canManage={canManage}
          folders={folders}
          initialFolderId={folderFilter}
          onSaveLogin={onSaveLogin}
          onSaveTotp={onSaveTotp}
          onSaveNote={onSaveNote}
          onSaveSecret={onSaveSecret}
          onCreateFolder={onCreateFolder}
          onShareLookup={onShareLookup}
          onShareGrant={onShareGrant}
        />

        {selected && folders.length > 0 ? (
          <FolderStrip
            folders={folders}
            folderFilter={folderFilter}
            onSelectFolder={onSelectFolder}
            onDeleteFolder={onDeleteFolder}
          />
        ) : null}
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
  // "New vault" now lives at the foot of the dropdown (opening the controlled dialog)
  // rather than as a separate icon beside the switcher — so the switcher reads as a plain
  // select field, matching the design kit's `.vault__switch`.
  const [createOpen, setCreateOpen] = React.useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={selectedName ? `Switch vault — current: ${selectedName}` : "Select a vault"}
            className="flex h-9 w-full items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-2.5 text-left transition-colors [transition-duration:var(--dur-fast)] hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Lock className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-medium",
                !selectedName && "capitalize",
              )}
            >
              {selectedName ?? "Select a vault"}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[260px] overflow-hidden p-0"
        >
          <DropdownMenuLabel>Open a vault</DropdownMenuLabel>
          <div className="max-h-[40vh] overflow-y-auto px-1 pb-1">
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
          </div>
          {/* Sticky footer action — sits below the scrollable vault list. */}
          <div className="border-t border-border p-1">
            <DropdownMenuItem
              onSelect={() => setCreateOpen(true)}
              className="flex items-center gap-2 font-medium text-primary focus:text-primary"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              New vault
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateVaultDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={onCreate} />
    </>
  );
}

function FolderStrip({
  folders,
  folderFilter,
  onSelectFolder,
  onDeleteFolder,
}: {
  folders: VaultFolder[];
  folderFilter: string | null;
  onSelectFolder: (id: string | null) => void;
  onDeleteFolder: () => void;
}) {
  // Caller renders FolderStrip only when folders.length > 0 (the empty-state row was
  // removed; "+ folder" lives in the rail action row now).
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
      {folderFilter ? (
        <IconTip label="Delete folder" hint="Removes this folder; its items move back to All." side="top">
          <button
            type="button"
            onClick={onDeleteFolder}
            className="ml-auto inline-flex h-6 items-center gap-0.5 rounded-full px-1.5 text-[11px] text-destructive transition-colors hover:bg-destructive/10"
            aria-label="Delete folder"
          >
            <X className="h-3 w-3" />
          </button>
        </IconTip>
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

// Rail action row — replaces the previous boxy 4-button row. Each action is an
// icon-only trigger (no border, no fill at rest, subtle hover bg) with a native
// `title` tooltip naming the action. Every dialog (item types, share, new folder)
// still owns its own state machine; we only swap the trigger surface.
function RailActions({
  disabled,
  canManage,
  folders,
  initialFolderId,
  onSaveLogin,
  onSaveTotp,
  onSaveNote,
  onSaveSecret,
  onCreateFolder,
  onShareLookup,
  onShareGrant,
}: {
  disabled: boolean;
  canManage: boolean;
  folders: VaultFolder[];
  initialFolderId: string | null;
  onSaveLogin: VaultViewProps["onSaveLogin"];
  onSaveTotp: VaultViewProps["onSaveTotp"];
  onSaveNote: VaultViewProps["onSaveNote"];
  onSaveSecret: VaultViewProps["onSaveSecret"];
  onCreateFolder: VaultViewProps["onCreateFolder"];
  onShareLookup: VaultViewProps["onShareLookup"];
  onShareGrant: VaultViewProps["onShareGrant"];
}) {
  // Reuse the shared Button (ghost/icon) so the rail matches every other icon control in
  // the app — same hover, focus ring, press-scale, and disabled treatment — rather than a
  // bespoke button. Sized down to h-8 w-8 to stay compact in the rail. The rich tooltip
  // (label + "what it does") is supplied to each dialog via its `tooltip` prop; the button
  // keeps an `aria-label` for screen readers (no native `title=` — that double-fires).
  const iconBtn = (label: string, icon: React.ReactNode) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={disabled}
      aria-label={label}
      className="h-8 w-8 text-muted-foreground hover:text-foreground"
    >
      {icon}
    </Button>
  );
  return (
    <div className="flex items-center gap-1">
      <ItemDialog
        folders={folders}
        initialFolderId={initialFolderId}
        onSubmit={(v, f) => onSaveLogin(v, f)}
        tooltip={{ label: "Add login", hint: "Website, username & password — weak passwords are flagged on this device." }}
        trigger={iconBtn("Add login", <Shield className="h-4 w-4" />)}
      />
      <TotpDialog
        folders={folders}
        initialFolderId={initialFolderId}
        onSubmit={(v, f) => onSaveTotp(v, f)}
        tooltip={{ label: "Add one-time code", hint: "Store a TOTP/2FA seed. Codes are computed locally and never synced." }}
        trigger={iconBtn("Add one-time code", <KeyRound className="h-4 w-4" />)}
      />
      <NoteDialog
        folders={folders}
        initialFolderId={initialFolderId}
        onSubmit={(v, f) => onSaveNote(v, f)}
        tooltip={{ label: "Add secure note", hint: "Free-form encrypted text — recovery codes, license keys, anything." }}
        trigger={iconBtn("Add secure note", <FileText className="h-4 w-4" />)}
      />
      <SecretDialog
        folders={folders}
        initialFolderId={initialFolderId}
        onSubmit={(v, f) => onSaveSecret(v, f)}
        tooltip={{ label: "Add generic secret", hint: "Any key/value — API tokens, SSH keys, environment values." }}
        trigger={iconBtn("Add generic secret", <KeySquare className="h-4 w-4" />)}
      />
      {/* Divider + push the organise/share actions to the right so the four "add" types
          read as one cluster and don't crowd the folder/share controls. */}
      <span className="ml-auto h-5 w-px shrink-0 bg-border/70" />
      <NewFolderDialog
        onCreate={onCreateFolder}
        tooltip={{ label: "New folder", hint: "Group items in this vault. Folder names are encrypted too." }}
        trigger={iconBtn("New folder", <FolderPlus className="h-4 w-4" />)}
      />
      {canManage ? (
        <ShareDialog
          onLookup={onShareLookup}
          onShare={onShareGrant}
          tooltip={{ label: "Share vault", hint: "Grant another arc user access via their public key — end-to-end encrypted." }}
          trigger={iconBtn("Share vault", <UserPlus className="h-4 w-4" />)}
        />
      ) : null}
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
  const typeIcon = totp ? <KeyRound className="h-4 w-4" /> : note ? <FileText className="h-4 w-4" /> : secret ? <KeySquare className="h-4 w-4" /> : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      className={cn(
        "flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2.5 py-2 text-left",
        "transition-colors [transition-duration:var(--dur-fast)]",
        active
          ? "bg-[var(--ds-accent-subtle)] text-[var(--ds-accent-subtle-fg)]"
          : "hover:bg-[var(--surface-hover)]",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border bg-[var(--surface-raised)] font-display text-[14px] font-semibold text-foreground/80">
        {typeIcon ?? title.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-[12px] text-muted-foreground">{sub}</span>
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
      <section className="flex min-h-0 flex-1 items-center justify-center bg-[var(--surface-sunken)] p-10 text-center">
        <div className="max-w-sm space-y-3">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-[var(--radius-lg)] border border-border bg-[var(--surface-raised)] text-muted-foreground">
            <Lock className="h-5 w-5" />
          </span>
          <div className="space-y-1">
            <h3 className="font-display text-base font-semibold">Pick an item</h3>
            <p className="text-sm text-muted-foreground">
              Select something on the left to see its fields. Decryption happens on this device.
            </p>
          </div>
          <div className="flex justify-center">
            <TrustIndicator kind="e2e" />
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[var(--surface-sunken)] md:min-w-0">
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
      {/* Disabled placeholders ("coming next"). The tooltip lives on a focusable span
          wrapper because a disabled button swallows pointer events, so Radix can't see the
          hover on the button itself. */}
      <IconTip label="Share item" hint="Coming soon — share a single item, not the whole vault.">
        <span tabIndex={0} className="inline-flex">
          <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Share item" disabled>
            <Share2 className="h-4 w-4" />
          </Button>
        </span>
      </IconTip>
      <IconTip label="More actions" hint="Coming soon — move, duplicate, and item history.">
        <span tabIndex={0} className="inline-flex">
          <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="More actions" disabled>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </span>
      </IconTip>
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
              <IconTip label="Open website" hint="Opens this URL in a new tab." side="top">
                <a
                  href={url.startsWith("http") ? url : `https://${url}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground"
                  aria-label="Open website in a new tab"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </IconTip>
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
          <TotpField totp={totp} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Computed on this device from the stored seed. Open Edit to rotate the seed.
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

// Live TOTP — recomputes once per second from the stored seed so the displayed code
// matches wall-clock no matter how long the tab was throttled. All derivation is local;
// nothing leaves the device. Mirrors `totp-card.tsx`'s pattern, sized for the detail pane.
function TotpField({ totp }: { totp: TotpData }) {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const periodSec = totp.period ?? 30;
  const safe = React.useMemo(() => {
    try {
      return totpCode(totp.secret, {
        period: totp.period,
        digits: totp.digits,
        algorithm: totp.algorithm,
      });
    } catch (err) {
      return { error: (err as Error).message } as const;
    }
    // tick is intentional — recompute every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totp.secret, totp.period, totp.digits, totp.algorithm, tick]);

  if ("error" in safe) {
    return (
      <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm">
        Invalid TOTP seed: {safe.error}
      </div>
    );
  }

  const grouped =
    safe.code.length === 6 ? `${safe.code.slice(0, 3)} ${safe.code.slice(3)}` : safe.code;
  return (
    <div className="flex items-center gap-4 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-4 py-3">
      <TotpRing code={safe.code} period={periodSec} size={32} showCode={false} />
      <span className="font-mono text-[22px] font-semibold tracking-[0.18em] text-foreground">
        {grouped}
      </span>
      <span className="ml-auto text-[11px] text-muted-foreground">refreshes in {periodSec}s</span>
      <CopyButton value={safe.code} iconOnly autoClearSeconds={20} />
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
// Empty state when a vault is open but holds zero items — replaces the master-detail
// card with a full-width onboarding hero (vault switcher + four type CTAs as cards +
// trust strip). Avoids the "tiny text in a giant void" the master-detail produces when
// there's nothing to list and nothing to detail.
// ────────────────────────────────────────────────────────────────────────────────

function EmptyVaultHero(props: VaultViewProps) {
  const {
    vaults,
    selected,
    selectedVault,
    folders,
    folderFilter,
    onSelectVault,
    onCreateVault,
    onSaveLogin,
    onSaveTotp,
    onSaveNote,
    onSaveSecret,
  } = props;
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 bg-[var(--surface-raised)] px-4 py-3">
        <div className="min-w-[260px] flex-1 sm:max-w-sm">
          <VaultSwitcher
            vaults={vaults}
            selected={selected}
            selectedName={selectedVault?.name ?? selectedVault?.type}
            onSelect={onSelectVault}
            onCreate={onCreateVault}
          />
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">0 items</span>
      </div>
      <div className="mx-auto max-w-[560px] px-6 py-12 text-center sm:py-14">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[var(--radius-lg)] border border-primary/20 bg-primary/10 text-primary">
          <Shield className="h-6 w-6" />
        </span>
        <h2 className="mt-5 font-display text-xl font-semibold tracking-tight sm:text-2xl">
          Your vault is empty
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Add your first secret. Everything you store here is encrypted on this device — only you
          and your authorized devices can decrypt it.
        </p>
        <div className="mt-7 grid gap-2.5 sm:grid-cols-2">
          <ItemDialog
            folders={folders}
            initialFolderId={folderFilter}
            onSubmit={(v, f) => onSaveLogin(v, f)}
            trigger={
              <TypeCardButton
                icon={<Shield className="h-4 w-4" />}
                title="Login"
                description="Website, username, password — with weak-password detection."
              />
            }
          />
          <TotpDialog
            folders={folders}
            initialFolderId={folderFilter}
            onSubmit={(v, f) => onSaveTotp(v, f)}
            trigger={
              <TypeCardButton
                icon={<KeyRound className="h-4 w-4" />}
                title="One-time code"
                description="TOTP / 2FA. Codes are computed on this device from the stored seed."
              />
            }
          />
          <NoteDialog
            folders={folders}
            initialFolderId={folderFilter}
            onSubmit={(v, f) => onSaveNote(v, f)}
            trigger={
              <TypeCardButton
                icon={<FileText className="h-4 w-4" />}
                title="Secure note"
                description="Free-form encrypted text — recovery hints, license keys, anything."
              />
            }
          />
          <SecretDialog
            folders={folders}
            initialFolderId={folderFilter}
            onSubmit={(v, f) => onSaveSecret(v, f)}
            trigger={
              <TypeCardButton
                icon={<KeySquare className="h-4 w-4" />}
                title="Generic secret"
                description="Any key/value pair — API tokens, SSH keys, environment values."
              />
            }
          />
        </div>
        <div className="mt-7 flex justify-center">
          <TrustIndicator kind="zk" />
        </div>
      </div>
    </div>
  );
}

const TypeCardButton = React.forwardRef<
  HTMLButtonElement,
  {
    icon: React.ReactNode;
    title: string;
    description: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ icon, title, description, className, ...rest }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "group flex w-full items-start gap-3 rounded-[var(--radius-md)] border border-border bg-[var(--surface-raised)] p-3.5 text-left transition-colors [transition-duration:var(--dur-fast)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      className,
    )}
    {...rest}
  >
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-primary/10 text-primary ring-1 ring-primary/15 transition-colors group-hover:bg-primary/15">
      {icon}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
        {description}
      </span>
    </span>
  </button>
));
TypeCardButton.displayName = "TypeCardButton";

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

